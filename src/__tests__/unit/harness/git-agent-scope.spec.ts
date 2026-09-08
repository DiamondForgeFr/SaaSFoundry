import { execFile } from 'child_process'
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { promisify } from 'util'

import { configureLocalAgentExcludes, inspectGitAgentScope, NotGitRepositoryError, removeLocalAgentExcludes } from '../../../harness/git-agent-scope'

const execute = promisify(execFile)

describe('checkout-isolated local agent exclusions', () => {
  let base: string
  let main: string
  let linked: string
  let previousGlobal: string | undefined
  let previousSystem: string | undefined
  const git = async (root: string, ...args: string[]) => (await execute('git', args, { cwd: root, encoding: 'utf8', env: { ...process.env } })).stdout.trim()
  const put = async (root: string, path: string, content = 'content') => {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), content)
  }
  const ignored = async (root: string, path: string) => {
    try {
      await git(root, 'check-ignore', path)
      return true
    } catch (error) {
      if ((error as { code?: number }).code === 1) return false
      throw error
    }
  }
  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'sf-git-agent-scope-'))
    main = join(base, 'main')
    linked = join(base, 'linked')
    await mkdir(main)
    previousGlobal = process.env.GIT_CONFIG_GLOBAL
    previousSystem = process.env.GIT_CONFIG_NOSYSTEM
    process.env.GIT_CONFIG_GLOBAL = join(base, 'global.config')
    process.env.GIT_CONFIG_NOSYSTEM = '1'
    await writeFile(process.env.GIT_CONFIG_GLOBAL, '')
    await git(main, 'init', '-q')
    await git(main, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'initial', '-q')
    await git(main, 'worktree', 'add', '--detach', linked, 'HEAD')
  })
  afterEach(async () => {
    if (previousGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL
    else process.env.GIT_CONFIG_GLOBAL = previousGlobal
    if (previousSystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM
    else process.env.GIT_CONFIG_NOSYSTEM = previousSystem
    await rm(base, { recursive: true, force: true })
  })

  it('uses private worktree excludes and leaves common excludes and tracked files intact', async () => {
    const commonBefore = await readFile(join(main, '.git/info/exclude'), 'utf8')
    const context = await inspectGitAgentScope(linked, { requireLocalSetup: true })
    expect(context.gitDir).not.toBe(context.commonDir)
    expect(context.trackedEntries).toEqual([])
    expect(await readFile(join(main, '.git/config'), 'utf8')).not.toContain('worktreeConfig')
    await configureLocalAgentExcludes(linked, ['AGENTS.md', '.agents/skills/sf-git-commit/SKILL.md'])
    for (const root of [main, linked]) {
      await put(root, 'AGENTS.md')
      await put(root, '.agents/skills/sf-git-commit/SKILL.md')
    }
    expect(await ignored(linked, 'AGENTS.md')).toBe(true)
    expect(await ignored(main, 'AGENTS.md')).toBe(false)
    expect(await ignored(linked, '.agents/skills/sf-git-commit/SKILL.md')).toBe(true)
    await put(linked, '.agents/skills/private/SKILL.md')
    expect(await ignored(linked, '.agents/skills/private/SKILL.md')).toBe(false)
    expect(await readFile(join(main, '.git/info/exclude'), 'utf8')).toBe(commonBefore)
    expect(await git(linked, 'config', '--worktree', '--get', 'core.excludesFile')).toBe(context.excludesPath)
    expect(await git(main, 'status', '--porcelain')).toContain('AGENTS.md')
  })

  it('isolates main-checkout rules from a linked checkout too', async () => {
    await configureLocalAgentExcludes(main, ['AGENTS.md'])
    await put(main, 'AGENTS.md')
    await put(linked, 'AGENTS.md')
    expect(await ignored(main, 'AGENTS.md')).toBe(true)
    expect(await ignored(linked, 'AGENTS.md')).toBe(false)
  })

  it('is idempotent and promotion removes only its exact owned rules', async () => {
    await configureLocalAgentExcludes(linked, ['AGENTS.md', '.agents/skills/sf-git-commit/SKILL.md'])
    const context = await inspectGitAgentScope(linked)
    const before = await readFile(context.excludesPath, 'utf8')
    const stamp = (await lstat(context.excludesPath)).mtimeMs
    expect((await configureLocalAgentExcludes(linked, ['AGENTS.md'])).changed).toBe(false)
    expect((await lstat(context.excludesPath)).mtimeMs).toBe(stamp)
    await writeFile(context.excludesPath, '/custom.txt\n' + before + '\n/after.txt\n')
    expect((await removeLocalAgentExcludes(linked, ['AGENTS.md'])).changed).toBe(true)
    for (const path of ['AGENTS.md', 'custom.txt', 'after.txt', '.agents/skills/sf-git-commit/SKILL.md']) await put(linked, path)
    expect(await ignored(linked, 'AGENTS.md')).toBe(false)
    expect(await ignored(linked, 'custom.txt')).toBe(true)
    expect(await ignored(linked, 'after.txt')).toBe(true)
    expect(await ignored(linked, '.agents/skills/sf-git-commit/SKILL.md')).toBe(true)
    expect((await removeLocalAgentExcludes(linked, ['AGENTS.md'])).changed).toBe(false)
  })

  it('copies inherited custom rules without modifying their source', async () => {
    const source = join(base, 'global.ignore')
    await writeFile(source, '*.backup\n')
    await git(main, 'config', '--global', 'core.excludesFile', source)
    const configured = await configureLocalAgentExcludes(linked, ['AGENTS.md'])
    await put(main, 'file.backup')
    await put(linked, 'file.backup')
    expect(await ignored(main, 'file.backup')).toBe(true)
    expect(await ignored(linked, 'file.backup')).toBe(true)
    expect(await readFile(source, 'utf8')).toBe('*.backup\n')
    expect(configured.warnings.some((warning) => warning.includes('not synchronized'))).toBe(true)
    await removeLocalAgentExcludes(linked, ['AGENTS.md'])
    expect(await ignored(linked, 'file.backup')).toBe(true)
  })

  it('does not hide tracked modifications and inventories staged deletion paths', async () => {
    await put(linked, 'AGENTS.md', 'tracked')
    await git(linked, 'add', 'AGENTS.md')
    await git(linked, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'track', '-q')
    await configureLocalAgentExcludes(linked, ['AGENTS.md'])
    await put(linked, 'AGENTS.md', 'edited')
    expect(await git(linked, 'status', '--porcelain')).toContain('M AGENTS.md')
    expect((await inspectGitAgentScope(linked)).trackedEntries).toContainEqual({ path: 'AGENTS.md', mode: '100644', stage: 0 })
    await git(linked, 'rm', '--cached', 'AGENTS.md')
    const context = await inspectGitAgentScope(linked)
    expect(context.trackedPaths).toContain('AGENTS.md')
    expect(context.headPaths).toContain('AGENTS.md')
    expect(context.trackedEntries).toEqual([])
  })

  it.each([
    ['core.bare', 'true'],
    ['core.worktree', ''],
    ['core.sparseCheckout', 'true']
  ])('requires manual migration for unsafe extension settings %s', async (key, rawValue) => {
    const value = rawValue || main
    await git(main, 'config', '--local', key, value)
    const before = await readFile(join(main, '.git/config'), 'utf8')
    await expect(inspectGitAgentScope(linked, { requireLocalSetup: true })).rejects.toThrow('manual Git worktree configuration migration')
    await expect(configureLocalAgentExcludes(linked, ['AGENTS.md'])).rejects.toThrow('manual Git worktree configuration migration')
    expect(await readFile(join(main, '.git/config'), 'utf8')).toBe(before)
    expect((await removeLocalAgentExcludes(linked, ['AGENTS.md'])).changed).toBe(false)
  })

  it('does not activate dormant worktree config files in any checkout', async () => {
    await writeFile(join(main, '.git/config.worktree'), '[core]\nexcludesFile = /example\n')
    await expect(configureLocalAgentExcludes(linked, ['AGENTS.md'])).rejects.toThrow('dormant config.worktree')
    expect(await readFile(join(main, '.git/config'), 'utf8')).not.toContain('worktreeConfig')
  })

  it('rejects malformed owned blocks and excludes destination symlinks', async () => {
    await configureLocalAgentExcludes(linked, ['AGENTS.md'])
    const context = await inspectGitAgentScope(linked)
    await writeFile(context.excludesPath, '# user replacement\n')
    await expect(configureLocalAgentExcludes(linked, ['AGENTS.md'])).rejects.toThrow('ownership block')
    await expect(removeLocalAgentExcludes(linked, ['AGENTS.md'])).rejects.toThrow('ownership block')
    const outside = join(base, 'keep')
    await writeFile(outside, 'keep')
    await rm(context.excludesPath)
    await symlink(outside, context.excludesPath)
    await expect(configureLocalAgentExcludes(linked, ['AGENTS.md'])).rejects.toThrow('regular agent configuration file')
    expect(await readFile(outside, 'utf8')).toBe('keep')
  })

  it('refuses subdirectory roots and distinguishes repositories from plain folders', async () => {
    await mkdir(join(linked, 'subdir'))
    await expect(inspectGitAgentScope(join(linked, 'subdir'))).rejects.toThrow('checkout root')
    await expect(inspectGitAgentScope(base)).rejects.toBeInstanceOf(NotGitRepositoryError)
  })

  it('quotes glob characters and spaces instead of broadening the excluded paths', async () => {
    await configureLocalAgentExcludes(linked, ['literal*.md', 'space file.md'])
    await put(linked, 'literal*.md')
    await put(linked, 'literalOther.md')
    await put(linked, 'space file.md')
    expect(await ignored(linked, 'literal*.md')).toBe(true)
    expect(await ignored(linked, 'literalOther.md')).toBe(false)
    expect(await ignored(linked, 'space file.md')).toBe(true)
    await expect(configureLocalAgentExcludes(linked, ['../elsewhere'])).rejects.toThrow('project-relative')
  })

  it('refuses higher-priority negations before activating any exclusions', async () => {
    await put(linked, '.gitignore', '!AGENTS.md\n')
    const context = await inspectGitAgentScope(linked)
    const before = await readFile(join(main, '.git/config'), 'utf8')
    await expect(configureLocalAgentExcludes(linked, ['AGENTS.md'])).rejects.toThrow('override local agent exclusions')
    expect(await readFile(join(main, '.git/config'), 'utf8')).toBe(before)
    await expect(readFile(context.excludesPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('ignores inherited repository and inline configuration overrides', async () => {
    const mainBefore = await readFile(join(main, '.git/config'), 'utf8')
    const overrides = {
      GIT_DIR: join(main, '.git'),
      GIT_WORK_TREE: linked,
      GIT_INDEX_FILE: join(main, '.git/foreign-index'),
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.excludesFile',
      GIT_CONFIG_VALUE_0: join(base, 'foreign.exclude')
    }
    const previous = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]))
    // Already-enabled extension means no shared config write is necessary.
    await git(main, 'config', '--local', 'extensions.worktreeConfig', 'true')
    const enabledConfig = await readFile(join(main, '.git/config'), 'utf8')
    Object.assign(process.env, overrides)
    try {
      const context = await inspectGitAgentScope(linked)
      expect(context.gitDir).toContain('worktrees')
      await configureLocalAgentExcludes(linked, ['AGENTS.md'])
      expect(await readFile(join(main, '.git/config'), 'utf8')).toBe(enabledConfig)
      await expect(readFile(join(main, '.git/config.worktree'))).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(readFile(join(main, '.git/foreign-index'))).rejects.toMatchObject({ code: 'ENOENT' })
      expect(mainBefore).not.toBe(enabledConfig)
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })
})
