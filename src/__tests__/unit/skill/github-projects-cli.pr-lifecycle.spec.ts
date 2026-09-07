import { execFile } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const CLI = path.resolve(__dirname, '../../../../.claude/skills/sf-tool-github-projects/github-projects-cli.sh')
const pr = { number: 123, url: 'https://github.com/FakeOrg/FakeRepo/pull/123', headRefName: 'feature/42-work', headRefOid: 'abc123', isDraft: true }

// Exercise real Bash control flow with observable Git/GitHub boundaries. No network.
describe('GitHub PR draft lifecycle (#655)', () => {
  let dir: string
  let env: NodeJS.ProcessEnv
  let log: string
  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'sf-pr-lifecycle-'))
    await mkdir(path.join(dir, 'bin'))
    await writeFile(path.join(dir, '.saasfoundry.json'), JSON.stringify({ workflow: { workingBranch: 'develop' } }))
    log = path.join(dir, 'calls')
    const gh = `#!/bin/bash
printf '%s\\n' "$*" >> "$CALLS"
case "$1 $2" in
  'issue view') echo 'Sample ticket';;
  'pr list')
    [ "$FETCH_FAIL" = 1 ] && exit 1
    if [ -f "$READY_MARKER" ] && [ "$READY_NOOP" != 1 ]; then
      printf '%s' "$PRS" | jq --argjson draft "$(cat "$READY_MARKER")" 'map(.isDraft = $draft)'
    else printf '%s' "$PRS"; fi;;
  'pr create') echo 'https://github.com/FakeOrg/FakeRepo/pull/123';;
  'pr ready') [ "$READY_FAIL" = 1 ] && exit 1; if [ "$4" = --undo ]; then echo true; else echo false; fi > "$READY_MARKER";;
  *) exit 1;;
esac
`
    const git = `#!/bin/bash
printf 'git %s\\n' "$*" >> "$CALLS"
case "$1" in
  rev-parse) if [ "$2" = HEAD ]; then echo abc123; else echo "\${BRANCH:-feature/42-work}"; fi;;
  ls-remote) printf '%s\\trefs/heads/feature/42-work\\n' "\${REMOTE_SHA:-abc123}";;
  push) [ "$PUSH_FAIL" != 1 ];;
  *) exit 1;;
esac
`
    for (const [name, content] of [
      ['gh', gh],
      ['git', git]
    ]) {
      const file = path.join(dir, 'bin', name)
      writeFileSync(file, content)
      chmodSync(file, 0o755)
    }
    env = { ...process.env, PATH: `${path.join(dir, 'bin')}:${process.env.PATH}`, CALLS: log, READY_MARKER: path.join(dir, 'ready'), PRS: JSON.stringify([pr]) }
  })
  afterEach(async () => rm(dir, { recursive: true, force: true }))

  async function run(args: string[], changes: NodeJS.ProcessEnv = {}) {
    try {
      const result = await exec('/bin/bash', [CLI, ...args], { cwd: dir, env: { ...env, ...changes } })
      return { code: 0, ...result }
    } catch (error) {
      return error as { code: number; stdout: string; stderr: string }
    }
  }
  const calls = () => readFileSync(log, 'utf8')

  it('creates a draft only on explicit --draft', async () => {
    expect((await run(['create-pr', '42', '--draft'], { PRS: '[]' })).code).toBe(0)
    expect(calls()).toContain('pr create --title [#42] Sample ticket --body Resolves #42 --base develop --draft')
  })
  it('keeps ready creation available for internal and solo workflows', async () => {
    expect((await run(['create-pr', '42'], { PRS: '[]' })).code).toBe(0)
    expect(calls()).toContain('pr create')
    expect(calls()).not.toContain('--draft')
  })
  it.each([true, false])('reuses an existing PR without changing draft=%s', async (draft) => {
    expect((await run(['create-pr', '42', '--draft'], { PRS: JSON.stringify([{ ...pr, isDraft: draft }]) })).code).toBe(0)
    expect(calls()).toContain('git push')
    expect(calls()).not.toContain('pr create')
    expect(calls()).not.toContain('pr ready')
  })
  it('promotes explicitly and verifies the new state', async () => {
    expect((await run(['ready-pr', '42'])).code).toBe(0)
    expect(calls()).toContain('pr ready 123')
    expect(calls().match(/pr list/g)).toHaveLength(2)
    expect(calls()).not.toContain('git push')
  })
  it('is idempotent when the PR is already ready', async () => {
    expect((await run(['ready-pr', '42'], { PRS: JSON.stringify([{ ...pr, isDraft: false }]) })).code).toBe(0)
    expect(calls()).not.toContain('pr ready')
  })
  it('returns a ready PR to draft explicitly and verifies it', async () => {
    expect((await run(['draft-pr', '42'], { PRS: JSON.stringify([{ ...pr, isDraft: false }]) })).code).toBe(0)
    expect(calls()).toContain('pr ready 123 --undo')
    expect(calls().match(/pr list/g)).toHaveLength(2)
  })
  it('keeps an existing draft idempotently', async () => {
    expect((await run(['draft-pr', '42'])).code).toBe(0)
    expect(calls()).not.toContain('pr ready')
  })
  it.each([
    { PRS: '[]' },
    { PRS: JSON.stringify([pr, { ...pr, number: 124 }]) },
    { PRS: JSON.stringify([{ ...pr, isDraft: undefined }]) },
    { PRS: '{}' },
    { FETCH_FAIL: '1' },
    { REMOTE_SHA: 'old' },
    { PRS: JSON.stringify([{ ...pr, headRefOid: 'old' }]) },
    { BRANCH: 'feature/420-other' }
  ])('refuses promotion for unverified state %j', async (changes) => {
    expect((await run(['ready-pr', '42'], changes)).code).not.toBe(0)
    expect(calls()).not.toContain('pr ready')
  })
  it.each([{ READY_FAIL: '1' }, { READY_NOOP: '1' }])('does not claim successful promotion on failure %j', async (changes) => {
    const result = await run(['ready-pr', '42'], changes)
    expect(result.code).not.toBe(0)
    expect(result.stdout).not.toContain('is ready for review')
  })
  it.each([
    ['create-pr', '42', '--wat'],
    ['create-pr', '42', '--draft', '--draft'],
    ['ready-pr', '42', '--draft'],
    ['ready-pr', '0']
  ])('rejects invalid arguments %j', async (...args) => {
    expect((await run(args)).code).not.toBe(0)
  })
})
