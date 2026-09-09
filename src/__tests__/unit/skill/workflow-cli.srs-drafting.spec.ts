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

// Builds a sandbox project where:
//   - .saasfoundry.json selects the github-projects backend
//   - .claude/skills/sf-tool-github-projects/github-projects-cli.sh is a fake
//     shim controlled by env vars (FAKE_LABELS, FAKE_BOARD_STATUS) so the test
//     can script any label/status combination without touching the real CLI
//   - .claude/skills/sf-srs/scripts/srs-cli.sh records each invocation into a
//     log so the test can assert dispatch happened with the right args
async function buildSandbox(): Promise<{
  dir: string
  env: NodeJS.ProcessEnv
  srsLogPath: string
  toolLogPath: string
  cleanup: () => Promise<void>
}> {
  const dir = mkdtempSync(path.join(tmpdir(), 'sf-wfcli-srs-'))
  const toolDir = path.join(dir, '.claude/skills/sf-tool-github-projects')
  const srsDir = path.join(dir, '.claude/skills/sf-srs/scripts')
  const srsLogPath = path.join(dir, 'srs-calls.log')
  const toolLogPath = path.join(dir, 'tool-calls.log')
  await mkdir(toolDir, { recursive: true })
  await mkdir(srsDir, { recursive: true })

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

  // Fake github-projects CLI. `get-labels` emits $FAKE_LABELS (newline-
  // separated) verbatim, or exits 1 when $FAKE_LABELS_ERROR=1 (simulates
  // offline / auth failure so we can assert the SRS guard fails open on
  // non-zero exit from the label-fetch path). `status` emits
  // "Status: $FAKE_BOARD_STATUS". `update-status` echoes the canonical
  // success line the real CLI prints. Every invocation is appended to
  // $toolLogPath for assertions.
  const toolShim = `#!/bin/bash
printf '%s\\n' "$*" >> '${toolLogPath}'
case "$1" in
  get-labels)
    if [ "\${FAKE_LABELS_ERROR:-}" = "1" ]; then
      echo "fake-tool-cli: simulated get-labels failure" >&2
      exit 1
    fi
    if [ -n "\${FAKE_LABELS:-}" ]; then
      printf '%s\\n' "\${FAKE_LABELS}"
    fi
    ;;
  list-incomplete-children)
    printf '%s' '[]'
    ;;
  status)
    echo "Status: \${FAKE_BOARD_STATUS:-In progress}"
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

  // Fake SRS CLI — logs the action + ticket, returns 0 so the workflow CLI
  // proceeds to its own post-dispatch output.
  const srsShim = `#!/bin/bash
printf '%s\\n' "$*" >> '${srsLogPath}'
echo "srs-cli: $*"
`
  const srsPath = path.join(srsDir, 'srs-cli.sh')
  writeFileSync(srsPath, srsShim)
  chmodSync(srsPath, 0o755)

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PWD: dir
  }

  return {
    dir,
    env,
    srsLogPath,
    toolLogPath,
    cleanup: () => rm(dir, { recursive: true, force: true })
  }
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

describe('sf-workflow CLI — SRS drafting lifecycle', () => {
  let sandbox: Awaited<ReturnType<typeof buildSandbox>>

  beforeEach(async () => {
    sandbox = await buildSandbox()
  })

  afterEach(async () => {
    await sandbox.cleanup()
  })

  describe('update-status guard', () => {
    it('blocks "AI testing" when ticket carries srs:drafting', async () => {
      const res = await runCli(['update-status', '42', 'AI testing'], sandbox, { FAKE_LABELS: 'srs:drafting\nbug' })
      expect(res.code).toBe(2)
      expect(res.stderr).toContain("'srs:drafting'")
      expect(res.stderr).toContain('transition-drafting')
      // update-status must NOT be routed to the tool CLI when the guard trips
      const toolCalls = readLog(sandbox.toolLogPath).filter((l) => l.startsWith('update-status'))
      expect(toolCalls).toEqual([])
    })

    it('blocks "Human testing" when ticket carries srs:update', async () => {
      const res = await runCli(['update-status', '42', 'Human testing'], sandbox, { FAKE_LABELS: 'srs:update' })
      expect(res.code).toBe(2)
      expect(res.stderr).toContain("'srs:update'")
    })

    it('blocks "In review" when ticket carries srs:new', async () => {
      const res = await runCli(['update-status', '42', 'In review'], sandbox, { FAKE_LABELS: 'srs:new' })
      expect(res.code).toBe(2)
      expect(res.stderr).toContain("'srs:new'")
    })

    it('allows "AI testing" when the ticket has no srs:* label', async () => {
      const res = await runCli(['update-status', '42', 'AI testing'], sandbox, { FAKE_LABELS: 'bug\ncomplexity: low' })
      expect(res.code).toBe(0)
      const toolCalls = readLog(sandbox.toolLogPath).filter((l) => l.startsWith('update-status'))
      expect(toolCalls).toHaveLength(1)
    })

    it('allows "In progress" even when srs:drafting is set (drafting lifecycle entry)', async () => {
      const res = await runCli(['update-status', '42', 'In progress'], sandbox, { FAKE_LABELS: 'srs:drafting\ncomplexity: low' })
      expect(res.code).toBe(0)
    })

    it('allows "Done" even when srs:drafting is set (drafting lifecycle exit)', async () => {
      const res = await runCli(['update-status', '42', 'Done'], sandbox, { FAKE_LABELS: 'srs:drafting\ncomplexity: low' })
      expect(res.code).toBe(0)
    })

    it('bypasses the guard when SF_WORKFLOW_BYPASS_SRS_GUARD=1', async () => {
      const res = await runCli(['update-status', '42', 'AI testing'], sandbox, {
        FAKE_LABELS: 'srs:drafting\ncomplexity: low',
        SF_WORKFLOW_BYPASS_SRS_GUARD: '1'
      })
      expect(res.code).toBe(0)
      const toolCalls = readLog(sandbox.toolLogPath).filter((l) => l.startsWith('update-status'))
      expect(toolCalls).toHaveLength(1)
    })

    it('is case-insensitive on the target status', async () => {
      const res = await runCli(['update-status', '42', 'ai testing'], sandbox, { FAKE_LABELS: 'srs:drafting' })
      expect(res.code).toBe(2)
    })

    it('trims leading/trailing whitespace on the target status', async () => {
      // Copy-paste from boards often sneaks in padding — the guard must still trip.
      const res = await runCli(['update-status', '42', '  AI testing  '], sandbox, { FAKE_LABELS: 'srs:drafting' })
      expect(res.code).toBe(2)
      expect(res.stderr).toContain("'srs:drafting'")
    })

    it('fails open when the tool CLI errors on get-labels (offline / auth issue)', async () => {
      // Honoured contract: a broken label-fetch must not block normal teams. The
      // guard passes through and the update-status dispatch succeeds.
      const res = await runCli(['update-status', '42', 'AI testing'], sandbox, {
        FAKE_LABELS_ERROR: '1'
      })
      expect(res.code).toBe(0)
      const toolCalls = readLog(sandbox.toolLogPath).filter((l) => l.startsWith('update-status'))
      expect(toolCalls).toHaveLength(1)
    })
  })

  describe('transition-drafting', () => {
    it('rejects a ticket with no srs:* label', async () => {
      const res = await runCli(['transition-drafting', '42', 'ai-draft'], sandbox, { FAKE_LABELS: 'bug' })
      expect(res.code).toBe(2)
      expect(res.stderr).toContain('no srs:* label')
    })

    it('rejects an unknown phase', async () => {
      const res = await runCli(['transition-drafting', '42', 'wibble'], sandbox, { FAKE_LABELS: 'srs:drafting' })
      expect(res.code).toBe(1)
      expect(res.stderr).toContain("Unknown phase 'wibble'")
    })

    it('ai-draft dispatches to srs-cli.sh with --ticket', async () => {
      const res = await runCli(['transition-drafting', '42', 'ai-draft'], sandbox, {
        FAKE_LABELS: 'srs:drafting',
        FAKE_BOARD_STATUS: 'In progress'
      })
      expect(res.code).toBe(0)
      const srsCalls = readLog(sandbox.srsLogPath)
      expect(srsCalls).toEqual(['draft --ticket 42'])
    })

    it('spawning dispatches to srs-cli.sh spawn', async () => {
      const res = await runCli(['transition-drafting', '42', 'spawning'], sandbox, {
        FAKE_LABELS: 'srs:drafting',
        FAKE_BOARD_STATUS: 'In progress'
      })
      expect(res.code).toBe(0)
      const srsCalls = readLog(sandbox.srsLogPath)
      expect(srsCalls).toEqual(['spawn --ticket 42'])
    })

    it('human-review is human-only (no srs-cli dispatch)', async () => {
      const res = await runCli(['transition-drafting', '42', 'human-review'], sandbox, {
        FAKE_LABELS: 'srs:drafting',
        FAKE_BOARD_STATUS: 'In progress'
      })
      expect(res.code).toBe(0)
      expect(res.stdout).toContain('Human review phase')
      const srsCalls = readLog(sandbox.srsLogPath)
      expect(srsCalls).toEqual([])
    })

    it('done routes update-status Done with the guard bypassed', async () => {
      const res = await runCli(['transition-drafting', '42', 'done'], sandbox, {
        FAKE_LABELS: 'srs:drafting',
        FAKE_BOARD_STATUS: 'In progress'
      })
      expect(res.code).toBe(0)
      const toolCalls = readLog(sandbox.toolLogPath).filter((l) => l.startsWith('update-status'))
      expect(toolCalls).toEqual(['update-status 42 Done'])
    })

    it('rejects ai-draft when board status is not "In progress"', async () => {
      const res = await runCli(['transition-drafting', '42', 'ai-draft'], sandbox, {
        FAKE_LABELS: 'srs:drafting',
        FAKE_BOARD_STATUS: 'Backlog'
      })
      expect(res.code).toBe(2)
      expect(res.stderr).toContain("must be in 'In progress'")
    })

    it('accepts done when board is already Done (idempotent re-run)', async () => {
      const res = await runCli(['transition-drafting', '42', 'done'], sandbox, {
        FAKE_LABELS: 'srs:drafting',
        FAKE_BOARD_STATUS: 'Done'
      })
      expect(res.code).toBe(0)
    })

    it('rejects done when board is not In progress / Done (e.g. Backlog)', async () => {
      // Previously accepted — now rejected so operator mistakes (wrong phase,
      // forgot to move to In progress) surface loudly instead of short-circuiting
      // the drafting arc.
      const res = await runCli(['transition-drafting', '42', 'done'], sandbox, {
        FAKE_LABELS: 'srs:drafting',
        FAKE_BOARD_STATUS: 'Backlog'
      })
      expect(res.code).toBe(2)
      expect(res.stderr).toContain("must be in 'In progress'")
    })

    it('reports a friendly error when srs-cli.sh is missing', async () => {
      // Simulate an install gap by removing the fake srs-cli shim — the
      // workflow CLI should refuse to dispatch instead of crashing with
      // "No such file or directory".
      chmodSync(path.join(sandbox.dir, '.claude/skills/sf-srs/scripts/srs-cli.sh'), 0o644)
      const res = await runCli(['transition-drafting', '42', 'ai-draft'], sandbox, {
        FAKE_LABELS: 'srs:drafting',
        FAKE_BOARD_STATUS: 'In progress'
      })
      expect(res.code).toBe(2)
      expect(res.stderr).toContain('srs-cli.sh')
      expect(res.stderr).toContain('executable')
    })
  })
})
