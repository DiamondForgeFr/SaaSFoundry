import { execFile } from 'child_process'
import { randomUUID } from 'crypto'
import { lstat, open, readFile, readdir, realpath, rename, unlink } from 'fs/promises'
import { homedir } from 'os'
import { isAbsolute, join, resolve } from 'path'
import { promisify } from 'util'

const execute = promisify(execFile)
const BEGIN = '# BEGIN SaaSFoundry local agent exclusions'
const END = '# END SaaSFoundry local agent exclusions'
let localEnvironmentNames: Promise<string[]> | undefined

export class NotGitRepositoryError extends Error {
  constructor() {
    super('Local agent configuration requires a Git checkout.')
    this.name = 'NotGitRepositoryError'
  }
}

export interface GitAgentScope {
  root: string
  gitDir: string
  commonDir: string
  excludesPath: string
  worktreeConfigEnabled: boolean
  inheritedExcludesPath?: string
  trackedPaths: string[]
  trackedEntries: { path: string; mode: string; stage: number }[]
  headPaths: string[]
}

export interface GitAgentExcludesResult {
  changed: boolean
  warnings: string[]
}

async function git(root: string, args: string[], missingAllowed = false, input?: string): Promise<string | undefined> {
  // Inherited repository overrides (common in hooks) must not redirect this
  // checkout's configuration or index into another repository.
  localEnvironmentNames ??= execute('git', ['rev-parse', '--local-env-vars'], { encoding: 'utf8', env: { ...process.env } }).then(({ stdout }) => stdout.trim().split('\n'))
  const omitted = new Set(await localEnvironmentNames)
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !omitted.has(key) && !/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(key)))
  try {
    if (input !== undefined) {
      return await new Promise<string>((resolveOutput, reject) => {
        const child = execFile('git', args, { cwd: root, encoding: 'utf8', env, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => (error ? reject(error) : resolveOutput(stdout)))
        child.stdin?.end(input)
      })
    }
    return (await execute('git', args, { cwd: root, encoding: 'utf8', env, maxBuffer: 16 * 1024 * 1024 })).stdout
  } catch (error) {
    if (missingAllowed && (error as { code?: number }).code === 1) return undefined
    throw error
  }
}

