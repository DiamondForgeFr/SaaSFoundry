import { execFile } from 'node:child_process'
import { chmodSync, mkdtempSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

// Regression guard for #435: `cmd_create_pr` detected success by grepping the
// captured `gh pr create` output for "http" — but gh error messages routinely
// contain URLs (compare links, doc links), and under `set -e` a failing
// command substitution killed the script before the check, swallowing the
// error entirely (observed live on #424: exit masked, no PR, no message).
// The contract pinned here: success = gh exit 0 AND a real `/pull/<n>` URL;
// anything else must exit non-zero AND surface gh's output.
const CLI = path.resolve(__dirname, '../../../../.claude/skills/sf-tool-github-projects/github-projects-cli.sh')
const BASH = '/bin/bash'

async function buildSandbox(): Promise<{ dir: string; env: NodeJS.ProcessEnv; cleanup: () => Promise<void> }> {
  const dir = mkdtempSync(path.join(tmpdir(), 'sf-gh-create-pr-'))
  const binDir = path.join(dir, 'bin')
  await mkdir(binDir, { recursive: true })

  await writeFile(
    path.join(dir, '.saasfoundry.json'),
    JSON.stringify({
      workflow: { projectUrl: 'https://github.com/orgs/FakeOrg/projects/42', workingBranch: 'develop' }
    })
  )

  // gh shim — `issue view` returns a title; `pr create` behavior is driven by
  // GH_PR_CREATE_MODE (ok | ok-no-url | fail-with-url).
  const ghShim = `#!/bin/bash
case "$1" in
  issue)
    echo "Sample ticket title"
    ;;
  pr)
    if [ "$2" = "list" ]; then echo '[]'; exit 0; fi
    case "$GH_PR_CREATE_MODE" in
      ok)
        echo "https://github.com/FakeOrg/FakeRepo/pull/123"
        exit 0
        ;;
      ok-no-url)
        echo "warning: something unexpected, no PR url printed"
        exit 0
        ;;
      *)
        echo "pull request create failed: GraphQL: was submitted too quickly"
        echo "see https://docs.github.com/en/rest/pulls for more information"
        exit 1
        ;;
    esac
    ;;
  *)
    echo "unexpected gh call: $*" >&2
    exit 1
    ;;
esac
`
  // git shim — `push` behavior is driven by GIT_PUSH_MODE (ok | fail | silent-noop),
  // and `ls-remote` by GIT_REMOTE_HEAD. `silent-noop` is the shape #603 kept producing:
  // exit 0 with nothing sent, which is indistinguishable from success by exit code alone.
  const gitShim = `#!/bin/bash
case "$1" in
  rev-parse)
    if [ "$2" = "HEAD" ]; then echo "\${GIT_LOCAL_HEAD:-abc123}"; else echo "fix/999-sandbox"; fi
    ;;
  push)
    case "\$GIT_PUSH_MODE" in
      fail)
        echo "Connection reset by peer" >&2
        echo "error: failed to push some refs to 'github.com:FakeOrg/FakeRepo.git'" >&2
        exit 1
        ;;
      *) exit 0 ;;
    esac
    ;;
  ls-remote)
    if [ -n "\$GIT_REMOTE_HEAD" ]; then printf '%s\\trefs/heads/fix/999-sandbox\\n' "\$GIT_REMOTE_HEAD"; fi
    ;;
  *) exit 0 ;;
esac
`
  await writeFile(path.join(binDir, 'gh'), ghShim)
  await writeFile(path.join(binDir, 'git'), gitShim)
  chmodSync(path.join(binDir, 'gh'), 0o755)
  chmodSync(path.join(binDir, 'git'), 0o755)

  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}` }
  return { dir, env, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

async function runCreatePr(env: NodeJS.ProcessEnv, cwd: string): Promise<{ code: number; output: string }> {
  // Default the sandbox to a push that landed, so each test states only what it is about.
  const withPushedBranch = { GIT_LOCAL_HEAD: 'abc123', GIT_REMOTE_HEAD: 'abc123', ...env }
  try {
    const { stdout, stderr } = await execFileP(BASH, [CLI, 'create-pr', '999'], { env: withPushedBranch, cwd })
    return { code: 0, output: `${stdout}\n${stderr}` }
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string }
    return { code: e.code ?? 1, output: `${e.stdout ?? ''}\n${e.stderr ?? ''}` }
  }
}

describe('github-projects-cli create-pr (regression #435)', () => {
  let sandbox: Awaited<ReturnType<typeof buildSandbox>>

  beforeEach(async () => {
    sandbox = await buildSandbox()
  })

  afterEach(async () => {
    await sandbox.cleanup()
  })

  it('fails loudly when gh pr create exits non-zero, even if its error output contains a URL', async () => {
    const { code, output } = await runCreatePr({ ...sandbox.env, GH_PR_CREATE_MODE: 'fail-with-url' }, sandbox.dir)

    expect(code).not.toBe(0)
    expect(output).not.toContain('Pull request created')
    expect(output).toContain('Error creating PR')
    // gh's actual error must surface (it was silently swallowed by set -e before the fix)
    expect(output).toContain('was submitted too quickly')
  })

  it('fails when gh exits 0 but prints no PR URL', async () => {
    const { code, output } = await runCreatePr({ ...sandbox.env, GH_PR_CREATE_MODE: 'ok-no-url' }, sandbox.dir)

    expect(code).not.toBe(0)
    expect(output).toContain('Error creating PR')
  })

  it('succeeds and prints the PR URL when gh exits 0 with a real /pull/<n> URL', async () => {
    const { code, output } = await runCreatePr({ ...sandbox.env, GH_PR_CREATE_MODE: 'ok' }, sandbox.dir)

    expect(code).toBe(0)
    expect(output).toContain('Pull request created')
    expect(output).toContain('https://github.com/FakeOrg/FakeRepo/pull/123')
  })
})

/**
 * #603 — `create-pr` ran `git push` and never read the result.
 *
 * `set -e` did abort, but silently: the last line the operator saw was the pre-push hook's
 * "All pre-push checks passed. Proceeding with push...", printed BEFORE the push and never
 * corrected by it. Three times in one day that read as success while no PR existed, twice
 * after a four-minute hook run.
 *
 * #435 hardened `gh pr create` four lines below. The push above it was left as it was.
 */
describe('github-projects-cli create-pr — the push is read (#603)', () => {
  let sandbox: Awaited<ReturnType<typeof buildSandbox>>

  beforeEach(async () => {
    sandbox = await buildSandbox()
  })

  afterEach(async () => {
    await sandbox.cleanup()
  })

  it('fails, and says so, when the push fails', async () => {
    const { code, output } = await runCreatePr({ ...sandbox.env, GH_PR_CREATE_MODE: 'ok', GIT_PUSH_MODE: 'fail' }, sandbox.dir)

    expect(code).not.toBe(0)
    expect(output).toContain('The push failed')
    expect(output).not.toContain('Pull request created')
  })

  it('tells the operator their commits are still there', async () => {
    // The failure is recoverable, and a message that does not say so invites a panic fix.
    const { output } = await runCreatePr({ ...sandbox.env, GH_PR_CREATE_MODE: 'ok', GIT_PUSH_MODE: 'fail' }, sandbox.dir)

    expect(output).toContain('nothing was lost')
  })

  it('does not attempt a PR after a failed push', async () => {
    const { output } = await runCreatePr({ ...sandbox.env, GH_PR_CREATE_MODE: 'fail-with-url', GIT_PUSH_MODE: 'fail' }, sandbox.dir)

    // The gh error must not appear: the command has to stop at the push.
    expect(output).not.toContain('was submitted too quickly')
  })

  describe('a push that exits 0 without sending anything', () => {
    it('is caught by comparing the remote against HEAD, not by the exit code', async () => {
      const { code, output } = await runCreatePr({ ...sandbox.env, GH_PR_CREATE_MODE: 'ok', GIT_PUSH_MODE: 'ok', GIT_LOCAL_HEAD: 'abc123', GIT_REMOTE_HEAD: '' }, sandbox.dir)

      expect(code).not.toBe(0)
      expect(output).toContain('does not carry your commits')
      expect(output).toContain('<branch absent>')
      expect(output).not.toContain('Pull request created')
    })

    it('is caught when the remote is behind', async () => {
      const { code, output } = await runCreatePr({ ...sandbox.env, GH_PR_CREATE_MODE: 'ok', GIT_PUSH_MODE: 'ok', GIT_LOCAL_HEAD: 'newsha', GIT_REMOTE_HEAD: 'oldsha' }, sandbox.dir)

      expect(code).not.toBe(0)
      expect(output).toContain('does not carry your commits')
      expect(output).toContain('oldsha')
      expect(output).toContain('newsha')
    })

    it('proceeds when the remote does carry them', async () => {
      const { code, output } = await runCreatePr({ ...sandbox.env, GH_PR_CREATE_MODE: 'ok', GIT_PUSH_MODE: 'ok', GIT_LOCAL_HEAD: 'samesha', GIT_REMOTE_HEAD: 'samesha' }, sandbox.dir)

      expect(code).toBe(0)
      expect(output).toContain('Pull request created')
    })
  })
})
