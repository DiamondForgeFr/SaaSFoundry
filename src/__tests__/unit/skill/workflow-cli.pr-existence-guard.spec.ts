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

// The PR-existence guard blocks `update-status N "In review"` when no open PR
// is found for the ticket. `In Review` without a PR is a board lie: the entry
// condition for that status (per statuses/6-in-review.md) is "Create the PR".
// We codified the rule in the CLI itself because the agent kept moving bundled
// children to In Review even though their PR lives at the delivery-parent level — surfaced
// by the user as "j'ai l'impression du demande souvent de review des ticket
// sans PR associé".

interface SandboxOptions {
  ghExitCode?: number
  natureLabel?: 'internal' | 'user-facing' | 'bundled-pr' | null
  currentStatus?: string
  issueType?: string
}

async function buildSandbox(
  prListPayload: string,
  options: SandboxOptions = {}
): Promise<{
  dir: string
  env: NodeJS.ProcessEnv
  toolLogPath: string
  ghLogPath: string
  cleanup: () => Promise<void>
}> {
  const dir = mkdtempSync(path.join(tmpdir(), 'sf-wfcli-prexist-'))
  const toolDir = path.join(dir, '.claude/skills/sf-tool-github-projects')
  const binDir = path.join(dir, 'bin')
  const toolLogPath = path.join(dir, 'tool-calls.log')
  const ghLogPath = path.join(dir, 'gh-calls.log')
  await mkdir(toolDir, { recursive: true })
  await mkdir(binDir, { recursive: true })

  await writeFile(
    path.join(dir, '.saasfoundry.json'),
    JSON.stringify({
      workflow: {
        tool: 'github-projects',
        projectUrl: 'https://github.com/orgs/FakeOrg/projects/42',
        workingBranch: 'develop'
      }
    })
  )

  // Tool CLI shim — emits a complexity label (so complexity guard never trips)
  // plus an optional nature label (so we can probe the nature × pr-existence
  // interaction). `status` returns the simulated current board status.
  const labels = ['complexity: low']
  if (options.natureLabel) labels.push(`nature:${options.natureLabel}`)
  const labelsBlock = labels.map((l) => `printf '%s\\n' '${l}'`).join('\n    ')
  const currentStatus = options.currentStatus ?? 'AI Testing'

  const toolShim = `#!/bin/bash
printf '%s\\n' "$*" >> '${toolLogPath}'
case "$1" in
  get-labels)
    ${labelsBlock}
    ;;
  list-incomplete-children)
    printf '%s' '[]'
    ;;
  get-parent)
    printf '%s' '{"number":7}'
    ;;
  get-issue-type)
    printf '%s' '{"name":"${options.issueType ?? 'sf-task'}"}'
    ;;
  status)
    printf 'Status: %s\\n' "${currentStatus}"
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

  const exitCode = options.ghExitCode ?? 0
  const escaped = prListPayload.replace(/'/g, "'\\''")
  const ghShim = `#!/bin/bash
printf '%s\\n' "$*" >> '${ghLogPath}'
if [ "$1" = "pr" ] && [ "$2" = "list" ]; then
  if [ "${exitCode}" -ne 0 ]; then
    echo "gh: simulated failure" >&2
    exit ${exitCode}
  fi
  printf '%s' '${escaped}'
  exit 0
fi
if [ \"$1\" = api ]; then
  printf '%s' '{\"data\":{\"repository\":{\"issue\":{\"issueType\":{\"name\":\"${options.issueType ?? 'sf-story'}\"}}}}}'
fi
exit 0
`
  const ghPath = path.join(binDir, 'gh')
  writeFileSync(ghPath, ghShim)
  chmodSync(ghPath, 0o755)

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PWD: dir,
    PATH: `${binDir}:${process.env.PATH ?? ''}`
  }
  return { dir, env, toolLogPath, ghLogPath, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

async function runCli(args: string[], sandbox: { dir: string; env: NodeJS.ProcessEnv }, envOverrides: NodeJS.ProcessEnv = {}) {
  try {
    const { stdout, stderr } = await execFileP(BASH, [CLI, ...args], {
      cwd: sandbox.dir,
      env: { ...sandbox.env, ...envOverrides }
    })
    return { stdout, stderr, code: 0 }
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number }
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: typeof e.code === 'number' ? e.code : 1 }
  }
}

function readLog(logPath: string): string[] {
  try {
    return readFileSync(logPath, 'utf8').split('\n').filter(Boolean)
  } catch {
    return []
  }
}

describe('sf-workflow CLI — PR-existence guard (→ In Review)', () => {
  let sandbox: Awaited<ReturnType<typeof buildSandbox>>

  afterEach(async () => {
    if (sandbox) await sandbox.cleanup()
  })

  it('blocks "In review" when no open PR matches the ticket branch', async () => {
    sandbox = await buildSandbox('[{"number":999,"isDraft":false,"headRefName":"feature/77-other-ticket"}]', { natureLabel: 'internal' })
    const res = await runCli(['update-status', '42', 'In review'], sandbox)
    expect(res.code).toBe(2)
    expect(res.stderr).toContain('has no open PR')
    expect(res.stderr).toContain("cannot transition to 'In Review'")
    expect(res.stderr).toContain('SF_WORKFLOW_BYPASS_PR_EXISTENCE_GUARD=1')
    const toolCalls = readLog(sandbox.toolLogPath).filter((l) => l.startsWith('update-status'))
    expect(toolCalls).toEqual([])
  })

  it('blocks "In review" when the open-PR list is empty', async () => {
    sandbox = await buildSandbox('[]', { natureLabel: 'internal' })
    const res = await runCli(['update-status', '42', 'In review'], sandbox)
    expect(res.code).toBe(2)
    expect(res.stderr).toContain('has no open PR')
  })

  it('allows "In review" when a matching open PR exists (feature/<N>-…)', async () => {
    sandbox = await buildSandbox('[{"number":555,"isDraft":false,"headRefName":"feature/42-add-stuff"}]', { natureLabel: 'internal' })
    const res = await runCli(['update-status', '42', 'In review'], sandbox)
    expect(res.code).toBe(0)
    const toolCalls = readLog(sandbox.toolLogPath).filter((l) => l.startsWith('update-status'))
    expect(toolCalls).toHaveLength(1)
  })

  it('allows "In review" when a matching open PR exists (fix/<N>-…)', async () => {
    sandbox = await buildSandbox('[{"number":556,"isDraft":false,"headRefName":"fix/42-broken"}]', { natureLabel: 'internal' })
    const res = await runCli(['update-status', '42', 'In review'], sandbox)
    expect(res.code).toBe(0)
  })

  it('does not query gh for non-In-Review targets (guard short-circuits)', async () => {
    sandbox = await buildSandbox('[]', { natureLabel: 'internal', currentStatus: 'Backlog' })
    const res = await runCli(['update-status', '42', 'Ready'], sandbox)
    expect(res.code).toBe(0)
    const ghCalls = readLog(sandbox.ghLogPath)
    expect(ghCalls.find((l) => l.startsWith('pr list'))).toBeUndefined()
  })

  it('matches case-insensitively: "in review" is treated as In Review', async () => {
    sandbox = await buildSandbox('[]', { natureLabel: 'internal' })
    const res = await runCli(['update-status', '42', 'in review'], sandbox)
    expect(res.code).toBe(2)
    expect(res.stderr).toContain('has no open PR')
  })

  it('bypasses the guard when SF_WORKFLOW_BYPASS_PR_EXISTENCE_GUARD=1', async () => {
    sandbox = await buildSandbox('[]', { natureLabel: 'internal' })
    const res = await runCli(['update-status', '42', 'In review'], sandbox, { SF_WORKFLOW_BYPASS_PR_EXISTENCE_GUARD: '1' })
    expect(res.code).toBe(0)
    const toolCalls = readLog(sandbox.toolLogPath).filter((l) => l.startsWith('update-status'))
    expect(toolCalls).toHaveLength(1)
  })

  it('fails closed when gh errors (offline / auth issue)', async () => {
    sandbox = await buildSandbox('', { ghExitCode: 1, natureLabel: 'internal' })
    const res = await runCli(['update-status', '42', 'In review'], sandbox)
    expect(res.code).toBe(2)
  })

  it.each([
    ['Human testing', true, 0],
    ['Human testing', false, 2],
    ['In review', true, 2],
    ['In review', false, 0]
  ])('requires the correct PR state for %s (draft=%s)', async (target, draft, code) => {
    sandbox = await buildSandbox(JSON.stringify([{ number: 555, headRefName: 'feature/42-work', isDraft: draft }]), { currentStatus: 'Human testing' })
    const res = await runCli(['update-status', '42', String(target)], sandbox)
    expect(res.code).toBe(code)
  })

  it.each(['[{"number":555,"headRefName":"feature/42-work"}]', '[{"number":555,"headRefName":"feature/42-work","isDraft":false},{"number":556,"headRefName":"fix/42-work","isDraft":false}]', '{}'])(
    'rejects unknown or ambiguous PR state: %s',
    async (payload) => {
      sandbox = await buildSandbox(payload, { currentStatus: 'Human testing' })
      const res = await runCli(['update-status', '42', 'In review'], sandbox)
      expect(res.code).toBe(2)
      expect(readLog(sandbox.toolLogPath).filter((l) => l.startsWith('update-status'))).toEqual([])
    }
  )

  it('keeps PR-less native Epic groupers in their derived lifecycle', async () => {
    sandbox = await buildSandbox('[]', { currentStatus: 'AI testing', issueType: 'sf-epic' })
    const res = await runCli(['update-status', '42', 'Human testing'], sandbox)
    expect(res.code).toBe(2)
    expect(res.stderr).toContain('aggregate Epic #42')
  })

  it('rejects Human Testing even when an Epic has an accidental delivery PR', async () => {
    sandbox = await buildSandbox('[{"number":555,"headRefName":"feature/42-work","isDraft":false}]', { currentStatus: 'AI testing', issueType: 'sf-epic' })
    const res = await runCli(['update-status', '42', 'Human testing'], sandbox)
    expect(res.code).toBe(2)
    expect(res.stderr).toContain('aggregate Epic #42')
  })

  it('does not match a different ticket whose number is a prefix (4 vs 42)', async () => {
    sandbox = await buildSandbox('[{"number":888,"isDraft":false,"headRefName":"feature/420-other"}]', { natureLabel: 'internal' })
    const res = await runCli(['update-status', '42', 'In review'], sandbox)
    expect(res.code).toBe(2)
    expect(res.stderr).toContain('has no open PR')
  })
})

describe('sf-workflow CLI — bundled-PR path (AI Testing → Done)', () => {
  let sandbox: Awaited<ReturnType<typeof buildSandbox>>

  afterEach(async () => {
    if (sandbox) await sandbox.cleanup()
  })

  it('allows AI Testing → Done when ticket carries nature:bundled-pr', async () => {
    sandbox = await buildSandbox('[]', { natureLabel: 'bundled-pr' })
    const res = await runCli(['update-status', '42', 'Done'], sandbox)
    expect(res.code).toBe(0)
    const toolCalls = readLog(sandbox.toolLogPath).filter((l) => l.startsWith('update-status'))
    expect(toolCalls[0]).toBe('update-status 42 Done')
  })

  it('blocks AI Testing → Done when ticket lacks nature:bundled-pr', async () => {
    sandbox = await buildSandbox('[]', { natureLabel: 'internal' })
    const res = await runCli(['update-status', '42', 'Done'], sandbox)
    expect(res.code).toBe(2)
    expect(res.stderr).toContain("lacks 'nature:bundled-pr'")
    expect(res.stderr).toContain("cannot skip 'In Review'")
  })

  it('blocks AI Testing → Done when ticket has no nature label', async () => {
    sandbox = await buildSandbox('[]', { natureLabel: null })
    const res = await runCli(['update-status', '42', 'Done'], sandbox)
    expect(res.code).toBe(2)
    expect(res.stderr).toContain("lacks 'nature:bundled-pr'")
  })

  it('blocks bundled-pr ticket from entering In Review (must go to Done directly)', async () => {
    sandbox = await buildSandbox('[{"number":555,"isDraft":false,"headRefName":"feature/42-stuff"}]', { natureLabel: 'bundled-pr' })
    const res = await runCli(['update-status', '42', 'In review'], sandbox)
    expect(res.code).toBe(2)
    expect(res.stderr).toContain("'nature:bundled-pr'")
    expect(res.stderr).toContain("cannot enter 'In Review'")
  })

  it('requires a verified merged PR for In Review → Done', async () => {
    sandbox = await buildSandbox('[]', { natureLabel: 'internal', currentStatus: 'In Review' })
    const res = await runCli(['update-status', '42', 'Done'], sandbox)
    expect(res.code).toBe(2)
    expect(res.stderr).toContain('no verified merged PR')
    const toolCalls = readLog(sandbox.toolLogPath).filter((l) => l.startsWith('update-status'))
    expect(toolCalls).toEqual([])
  })
})