async function regularFile(path: string): Promise<string | undefined> {
  try {
    const stat = await lstat(path)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Expected a regular agent configuration file, not a link or directory: ${path}`)
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

async function validateExtensionEnable(root: string, gitDir: string, commonDir: string): Promise<void> {
  for (const key of ['core.worktree', 'core.bare', 'core.sparseCheckout', 'core.sparseCheckoutCone']) {
    const value = await git(root, ['config', '--local', '--includes', ...(key === 'core.worktree' ? [] : ['--bool']), '--get', key], true)
    if (value !== undefined && (key === 'core.worktree' || value.trim() === 'true')) {
      throw new Error(`Local agent isolation requires extensions.worktreeConfig, but ${key} needs manual Git worktree configuration migration first. No agent exclusions were changed.`)
    }
  }
  // Enabling the extension activates previously ignored config.worktree files.
  // Do not accidentally activate somebody else's dormant configuration.
  const directories = new Set([commonDir, gitDir])
  try {
    for (const entry of await readdir(join(commonDir, 'worktrees'), { withFileTypes: true })) {
      if (entry.isDirectory()) directories.add(join(commonDir, 'worktrees', entry.name))
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  for (const directory of directories) {
    if ((await regularFile(join(directory, 'config.worktree')))?.trim()) {
      throw new Error('A dormant config.worktree already exists. Review and enable extensions.worktreeConfig manually before local agent setup.')
    }
  }
  await regularFile(join(commonDir, 'config'))
}

/**
 * Read-only preflight. info/exclude belongs to GIT_COMMON_DIR and is deliberately
 * not used: its patterns would affect every linked checkout.
 */
export async function inspectGitAgentScope(targetPath: string, options: { requireLocalSetup?: boolean } = {}): Promise<GitAgentScope> {
  const requested = await realpath(resolve(targetPath))
  let top: string
  try {
    top = (await git(requested, ['rev-parse', '--show-toplevel']))!.trim()
  } catch (error) {
    if (/not a git repository/i.test(String((error as { stderr?: string }).stderr))) throw new NotGitRepositoryError()
    throw error
  }
  const root = await realpath(top)
  if (root !== requested) throw new Error(`Run agent configuration from the Git checkout root: ${root}`)
  const gitDir = resolve(root, (await git(root, ['rev-parse', '--absolute-git-dir']))!.trim())
  const commonDir = resolve(root, (await git(root, ['rev-parse', '--git-common-dir']))!.trim())
  for (const path of [gitDir, commonDir]) {
    if ((await lstat(path)).isSymbolicLink()) throw new Error(`Cannot configure agent exclusions through a linked metadata directory: ${path}`)
  }
  const worktreeConfigEnabled = (await git(root, ['config', '--bool', '--get', 'extensions.worktreeConfig'], true))?.trim() === 'true'
  if (!worktreeConfigEnabled && options.requireLocalSetup) await validateExtensionEnable(root, gitDir, commonDir)
  await regularFile(join(gitDir, 'config.worktree'))
  const excludesPath = join(gitDir, 'saasfoundry-agents.exclude')
  await regularFile(excludesPath)
  const configuredExcludes = await git(root, ['config', '--path', '--get', 'core.excludesFile'], true)
  const inheritedExcludesPath = configuredExcludes === undefined ? join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'git/ignore') : configuredExcludes.trim()
  const trackedEntries = (await git(root, ['ls-files', '--stage', '-z']))!
    .split('\0')
    .filter(Boolean)
    .map((entry) => {
      const tab = entry.indexOf('\t')
      const [mode, , stage] = entry.slice(0, tab).split(' ')
      return { path: entry.slice(tab + 1), mode, stage: Number(stage) }
    })
  let headPaths: string[] = []
  if (await git(root, ['rev-parse', '--verify', '--quiet', 'HEAD'], true)) {
    headPaths = (await git(root, ['ls-tree', '-r', '--name-only', '-z', 'HEAD']))!.split('\0').filter(Boolean)
  }
  const trackedPaths = [...new Set([...trackedEntries.map((entry) => entry.path), ...headPaths])]
  return {
    root,
    gitDir,
    commonDir,
    excludesPath,
    worktreeConfigEnabled,
    inheritedExcludesPath: inheritedExcludesPath ? resolve(root, inheritedExcludesPath) : undefined,
    trackedPaths,
    trackedEntries,
    headPaths
  }
}

function patterns(paths: string[]): string[] {
  return [...new Set(paths)].sort().map((path) => {
    if (!path || isAbsolute(path) || path.includes('\\') || /[\r\n\0]/.test(path) || path.split('/').some((part) => !part || part === '.' || part === '..')) {
      throw new Error(`Agent exclusion must be an exact project-relative file path: ${JSON.stringify(path)}`)
    }
    // Literal paths only: do not turn a filename into a broad ignore expression.
    return '/' + path.replace(/[!*?\[\]# ]/g, '\\$&')
  })
}

function parseOwned(content: string): { prefix: string; suffix: string; rules: string[] } {
  const lines = content.split('\n')
  const starts = lines.flatMap((line, index) => (line === BEGIN ? [index] : []))
  const ends = lines.flatMap((line, index) => (line === END ? [index] : []))
  if (starts.length !== 1 || ends.length !== 1 || ends[0] < starts[0]) {
    throw new Error('The local agent exclusion ownership block is missing or malformed. Preserve this file and reconcile it before retrying.')
  }
  return { prefix: lines.slice(0, starts[0]).join('\n'), suffix: lines.slice(ends[0] + 1).join('\n'), rules: lines.slice(starts[0] + 1, ends[0]) }
}

async function writeOwned(path: string, before: string | undefined, content: string): Promise<boolean> {
  if (before === content) return false
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(content)
    } finally {
      await handle.close()
    }
    if ((await regularFile(path)) !== before) throw new Error('Local agent exclusions changed concurrently; existing edits were preserved. Retry setup.')
    await rename(temporary, path)
    return true
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
    })
  }
}

async function verifyEffectiveExcludes(context: GitAgentScope, content: string, paths: string[]): Promise<void> {
  const candidate = `${context.excludesPath}.${randomUUID()}.check`
  try {
    const handle = await open(candidate, 'wx', 0o600)
    try {
      await handle.writeFile(content)
    } finally {
      await handle.close()
    }
    for (let offset = 0; offset < paths.length; offset += 100) {
      const batch = paths.slice(offset, offset + 100)
      const output = await git(context.root, ['-c', `core.excludesFile=${candidate}`, 'check-ignore', '--no-index', '-z', '--stdin'], true, batch.join('\0') + '\0')
      const ignored = new Set((output ?? '').split('\0').filter(Boolean))
      const visible = batch.filter((path) => !ignored.has(path))
      if (visible.length) {
        throw new Error(
          `Project ignore rules override local agent exclusions for: ${visible.join(', ')}. Reconcile the higher-priority .gitignore/info/exclude rules first; no agent configuration was activated.`
        )
      }
    }
  } finally {
    await unlink(candidate).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
    })
  }
}

/** Add exact file exclusions in this checkout's private Git config only. */
export async function configureLocalAgentExcludes(root: string, paths: string[]): Promise<GitAgentExcludesResult> {
  const additions = patterns(paths)
  const context = await inspectGitAgentScope(root, { requireLocalSetup: true })
  const before = await regularFile(context.excludesPath)
  const warnings: string[] = []
  let owned: ReturnType<typeof parseOwned>
  if (before !== undefined) {
    if (context.inheritedExcludesPath !== context.excludesPath)
      throw new Error('core.excludesFile changed after local agent setup. Existing configuration was preserved; reconcile it before retrying.')
    owned = parseOwned(before)
  } else {
    let inherited = ''
    if (context.inheritedExcludesPath && context.inheritedExcludesPath !== context.excludesPath) {
      // Snapshot the effective global/custom excludes; never edit its source.
      try {
        inherited = await readFile(context.inheritedExcludesPath, 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      if (inherited) warnings.push(`Existing exclusions were copied from ${context.inheritedExcludesPath}; future source edits are not synchronized automatically.`)
    }
    if (inherited.includes(BEGIN) || inherited.includes(END)) throw new Error('Inherited exclusions contain an agent ownership marker; reconcile them before setup.')
    owned = { prefix: inherited, suffix: '', rules: [] }
  }
  const rules = [...new Set([...owned.rules, ...additions])].sort()
  const content = [owned.prefix, BEGIN, ...rules, END, owned.suffix].join('\n')
  await verifyEffectiveExcludes(context, content, paths)
  if (!context.worktreeConfigEnabled) {
    await git(context.root, ['config', '--local', 'extensions.worktreeConfig', 'true'])
    warnings.push('Enabled Git worktreeConfig metadata so agent exclusions stay isolated per checkout; older Git versions may not support this extension.')
  }
  const changed = await writeOwned(context.excludesPath, before, content)
  if (context.inheritedExcludesPath !== context.excludesPath) {
    await git(context.root, ['config', '--worktree', 'core.excludesFile', context.excludesPath])
  }
  return { changed, warnings }
}

/** Shared promotion removes only rules owned by this helper, retaining snapshots/user rules. */
export async function removeLocalAgentExcludes(root: string, paths: string[]): Promise<GitAgentExcludesResult> {
  const removals = new Set(patterns(paths))
  const context = await inspectGitAgentScope(root)
  const before = await regularFile(context.excludesPath)
  if (before === undefined) return { changed: false, warnings: [] }
  if (context.inheritedExcludesPath !== context.excludesPath) throw new Error('core.excludesFile changed after local agent setup. Reconcile it before shared promotion.')
  const owned = parseOwned(before)
  const content = [owned.prefix, BEGIN, ...owned.rules.filter((rule) => !removals.has(rule)), END, owned.suffix].join('\n')
  return { changed: await writeOwned(context.excludesPath, before, content), warnings: [] }
}
