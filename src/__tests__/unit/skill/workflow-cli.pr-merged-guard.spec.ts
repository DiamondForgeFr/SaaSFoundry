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

// The PR-merged guard blocks `update-status N Done` while an open PR exists for
// the ticket — the rule is "Done means merged to develop, not reviewer
// approval". We codified this in the workflow itself (not just in memory)
// because the agent kept skipping `In review` and going straight to Done after
// a human said "I approve" — see feedback_done_only_after_merge.md.

async function buildSandbox(
  prListPayload: string,
  options: { ghExitCode?: number; mergedPrListPayload?: string } = {}
): Promise<{
  dir: string
  env: NodeJS.ProcessEnv
  toolLogPath: string
  ghLogPath: string
  cleanup: () => Promise<void>
}> {
  const dir = mkdtempSync(path.join(tmpdir(), 'sf-wfcli-prmerged-'))
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

  // Tool CLI shim: returns a `complexity: low` label so the complexity guard
  // never trips during these tests (we want to isolate the PR-merged guard).
  const toolShim = `#!/bin/bash
printf '%s\\n' "$*" >> '${toolLogPath}'
case "$1" in
  get-labels)
    printf '%s\\n' "complexity: low"
    ;;
  list-incomplete-children)
    printf '%s' '[]'
    ;;
  get-issue-type)
    printf '%s' '{"name":"sf-story"}'
    ;;
  update-status)
    echo "✓ Ticket #$2 → $3"
    ;;
  *)
    echo "fake-tool-cli: unhandled $*" >&2
    exit 0
    ;;
esac
`
  const toolPath = path.join(toolDir, 'github-projects-cli.sh')
  writeFileSync(toolPath, toolShim)
  chmodSync(toolPath, 0o755)

  // gh shim: only the `pr list --state open --json …` invocation matters here.
  // We log every call so tests can assert on it, and emit the payload supplied
  // by the test (or simulate a fetch failure when ghExitCode > 0).
  const exitCode = options.ghExitCode ?? 0
  const escaped = prListPayload.replace(/'/g, "'\\''")
  const mergedEscaped = (options.mergedPrListPayload ?? '[]').replace(/'/g, "'\\''")
  const ghShim = `#!/bin/bash
printf '%s\\n' "$*" >> '${ghLogPath}'
if [ "$1" = "pr" ] && [ "$2" = "list" ]; then
  if [ "${exitCode}" -ne 0 ]; then
    echo "gh: simulated failure" >&2
    exit ${exitCode}
  fi
  if [ "$4" = "merged" ]; then
    printf '%s' '${mergedEscaped}'
  else
    printf '%s' '${escaped}'
  fi
  exit 0
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

async function runCli(args: string[], sandbox: { dir: string; env: NodeJS.ProcessEnv }, envOverrides: NodeJS.ProcessEnv = {}): Promise<{ stdout: string; stderr: string; code: number }> {
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

describe('sf-workflow CLI — PR-merged guard', () => {
  let sandbox: Awaited<ReturnType<typeof buildSandbox>>

  afterEach(async () => {
    if (sandbox) await sandbox.cleanup()
  })

  it('blocks "Done" when an open PR exists for the ticket (feature/<N>-…)', async () => {
    sandbox = await buildSandbox('[{"number":333,"headRefName":"feature/42-do-the-thing"}]')
    const res = await runCli(['update-status', '42', 'Done'], sandbox)
    expect(res.code).toBe(2)
    expect(res.stderr).toContain('open PR (#333)')
    expect(res.stderr).toContain("cannot transition to 'Done'")
    expect(res.stderr).toContain('SF_WORKFLOW_BYPASS_PR_MERGED_GUARD=1')
    const toolCalls = readLog(sandbox.toolLogPath).filter((l) => l.startsWith('update-status'))
    expect(toolCalls).toEqual([])
  })

  it('blocks "Done" when an open PR exists on a fix/<N>-… branch', async () => {
    sandbox = await buildSandbox('[{"number":410,"headRefName":"fix/42-broken-link"}]')
    const res = await runCli(['update-status', '42', 'Done'], sandbox)
    expect(res.code).toBe(2)
    expect(res.stderr).toContain('open PR (#410)')
  })

  it('blocks "Done" when the ticket has no open or verified merged PR', async () => {
    sandbox = await buildSandbox('[{"number":999,"headRefName":"feature/77-other-ticket"}]')
    const res = await runCli(['update-status', '42', 'Done'], sandbox)
    expect(res.code).toBe(2)
    expect(res.stderr).toContain('no verified merged PR')
    const toolCalls = readLog(sandbox.toolLogPath).filter((l) => l.startsWith('update-status'))
    expect(toolCalls).toEqual([])
  })

  it('allows "Done" only for a matching PR verified merged into develop', async () => {
    sandbox = await buildSandbox('[]', { mergedPrListPayload: '[{"number":333,"headRefName":"feature/42-do-the-thing","baseRefName":"develop","mergedAt":"2026-09-09T10:00:00Z"}]' })
    const res = await runCli(['update-status', '42', 'Done'], sandbox)
    expect(res.code).toBe(0)
    const toolCalls = readLog(sandbox.toolLogPath).filter((l) => l.startsWith('update-status'))
    expect(toolCalls).toHaveLength(1)
  })

  it('does not query gh for non-Done / non-In-Review targets (guard short-circuits)', async () => {
    sandbox = await buildSandbox('[{"number":333,"headRefName":"feature/42-do-the-thing"}]')
    const res = await runCli(['update-status', '42', 'Ready'], sandbox)
    expect(res.code).toBe(0)
    const ghCalls = readLog(sandbox.ghLogPath)
    expect(ghCalls.find((l) => l.startsWith('pr list'))).toBeUndefined()
  })

  it('matches case-insensitively: "done" is treated as Done', async () => {
    sandbox = await buildSandbox('[{"number":333,"headRefName":"feature/42-do-the-thing"}]')
    const res = await runCli(['update-status', '42', 'done'], sandbox)
    expect(res.code).toBe(2)
    expect(res.stderr).toContain('open PR (#333)')
  })

  it('bypasses the guard when SF_WORKFLOW_BYPASS_PR_MERGED_GUARD=1', async () => {
    sandbox = await buildSandbox('[{"number":333,"headRefName":"feature/42-do-the-thing"}]')
    const res = await runCli(['update-status', '42', 'Done'], sandbox, { SF_WORKFLOW_BYPASS_PR_MERGED_GUARD: '1' })
    expect(res.code).toBe(0)
    const toolCalls = readLog(sandbox.toolLogPath).filter((l) => l.startsWith('update-status'))
    expect(toolCalls).toHaveLength(1)
  })

  it('fails closed when PR verification errors', async () => {
    sandbox = await buildSandbox('', { ghExitCode: 1 })
    const res = await runCli(['update-status', '42', 'Done'], sandbox)
    expect(res.code).toBe(2)
    const toolCalls = readLog(sandbox.toolLogPath).filter((l) => l.startsWith('update-status'))
    expect(toolCalls).toEqual([])
  })

  it('does not match a different ticket number that happens to be a prefix (ticket 4 vs 42)', async () => {
    // headRefName "feature/420-foo" must NOT count as the open PR for ticket 42:
    // the regex anchors on `^(feature|fix)/<N>(-|$)` so 42 only matches `feature/42-…` or `feature/42`.
    sandbox = await buildSandbox('[{"number":888,"headRefName":"feature/420-other"}]', {
      mergedPrListPayload: '[{"number":333,"headRefName":"feature/42-done","baseRefName":"develop","mergedAt":"2026-09-09T10:00:00Z"}]'
    })
    const res = await runCli(['update-status', '42', 'Done'], sandbox)
    expect(res.code).toBe(0)
    const toolCalls = readLog(sandbox.toolLogPath).filter((l) => l.startsWith('update-status'))
    expect(toolCalls).toHaveLength(1)
  })
})
