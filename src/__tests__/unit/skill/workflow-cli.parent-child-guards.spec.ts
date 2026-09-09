import { execFile } from 'child_process'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { mkdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { promisify } from 'util'

const execFileP = promisify(execFile)
const REPO_ROOT = path.resolve(__dirname, '../../../..')
const CLI = path.resolve(REPO_ROOT, '.claude/skills/sf-workflow/workflow-cli.sh')
const BASH = '/bin/bash'

interface Options {
  childStatuses?: string | null
  childQueryFails?: boolean
  currentStatus?: string
  parentStatus?: string
  nature?: 'bundled-pr' | 'internal'
  parent?: number | null
  parentType?: string
  issueType?: string | null
  merged?: boolean
}

async function sandbox(options: Options = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'sf-parent-child-'))
  const toolDir = path.join(dir, '.claude/skills/sf-tool-github-projects')
  const binDir = path.join(dir, 'bin')
  const log = path.join(dir, 'tool.log')
  await mkdir(toolDir, { recursive: true })
  await mkdir(binDir, { recursive: true })
  await writeFile(path.join(dir, '.saasfoundry.json'), JSON.stringify({ workflow: { tool: 'github-projects', projectUrl: 'https://github.com/orgs/Fake/projects/42', workingBranch: 'develop' } }))

  const labels = ['complexity: low', ...(options.nature ? [`nature:${options.nature}`] : [])]
  const listResponse = options.childStatuses ?? '[]'
  const parent = options.parent === undefined ? null : options.parent
  const tool = `#!/bin/bash
printf '%s\\n' "$*" >> '${log}'
case "$1" in
  get-labels) ${labels.map((label) => `printf '%s\\n' '${label}'`).join('; ')} ;;
  status)
    if [ "$2" = 7 ]; then printf 'Status: %s\\n' '${options.parentStatus ?? 'Backlog'}'; else printf 'Status: %s\\n' '${options.currentStatus ?? 'In Review'}'; fi
    ;;
  list-incomplete-children)
    ${options.childQueryFails ? 'exit 1' : `printf '%s' '${listResponse.replace(/'/g, "'\\''")}'`}
    ;;
  get-parent)
    ${parent === null ? 'exit 1' : `printf '%s' '{"number":${parent}}'`}
    ;;
  get-issue-type)
    if [ "$2" = 7 ]; then
      printf '%s' '{"name":"${options.parentType ?? 'sf-task'}"}'
    elif [ "${options.issueType === null ? 'missing' : 'present'}" = missing ]; then
      exit 1
    else
      printf '%s' '{"name":"${options.issueType ?? 'sf-story'}"}'
    fi
    ;;
  update-status) printf 'updated %s %s\\n' "$2" "$3" ;;
esac
`
  const toolPath = path.join(toolDir, 'github-projects-cli.sh')
  writeFileSync(toolPath, tool)
  chmodSync(toolPath, 0o755)
  const mergedPayload = options.merged ? '[{"number":88,"headRefName":"feature/42-work","baseRefName":"develop","mergedAt":"2026-09-09T10:00:00Z"}]' : '[]'
  const gh = `#!/bin/bash
if [ "$1" = pr ] && [ "$2" = list ]; then
  if [ "$4" = merged ]; then printf '%s' '${mergedPayload}'; else printf '%s' '[]'; fi
fi
`
  const ghPath = path.join(binDir, 'gh')
  writeFileSync(ghPath, gh)
  chmodSync(ghPath, 0o755)
  return { dir, log, env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}` }, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

async function run(s: Awaited<ReturnType<typeof sandbox>>, args: string[]) {
  try {
    const result = await execFileP(BASH, [CLI, ...args], { cwd: s.dir, env: s.env })
    return { ...result, code: 0 }
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number }
    return { stdout: err.stdout ?? '', stderr: err.stderr ?? '', code: err.code ?? 1 }
  }
}

