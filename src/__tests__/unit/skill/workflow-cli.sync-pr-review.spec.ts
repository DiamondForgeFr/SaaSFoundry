import { execFile } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const CLI = path.resolve(__dirname, '../../../../.claude/skills/sf-workflow/workflow-cli.sh')
const repo = 'FakeOrg/FakeRepo'
const head = 'a'.repeat(40)
const base = 'b'.repeat(40)
const event = {
  action: 'ready_for_review',
  number: 100,
  repository: { full_name: repo },
  pull_request: {
    number: 100,
    state: 'open',
    draft: false,
    head: { ref: 'feature/42-work', sha: head, repo: { full_name: repo } },
    base: { ref: 'develop', sha: base, repo: { full_name: repo } }
  }
}
const live = {
  number: 100,
  url: `https://github.com/${repo}/pull/100`,
  state: 'OPEN',
  isDraft: false,
  headRefName: 'feature/42-work',
  headRefOid: head,
  baseRefName: 'develop',
  baseRefOid: base,
  headRepository: { name: 'FakeRepo' },
  headRepositoryOwner: { login: 'FakeOrg' },
  isCrossRepository: false,
  closingIssuesReferences: [{ number: 42, url: `https://github.com/${repo}/issues/42` }]
}

describe('workflow sync-pr-review (#658)', () => {
  let dir: string
  let env: NodeJS.ProcessEnv
  let log: string
  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'sf-sync-review-'))
    await mkdir(path.join(dir, 'bin'))
    await mkdir(path.join(dir, '.claude/skills/sf-tool-github-projects'), { recursive: true })
    await writeFile(path.join(dir, '.saasfoundry.json'), JSON.stringify({ workflow: { tool: 'github-projects', workingBranch: 'develop' } }))
    await writeFile(path.join(dir, 'event.json'), JSON.stringify(event))
    log = path.join(dir, 'calls')
    const gh = `#!/bin/bash
printf 'gh %s\\n' "$*" >> "$CALLS"
case "$1 $2" in
  'pr view') [ "$FETCH_FAIL" = 1 ] && exit 1; printf '%s' "$LIVE";;
  'pr list') printf '%s' "$LIVE" | jq '[{number,headRefName,isDraft}]';;
  *) echo 'unexpected gh request' >&2; exit 1;;
esac
`
    const tool = `#!/bin/bash
printf 'tool %s\\n' "$*" >> "$CALLS"
case "$1" in
  status) jq -n --arg status "$STATUS" '{status: $status}';;
  get-labels) [ "$LABEL_FAIL" = 1 ] && exit 1; printf '%s\\n' "$LABELS";;
  update-status) echo "Ticket #$2 → $3";;
  *) exit 1;;
esac
`
    for (const [name, content] of [
      ['bin/gh', gh],
      ['.claude/skills/sf-tool-github-projects/github-projects-cli.sh', tool]
    ]) {
      const file = path.join(dir, name)
      writeFileSync(file, content)
      chmodSync(file, 0o755)
    }
    env = {
      ...process.env,
      PATH: `${path.join(dir, 'bin')}:${process.env.PATH}`,
      CALLS: log,
      GITHUB_REPOSITORY: repo,
      GITHUB_EVENT_PATH: path.join(dir, 'event.json'),
      LIVE: JSON.stringify(live),
      STATUS: 'Human testing',
      LABELS: 'complexity: medium'
    }
  })
  afterEach(async () => rm(dir, { recursive: true, force: true }))
  async function run(changes: NodeJS.ProcessEnv = {}) {
    try {
      const result = await exec('/bin/bash', [CLI, 'sync-pr-review', '100'], { cwd: dir, env: { ...env, ...changes } })
      return { code: 0, ...result }
    } catch (error) {
      return error as { code: number; stdout: string; stderr: string }
    }
  }
  function calls() {
    try {
      return readFileSync(log, 'utf8')
    } catch {
      return ''
    }
  }
  const changedTicket = () => calls().includes('tool update-status')

  it('moves only the branch ticket through existing guarded update-status', async () => {
    expect((await run()).code).toBe(0)
    expect(calls()).toContain(`gh pr view 100 --repo ${repo}`)
    expect(calls()).toContain('tool update-status 42 In review')
    expect(calls()).not.toContain('graphql')
  })
  it.each(['In review', 'Done'])('is idempotent when ticket is %s', async (status) => {
    expect((await run({ STATUS: status })).code).toBe(0)
    expect(changedTicket()).toBe(false)
  })
  it.each(['Backlog', 'Ready', 'In progress', ''])('does not skip stages from %s', async (status) => {
    expect((await run({ STATUS: status })).code).toBe(2)
    expect(changedTicket()).toBe(false)
  })
  it('allows internal AI testing directly', async () => {
    expect((await run({ STATUS: 'AI testing', LABELS: 'complexity: low\nnature:internal' })).code).toBe(0)
    expect(changedTicket()).toBe(true)
  })
  it('requires human validation for user-facing AI testing despite bypass flags', async () => {
    expect((await run({ STATUS: 'AI testing', SF_WORKFLOW_BYPASS_NATURE_GUARD: '1' })).code).toBe(2)
    expect(changedTicket()).toBe(false)
  })
  it('supports solo workflows without Human testing', async () => {
    await writeFile(path.join(dir, '.saasfoundry.json'), JSON.stringify({ workflow: { tool: 'github-projects', workingBranch: 'develop', statuses: [{ name: 'AI testing' }, { name: 'In review' }] } }))
    expect((await run({ STATUS: 'AI testing' })).code).toBe(0)
    expect(changedTicket()).toBe(true)
  })
  it.each([{ isDraft: true }, { state: 'MERGED' }, { baseRefName: 'master' }, { headRefName: 'feature/43-other' }])('ignores stale events after PR changed: %j', async (change) => {
    const result = await run({ LIVE: JSON.stringify({ ...live, ...change }) })
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('Skipped stale')
    expect(changedTicket()).toBe(false)
  })
  it.each([{ headRefOid: 'c'.repeat(40) }, { baseRefOid: 'd'.repeat(40) }])('synchronizes after ordinary commit advancement: %j', async (change) => {
    expect((await run({ LIVE: JSON.stringify({ ...live, ...change }) })).code).toBe(0)
    expect(changedTicket()).toBe(true)
  })
  it.each([
    { FETCH_FAIL: '1' },
    { LIVE: '{}' },
    { LIVE: JSON.stringify({ ...live, isDraft: null }) },
    { LIVE: JSON.stringify({ ...live, closingIssuesReferences: [] }) },
    { LIVE: JSON.stringify({ ...live, closingIssuesReferences: [{ number: 43, url: `https://github.com/${repo}/issues/43` }] }) },
    { LIVE: JSON.stringify({ ...live, closingIssuesReferences: [{ number: 42, url: 'https://github.com/Other/Repo/issues/42' }] }) },
    { LABEL_FAIL: '1' },
    { LABELS: 'complexity: low\nnature:bundled-pr' },
    { LABELS: 'complexity: low\nsrs:drafting' },
    { LABELS: '' }
  ])('fails safely on unavailable or untrusted state %j', async (change) => {
    expect((await run(change)).code).toBe(2)
    expect(changedTicket()).toBe(false)
  })
  it.each([{ action: 'opened' }, { number: 101 }, { repository: { full_name: 'Other/Repo' } }])('rejects wrong event envelope %j', async (change) => {
    await writeFile(path.join(dir, 'event.json'), JSON.stringify({ ...event, ...change }))
    expect((await run()).code).toBe(2)
    expect(changedTicket()).toBe(false)
  })
  it('rejects fork event data before any GitHub call', async () => {
    await writeFile(path.join(dir, 'event.json'), JSON.stringify({ ...event, pull_request: { ...event.pull_request, head: { ...event.pull_request.head, repo: { full_name: 'Attacker/Repo' } } } }))
    expect((await run()).code).toBe(2)
    expect(calls()).toBe('')
  })
  it('honors literal custom branch conventions without treating punctuation as regex', async () => {
    const branch = 'task.v1/42_work'
    await writeFile(
      path.join(dir, '.saasfoundry.json'),
      JSON.stringify({
        workflow: {
          tool: 'github-projects',
          workingBranch: 'develop',
          branchNaming: { feature: 'task.v1/{N}_{description}', fix: 'bug/{N}-{description}' }
        }
      })
    )
    await writeFile(path.join(dir, 'event.json'), JSON.stringify({ ...event, pull_request: { ...event.pull_request, head: { ...event.pull_request.head, ref: branch } } }))
    expect((await run({ LIVE: JSON.stringify({ ...live, headRefName: branch }) })).code).toBe(0)
    expect(changedTicket()).toBe(true)
  })
  it('never trusts executable PR text to choose another ticket', async () => {
    const result = await run({ LIVE: JSON.stringify({ ...live, body: 'Resolves #99\n$(touch /tmp/unsafe-sync)', title: '#99' }) })
    expect(result.code).toBe(0)
    expect(calls()).toContain('tool update-status 42 In review')
    expect(calls()).not.toContain('99')
  })
})
