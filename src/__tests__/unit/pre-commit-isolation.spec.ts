import { execFileSync } from 'child_process'
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'

it('keeps repositories created by pre-commit tests isolated from the committing repository', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sf-hook-isolation-'))
  try {
    const repo = join(dir, 'repo')
    const bin = join(dir, 'bin')
    mkdirSync(repo)
    mkdirSync(bin)
    execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'pipe' })
    const npm = join(bin, 'npm')
    writeFileSync(npm, '#!/bin/sh\nprintf "%s\\n" "$*" > "$SF_TEST_ARGS"\ngit init --bare "$SF_TEST_REMOTE" > /dev/null 2>&1\n')
    chmodSync(npm, 0o755)
    const remote = join(dir, 'remote.git')
    const args = join(dir, 'args')
    execFileSync('sh', [resolve(__dirname, '../../../.husky/pre-commit')], {
      cwd: repo,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GIT_DIR: join(repo, '.git'), GIT_INDEX_FILE: join(repo, '.git/index'), SF_TEST_REMOTE: remote, SF_TEST_ARGS: args },
      stdio: 'pipe'
    })
    expect(readFileSync(args, 'utf8').trim()).toBe('run test:pre-commit')
    expect(execFileSync('git', ['-C', repo, 'rev-parse', '--is-bare-repository'], { encoding: 'utf8' }).trim()).toBe('false')
    expect(execFileSync('git', ['--git-dir', remote, 'rev-parse', '--is-bare-repository'], { encoding: 'utf8' }).trim()).toBe('true')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