describe('sf-workflow CLI — native parent/child guards and rollup', () => {
  let s: Awaited<ReturnType<typeof sandbox>>
  afterEach(async () => s && s.cleanup())

  it('blocks parent Done and names every child not verified Done', async () => {
    s = await sandbox({ childStatuses: '[{"number":10,"title":"Working child","status":"In progress"},{"number":11,"title":"Unknown child","status":null}]', issueType: 'sf-epic' })
    const result = await run(s, ['update-status', '42', 'Done'])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('#10 Working child: In progress')
    expect(result.stderr).toContain('#11 Unknown child: status unavailable')
    expect(readFileSync(s.log, 'utf8')).not.toContain('update-status 42 Done')
  })

  it('fails closed when child statuses cannot be retrieved', async () => {
    s = await sandbox({ childQueryFails: true, issueType: 'sf-epic' })
    const result = await run(s, ['update-status', '42', 'Done'])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('unable to verify child issue statuses')
  })

  it('allows an aggregate Epic Done without a PR only after every child is Done', async () => {
    s = await sandbox({ issueType: 'sf-epic' })
    expect((await run(s, ['update-status', '42', 'Done'])).code).toBe(0)
  })

  it.each(['AI testing', 'Human testing', 'In review'])('keeps an aggregate Epic out of %s', async (target) => {
    s = await sandbox({ issueType: 'sf-epic' })
    const result = await run(s, ['update-status', '42', target])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('aggregate Epic #42')
  })

  it('rejects pull-request commands for an aggregate Epic', async () => {
    s = await sandbox({ issueType: 'sf-epic' })
    const result = await run(s, ['create-pr', '42'])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('owns no branch or pull request')
  })

  it('requires a normal ticket to have a verified merged PR', async () => {
    s = await sandbox()
    expect((await run(s, ['update-status', '42', 'Done'])).code).toBe(2)
    await s.cleanup()
    s = await sandbox({ merged: true })
    expect((await run(s, ['update-status', '42', 'Done'])).code).toBe(0)
  })

  it('still treats an untyped ticket as a normal delivery ticket', async () => {
    s = await sandbox({ issueType: null, merged: true })
    expect((await run(s, ['update-status', '42', 'Done'])).code).toBe(0)
  })

  it('allows the bundled-pr exception only for a verified child with a delivery parent', async () => {
    s = await sandbox({ nature: 'bundled-pr', currentStatus: 'AI Testing', parent: 7 })
    expect((await run(s, ['update-status', '42', 'Done'])).code).toBe(0)
    await s.cleanup()
    s = await sandbox({ nature: 'bundled-pr', currentStatus: 'AI Testing', parent: null })
    const result = await run(s, ['update-status', '42', 'Done'])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('native child issue')
  })

  it('verifies bundled-pr provenance even when the ticket was moved out of AI Testing manually', async () => {
    s = await sandbox({ nature: 'bundled-pr', currentStatus: 'In Review', parent: null })
    const result = await run(s, ['update-status', '42', 'Done'])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('native child issue')
  })

  it('rejects an aggregate Epic as a bundled-pr delivery parent', async () => {
    s = await sandbox({ nature: 'bundled-pr', currentStatus: 'AI Testing', parent: 7, parentType: 'sf-epic' })
    const result = await run(s, ['update-status', '42', 'Done'])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('aggregate sf-epic')
  })

  it('rolls a verified Epic parent through Ready then In progress', async () => {
    s = await sandbox({ currentStatus: 'In Progress', parent: 7, parentType: 'sf-epic', parentStatus: 'Backlog' })
    const result = await run(s, ['update-status', '42', 'In progress'])
    expect(result.code).toBe(0)
    const calls = readFileSync(s.log, 'utf8')
    expect(calls).toContain('update-status 7 Ready')
    expect(calls).toContain('update-status 7 In progress')
    expect(result.stdout).toContain('Derived rollup: Epic #7 → Ready')
  })

  it('rolls a verified Epic parent to Done after the last child reaches Done', async () => {
    s = await sandbox({ currentStatus: 'In Review', parent: 7, parentType: 'sf-epic', parentStatus: 'In progress', merged: true })
    const result = await run(s, ['update-status', '42', 'Done'])
    expect(result.code).toBe(0)
    const calls = readFileSync(s.log, 'utf8')
    expect(calls).toContain('update-status 42 Done')
    expect(calls).toContain('update-status 7 Done')
    expect(result.stdout).toContain('Derived rollup: Epic #7 → Done')
  })
})
