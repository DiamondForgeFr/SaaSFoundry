import { execFile } from 'child_process'
import { chmodSync, mkdtempSync, writeFileSync } from 'fs'
import { mkdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { promisify } from 'util'

const execFileP = promisify(execFile)

const REPO_ROOT = path.resolve(__dirname, '../../../..')
const CLI = path.resolve(REPO_ROOT, '.claude/skills/sf-workflow/workflow-cli.sh')
const BASH = '/bin/bash'

const SOLO_STATUSES = [{ name: 'Backlog' }, { name: 'In Progress' }, { name: 'AI Testing' }, { name: 'In Review' }, { name: 'Done' }]
const TEAM_STATUSES = [{ name: 'Backlog' }, { name: 'Ready' }, { name: 'In Progress' }, { name: 'AI Testing' }, { name: 'Human Testing' }, { name: 'In Review' }, { name: 'Done' }]

// #446: the workflow CLI must follow the status sequence declared in
// .saasfoundry.json instead of hardcoding the 7-status team preset — the solo
// preset has 5 statuses and no Human Testing (PR review is the human gate).

async function buildSandbox(options: { statuses: { name: string }[]; ticketStatus: string; labels?: string[] }): Promise<{
  dir: string
  env: NodeJS.ProcessEnv
  cleanup: () => Promise<void>
}> {
  const dir = mkdtempSync(path.join(tmpdir(), 'sf-wfcli-solo-'))
  const toolDir = path.join(dir, '.claude/skills/sf-tool-github-projects')
  await mkdir(toolDir, { recursive: true })

  await writeFile(
    path.join(dir, '.saasfoundry.json'),
    JSON.stringify({
      workflow: {
        tool: 'github-projects',
        projectUrl: 'https://github.com/orgs/FakeOrg/projects/42',
        workingBranch: 'develop',
        statuses: options.statuses
      }
    })
  )

  const labels = ['complexity: low', ...(options.labels ?? [])]
  const toolShim = `#!/bin/bash
case "$1" in
  status)
    printf '%s\\n' '{"ticket":277,"title":"t","state":"OPEN","status":"${options.ticketStatus}","labels":[]}'
    ;;
  get-labels)
    printf '%s\\n' ${labels.map((l) => `"${l}"`).join(' ')}
    ;;
  update-status)
    echo "✓ Ticket #$2 → $3"
    ;;
  *)
    exit 0
    ;;
esac
`
  const toolPath = path.join(toolDir, 'github-projects-cli.sh')
  writeFileSync(toolPath, toolShim)
  chmodSync(toolPath, 0o755)

  // The solo path skips Human Testing but still requires a verified ready PR.
  const binDir = path.join(dir, 'bin')
  await mkdir(binDir, { recursive: true })
  const ghPath = path.join(binDir, 'gh')
  writeFileSync(ghPath, `#!/bin/bash\necho '[{"number":1,"headRefName":"feature/277-work","isDraft":false}]'\n`)
  chmodSync(ghPath, 0o755)
  const env: NodeJS.ProcessEnv = { ...process.env, PWD: dir, PATH: `${binDir}:${process.env.PATH}` }
  return { dir, env, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

describe('workflow-cli with the solo preset (#446)', () => {
  it('next from In Progress follows the solo sequence (AI Testing)', async () => {
    const sandbox = await buildSandbox({ statuses: SOLO_STATUSES, ticketStatus: 'In progress' })
    try {
      const { stdout } = await execFileP(BASH, [CLI, 'next', '277'], { env: sandbox.env, cwd: sandbox.dir })
      expect(stdout).toContain('Next: AI Testing')
    } finally {
      await sandbox.cleanup()
    }
  })

  it('next from AI Testing goes straight to In Review without any nature label', async () => {
    const sandbox = await buildSandbox({ statuses: SOLO_STATUSES, ticketStatus: 'AI testing' })
    try {
      const { stdout } = await execFileP(BASH, [CLI, 'next', '277'], { env: sandbox.env, cwd: sandbox.dir })
      expect(stdout).toContain('Next: In Review')
      expect(stdout).not.toContain('Human Testing')
    } finally {
      await sandbox.cleanup()
    }
  })

  it('nature guard lets AI Testing → In Review pass without nature:internal in solo', async () => {
    const sandbox = await buildSandbox({ statuses: SOLO_STATUSES, ticketStatus: 'AI testing' })
    try {
      const { stdout } = await execFileP(BASH, [CLI, 'update-status', '277', 'In review'], { env: sandbox.env, cwd: sandbox.dir })
      expect(stdout).toContain('✓ Ticket #277 → In review')
    } finally {
      await sandbox.cleanup()
    }
  })

  it('nature guard still blocks bundled-pr subs from entering In Review in solo', async () => {
    const sandbox = await buildSandbox({ statuses: SOLO_STATUSES, ticketStatus: 'AI testing', labels: ['nature:bundled-pr'] })
    try {
      await expect(execFileP(BASH, [CLI, 'update-status', '277', 'In review'], { env: sandbox.env, cwd: sandbox.dir })).rejects.toMatchObject({
        stderr: expect.stringContaining('bundled-pr')
      })
    } finally {
      await sandbox.cleanup()
    }
  })

  it('team preset behaviour is unchanged: AI Testing → In Review still requires nature:internal', async () => {
    const sandbox = await buildSandbox({ statuses: TEAM_STATUSES, ticketStatus: 'AI testing' })
    try {
      await expect(execFileP(BASH, [CLI, 'update-status', '277', 'In review'], { env: sandbox.env, cwd: sandbox.dir })).rejects.toMatchObject({
        stderr: expect.stringContaining('nature:internal')
      })
    } finally {
      await sandbox.cleanup()
    }
  })

  it('next from In Review reaches Done and the cycle ends there', async () => {
    const sandbox = await buildSandbox({ statuses: SOLO_STATUSES, ticketStatus: 'Done' })
    try {
      const { stdout } = await execFileP(BASH, [CLI, 'next', '277'], { env: sandbox.env, cwd: sandbox.dir })
      expect(stdout).toContain('Workflow complete')
    } finally {
      await sandbox.cleanup()
    }
  })

  it('status description lookup resolves by slug, independent of preset numbering', async () => {
    const sandbox = await buildSandbox({ statuses: SOLO_STATUSES, ticketStatus: 'In review' })
    try {
      const { stdout } = await execFileP(BASH, [CLI, 'status', '277'], { env: sandbox.env, cwd: sandbox.dir })
      expect(stdout).toContain('STATUS: In Review')
    } finally {
      await sandbox.cleanup()
    }
  })
})
