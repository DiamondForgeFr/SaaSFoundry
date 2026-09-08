import { createHash, randomUUID } from 'crypto'
import { lstat, mkdir, open, readFile, readdir, rename, unlink } from 'fs/promises'
import { dirname, join, resolve } from 'path'

import {
  AgentInstructionsReport,
  AgentInstructionsError,
  ADOPTION_COMMON_INSTRUCTIONS,
  CODEX_SOURCE_CLAUDE_BRIDGE,
  HarnessAgent,
  installAgentInstructions,
  installPlannedAgentInstructions,
  AgentInstructionPlan,
  planAgentInstructions,
  AgentInstructionFile,
  inspectInstructionSource
} from './agent-instructions'
import { inspectGitAgentScope, configureLocalAgentExcludes, removeLocalAgentExcludes, NotGitRepositoryError, GitAgentScope } from './git-agent-scope'
import { safeWriteAgentFile } from './agent-file-writer'
import { getAgentIds, isHarnessAgent, getSharedAgentEntrypoints } from './agent-registry'
import { harnessInstallerMeta } from '../installers/harness.installer'
import { SaaSFoundryManifest } from '../types'

const AGENTS = getAgentIds()

export interface AgentSupportInventory {
  configuredAgents: HarnessAgent[]
  sharedAgents: HarnessAgent[]
  localAgents: HarnessAgent[]
  discovered: { claudeInstructions: boolean; sharedInstructions: boolean; sharedSkills: boolean }
  runtime: 'not-checked'
}

export interface AgentSupportResult {
  scope: 'local' | 'shared'
  localStateChanged: boolean
  configuredAgents: HarnessAgent[]
  sharedAgents: HarnessAgent[]
  localAgents: HarnessAgent[]
  report: AgentInstructionsReport
  manifestChanged: boolean
  previewPlan?: AgentInstructionPlan
  fingerprint?: string
}

interface SupportParams {
  targetPath: string
  scope?: string
  /** Internal read-only projection; never creates locks, excludes or files. */
  preview?: boolean
  /** Revalidate an approved adoption snapshot under the coordinator lock. */
  verify?: () => Promise<AgentInstructionPlan>
  adoption?: boolean
}
interface ManifestSnapshot {
  manifest: SaaSFoundryManifest
  content: string
  mode: number
}
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

function validateAgents(agents: unknown): asserts agents is HarnessAgent[] {
  if (!Array.isArray(agents) || agents.length === 0 || agents.some((agent) => !isHarnessAgent(agent))) {
    throw new Error(`Choose coding agents from the registered tool profiles: ${AGENTS.join(', ')}. Use sf agents catalog for profiles. Model/provider names are not tool identifiers.`)
  }
}

function resolveScope(scope?: string): 'local' | 'shared' {
  if (scope === undefined || scope === 'local') return 'local'
  if (scope === 'shared') return 'shared'
  throw new Error('Agent scope must be local (default) or shared.')
}

/** Validate only manifest fields consumed here; retain unrelated configuration. */
function validateManifest(value: unknown): asserts value is SaaSFoundryManifest {
  if (
    !isObject(value) ||
    typeof value.version !== 'string' ||
    !value.version ||
    typeof value.projectName !== 'string' ||
    !value.projectName ||
    !['monorepo', 'multirepo', 'cli'].includes(String(value.structure))
  ) {
    throw new Error('Invalid SaaSFoundry manifest: expected version, projectName and a supported structure.')
  }
  if (value.modules !== undefined) {
    if (!isObject(value.modules)) throw new Error('Invalid manifest modules configuration.')
    if (value.modules.harness !== undefined) {
      const harness = value.modules.harness
      if (!isObject(harness) || !Number.isInteger(harness.version) || Number(harness.version) < 0) throw new Error('Invalid manifest harness version.')
      if (harness.agents !== undefined) validateAgents(harness.agents)
    }
  }
  if (value.fileHashes !== undefined && (!isObject(value.fileHashes) || Object.values(value.fileHashes).some((hash) => typeof hash !== 'string'))) {
    throw new Error('Invalid manifest generated-file baselines.')
  }
}

async function regularPath(root: string, relativePath: string, kind: 'file' | 'directory', required = true): Promise<boolean> {
  let current = root
  // Do not resolve symlinks inside the project into another checkout or user's files.
  const parts = relativePath ? relativePath.split('/') : []
  for (let index = -1; index < parts.length; index++) {
    if (index >= 0) current = join(current, parts[index])
    try {
      const stat = await lstat(current)
      if (stat.isSymbolicLink()) throw new Error(`Cannot manage agent support through symbolic link: ${current}`)
      const expectedDirectory = index < parts.length - 1 || kind === 'directory'
      if (expectedDirectory ? !stat.isDirectory() : !stat.isFile()) throw new Error(`Expected a regular ${expectedDirectory ? 'directory' : 'file'}: ${current}`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !required) return false
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`No managed harness at ${root}: required ${relativePath || 'project directory'} is missing.`)
      throw error
    }
  }
  return true
}

async function snapshot(root: string): Promise<ManifestSnapshot> {
  await regularPath(root, '.saasfoundry.json', 'file')
  const path = join(root, '.saasfoundry.json')
  const content = await readFile(path, 'utf8')
  let manifest: unknown
  try {
    manifest = JSON.parse(content)
  } catch {
    throw new Error('Invalid JSON in .saasfoundry.json; no agent setup was performed.')
  }
  validateManifest(manifest)
  return { manifest, content, mode: (await lstat(path)).mode & 0o777 }
}

function configured(manifest: SaaSFoundryManifest, source: 'claude' | 'codex' | 'mixed' | 'missing' = 'claude'): HarnessAgent[] {
  // Legacy managed harnesses already provide Claude instruction discovery.
  return [...new Set(manifest.modules?.harness?.agents ?? (source === 'codex' ? ['codex'] : ['claude-code']))] as HarnessAgent[]
}

async function inspect(root: string) {
  const before = await snapshot(root)
  const instructions = await inspectInstructionSource(root)
  if (instructions.source === 'missing') throw new Error(`No managed harness at ${root}: CLAUDE.md or AGENTS.md is required. Configure project instructions before adoption.`)
  await regularPath(root, '.claude/skills', 'directory', false)
  const sharedSkills = await regularPath(root, '.agents/skills', 'directory', false)
  return { before, source: instructions.source, discovered: { claudeInstructions: instructions.claudeInstructions, sharedInstructions: instructions.sharedInstructions, sharedSkills } }
}

export async function readAgentSupport(targetPath: string): Promise<AgentSupportInventory> {
  const root = resolve(targetPath)
  const { before, discovered, source } = await inspect(root)
  const git = await optionalGitScope(root)
  const local = git ? await readLocalState(git) : emptyLocalState()
  const sharedAgents = configured(before.manifest, source)
  return { configuredAgents: union(sharedAgents, local.agents), sharedAgents, localAgents: local.agents, discovered, runtime: 'not-checked' }
}

/** Atomic replacement, refusing detected edits instead of overwriting a newer manifest. */
async function persist(root: string, before: ManifestSnapshot, next: SaaSFoundryManifest): Promise<boolean> {
  const current = await snapshot(root)
  if (current.content !== before.content) throw new Error('Manifest changed during agent setup. Existing changes were preserved; inspect the generated files and retry.')
  if (JSON.stringify(before.manifest) === JSON.stringify(next)) return false
  const destination = join(root, '.saasfoundry.json')
  const temporary = join(root, `.saasfoundry.agents-${randomUUID()}.tmp`)
  try {
    const handle = await open(temporary, 'wx', before.mode)
    try {
      await handle.writeFile(JSON.stringify(next, null, 2) + '\n')
      await handle.sync()
    } finally {
      await handle.close()
    }
    const latest = await snapshot(root)
    if (latest.content !== before.content) throw new Error('Manifest changed before saving agent support. Changes were preserved; retry setup.')
    await rename(temporary, destination)
    return true
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
    })
  }
}

async function apply(params: SupportParams, requested?: HarnessAgent[]): Promise<AgentSupportResult> {
  const scope = resolveScope(params.scope)
  if (scope === 'local') return applyLocal(params, requested)
  const root = resolve(params.targetPath)
  const { before, source } = await inspect(root)
  const git = await optionalGitScope(root)
  const local = git ? await readLocalState(git) : emptyLocalState()
  if (params.preview) {
    const previous = configured(before.manifest, source)
    const candidates = union(previous, requested ?? [])
    const plan = await planAgentInstructions({
      targetPath: root,
      agents: candidates,
      manifest: before.manifest,
      referenceOnly:
        params.adoption || local.fileHashes['AGENTS.md'] === hash(Buffer.from(ADOPTION_COMMON_INSTRUCTIONS)) || local.fileHashes['CLAUDE.md'] === hash(Buffer.from(CODEX_SOURCE_CLAUDE_BRIDGE))
    })
    const report: AgentInstructionsReport = { written: [], unchanged: [], conflicts: [], warnings: [...plan.warnings], fileHashes: {} }
    for (const file of plan.files) {
      const current = await checkLocalPath(root, file.path)
      if (current?.equals(file.content)) report.unchanged.push(file.path)
      else if (current && before.manifest.fileHashes?.[file.path] !== hash(current)) report.conflicts.push(file.path)
      else report.written.push(file.path)
      if (!report.conflicts.includes(file.path)) report.fileHashes[file.path] = hash(file.content)
    }
    return {
      scope,
      configuredAgents: union(previous, local.agents),
      sharedAgents: previous,
      localAgents: local.agents,
      report,
      manifestChanged: false,
      localStateChanged: false,
      previewPlan: plan,
      fingerprint: hash(Buffer.from(JSON.stringify({ manifest: before.content, local, index: git?.trackedEntries, head: git?.headPaths, planned: planDigest(plan) })))
    }
  }
  if (git) await mkdir(dirname(statePath(git)), { recursive: true })
  const lockPath = git ? join(dirname(statePath(git)), 'agents.lock') : join(root, '.saasfoundry.agents.lock')
  let lock
  try {
    lock = await open(lockPath, 'wx', 0o600)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw new Error('Another agent setup holds .saasfoundry.agents.lock. Wait for it to finish; if interrupted, inspect that lock before retrying.')
    throw error
  }
  let partialReport: AgentInstructionsReport | undefined
  let primaryFailure: unknown
  try {
    const verifiedPlan = await params.verify?.()
    if (verifiedPlan && (await inspect(root)).source !== source) throw new Error('Instruction source changed during shared preflight; generate a fresh preview.')
    // Cooperating enables cannot overwrite each other; external manifest edits are
    // checked again before saving. No installer, hooks, Git commands or credentials.
    if ((await snapshot(root)).content !== before.content) throw new Error('Manifest changed before agent setup; retry with the current configuration.')
    if (git && JSON.stringify(await readLocalState(git)) !== JSON.stringify(local)) throw new Error('Private agent inventory changed before shared setup; retry with current configuration.')
    const previous = configured(before.manifest, source)
    const candidates = AGENTS.filter((agent) => previous.includes(agent) || requested?.includes(agent))
    const report = verifiedPlan
      ? await installPlannedAgentInstructions(root, verifiedPlan, before.manifest.fileHashes ?? {})
      : await installAgentInstructions({
          targetPath: root,
          agents: candidates,
          manifest: before.manifest,
          referenceOnly:
            params.adoption || local.fileHashes['AGENTS.md'] === hash(Buffer.from(ADOPTION_COMMON_INSTRUCTIONS)) || local.fileHashes['CLAUDE.md'] === hash(Buffer.from(CODEX_SOURCE_CLAUDE_BRIDGE))
        })
    partialReport = report
    const configuredAgents = report.conflicts.length ? previous : candidates
    const next: SaaSFoundryManifest = { ...before.manifest }
    if (!report.conflicts.length) {
      next.modules = {
        ...before.manifest.modules,
        harness: {
          ...before.manifest.modules?.harness,
          version: before.manifest.modules?.harness?.version ?? (params.adoption ? 0 : harnessInstallerMeta.currentVersion),
          agents: configuredAgents
        }
      }
    }
    if (Object.keys(report.fileHashes).length) next.fileHashes = { ...before.manifest.fileHashes, ...report.fileHashes }
    const manifestChanged = await persist(root, before, next)
    let localStateChanged = false
    if (git) {
      const promoted = new Set(Object.keys(report.fileHashes))
      localStateChanged = await persistLocal(git, local, {
        ...local,
        fileHashes: Object.fromEntries(Object.entries(local.fileHashes).filter(([path]) => !promoted.has(path))),
        ...(local.pendingFileHashes ? { pendingFileHashes: Object.fromEntries(Object.entries(local.pendingFileHashes).filter(([path]) => !promoted.has(path))) } : {})
      })
      const cleanup = await removeLocalAgentExcludes(root, Object.keys(report.fileHashes))
      report.warnings.push(...cleanup.warnings)
    }
    return { scope: 'shared', configuredAgents: union(configuredAgents, local.agents), sharedAgents: configuredAgents, localAgents: local.agents, report, manifestChanged, localStateChanged }
  } catch (error) {
    primaryFailure = error
    if (error instanceof AgentInstructionsError) {
      partialReport = error.report
      throw error
    }
    if (params.adoption && partialReport) throw adoptionFailure('shared', partialReport, error)
    throw error
  } finally {
    await releaseLock(lock, lockPath, partialReport, primaryFailure)
  }
}

export async function enableAgents(params: SupportParams & { agents: string[] }): Promise<AgentSupportResult> {
  resolveScope(params.scope)
  validateAgents(params.agents)
  return apply(params, params.agents)
}

export async function refreshAgents(params: SupportParams): Promise<AgentSupportResult> {
  return apply(params)
}

interface LocalAgentState {
  version: 1
  agents: HarnessAgent[]
  fileHashes: Record<string, string>
  /** Recovery intent only, never a claim that an agent or file was installed. */
  pendingFileHashes?: Record<string, string>
}
const emptyLocalState = (): LocalAgentState => ({ version: 1, agents: [], fileHashes: {} })
const union = (...sets: HarnessAgent[][]): HarnessAgent[] => AGENTS.filter((agent) => sets.some((set) => set.includes(agent)))
const hash = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
const statePath = (git: GitAgentScope): string => join(git.gitDir, 'saasfoundry', 'agents.json')

async function optionalGitScope(root: string): Promise<GitAgentScope | undefined> {
  try {
    return await inspectGitAgentScope(root)
  } catch (error) {
    if (error instanceof NotGitRepositoryError || (error instanceof Error && error.message.startsWith('Run agent configuration from the Git checkout root:'))) return undefined
    throw error
  }
}

async function readLocalState(git: GitAgentScope): Promise<LocalAgentState> {
  if (!(await regularPath(git.gitDir, 'saasfoundry/agents.json', 'file', false))) return emptyLocalState()
  let state: unknown
  try {
    state = JSON.parse(await readFile(statePath(git), 'utf8'))
  } catch {
    throw new Error('Invalid private agent inventory JSON; existing configuration was preserved.')
  }
  const validHashes = (value: unknown): boolean =>
    isObject(value) &&
    !Object.entries(value).some(
      ([path, hash]) =>
        !(['CLAUDE.md', ...getSharedAgentEntrypoints()].includes(path) || /^\.agents\/skills\/[a-zA-Z0-9_.\/-]+$/.test(path)) ||
        path.split('/').includes('..') ||
        typeof hash !== 'string' ||
        !/^[0-9a-f]{64}$/.test(hash)
    )
  if (
    !isObject(state) ||
    state.version !== 1 ||
    !Array.isArray(state.agents) ||
    state.agents.some((agent) => !AGENTS.includes(agent)) ||
    !validHashes(state.fileHashes) ||
    (state.pendingFileHashes !== undefined && !validHashes(state.pendingFileHashes))
  ) {
    throw new Error('Invalid private agent inventory; expected version 1, known agents and safe file baselines.')
  }
  return state as unknown as LocalAgentState
}

async function persistLocal(git: GitAgentScope, before: LocalAgentState, next: LocalAgentState): Promise<boolean> {
  if (JSON.stringify(await readLocalState(git)) !== JSON.stringify(before)) throw new Error('Private agent inventory changed concurrently; retry with current configuration.')
  if (JSON.stringify(before) === JSON.stringify(next)) return false
  const path = statePath(git)
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${randomUUID()}.tmp`
  try {
    const file = await open(temp, 'wx', 0o600)
    try {
      await file.writeFile(JSON.stringify(next, null, 2) + '\n')
      await file.sync()
    } finally {
      await file.close()
    }
    await regularPath(git.gitDir, 'saasfoundry/agents.json', 'file', false)
    if (JSON.stringify(await readLocalState(git)) !== JSON.stringify(before)) throw new Error('Private agent inventory changed before saving; retry setup.')
    await rename(temp, path)
  } finally {
    await unlink(temp).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
    })
  }
  return true
}

/** Fail on differently cased names, even on case-insensitive filesystems. */
async function checkLocalPath(root: string, path: string): Promise<Buffer | undefined> {
  const parts = path.split('/')
  let current = root
  for (let i = 0; i < parts.length; i++) {
    const names = await readdir(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return []
      throw error
    })
    if (names.some((name) => name !== parts[i] && name.toLowerCase() === parts[i].toLowerCase())) throw new Error(`Case-colliding local target: ${path}`)
    current = join(current, parts[i])
    try {
      const stat = await lstat(current)
      if (stat.isSymbolicLink() || (i < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())) throw new Error(`Unsafe local target (link or wrong file type): ${path}`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }
  return readFile(current)
}

async function applyLocal(params: SupportParams, requested?: HarnessAgent[]): Promise<AgentSupportResult> {
  const root = resolve(params.targetPath)
  const { before, source } = await inspect(root)
  const git = await inspectGitAgentScope(root, { requireLocalSetup: true })
  const local = await readLocalState(git)
  const sharedAgents = configured(before.manifest, source)
  const localAgents = union(local.agents, requested ?? [])
  const effective = union(sharedAgents, localAgents)
  const plan = await planAgentInstructions({
    targetPath: root,
    agents: effective,
    manifest: before.manifest,
    referenceOnly:
      params.adoption || local.fileHashes['AGENTS.md'] === hash(Buffer.from(ADOPTION_COMMON_INSTRUCTIONS)) || local.fileHashes['CLAUDE.md'] === hash(Buffer.from(CODEX_SOURCE_CLAUDE_BRIDGE))
  })
  const report: AgentInstructionsReport = { written: [], unchanged: [], conflicts: [], warnings: [...plan.warnings], fileHashes: {} }
  const writable: { file: AgentInstructionFile; before?: Buffer }[] = []
  const owned: Record<string, string> = {}
  const trackedPaths = new Set(git.trackedPaths)
  const foldedTracked = new Map<string, Set<string>>()
  for (const path of trackedPaths) {
    const key = path.toLowerCase()
    const names = foldedTracked.get(key) ?? new Set<string>()
    names.add(path)
    foldedTracked.set(key, names)
  }
  const unsafeEntries = new Set(git.trackedEntries.filter((entry) => entry.stage !== 0 || entry.mode === '120000').map((entry) => entry.path))
  // Whole-plan preflight is completed before excludes, locks, inventory or any
  // discovery files are created. Tracked content is a dependency, never owned.
  for (const file of plan.files) {
    const current = await checkLocalPath(root, file.path)
    const tracked = trackedPaths.has(file.path)
    const matchingNames = foldedTracked.get(file.path.toLowerCase())
    const parts = file.path.toLowerCase().split('/')
    const aliases =
      (matchingNames !== undefined && (matchingNames.size > 1 || !matchingNames.has(file.path))) || parts.slice(0, -1).some((_, index) => foldedTracked.has(parts.slice(0, index + 1).join('/')))
    const unsafeIndex = unsafeEntries.has(file.path)
    if (aliases || unsafeIndex || (tracked && (!current || !current.equals(file.content)))) {
      report.conflicts.push(file.path)
      report.warnings.push(`${file.path}: tracked target cannot be changed by local setup; use shared scope or reconcile it first.`)
      continue
    }
    const ownedCurrent = current && (local.fileHashes[file.path] === hash(current) || local.pendingFileHashes?.[file.path] === hash(current))
    if (current?.equals(file.content)) {
      report.unchanged.push(file.path)
      if (!tracked && before.manifest.fileHashes?.[file.path] !== hash(current) && ownedCurrent) owned[file.path] = hash(current)
    } else if (current && !ownedCurrent) {
      report.conflicts.push(file.path)
      report.warnings.push(`${file.path}: existing untracked content is user-owned; local setup left the project unchanged.`)
    } else {
      writable.push({ file, before: current })
      owned[file.path] = hash(file.content)
    }
  }
  if (params.preview) {
    report.written = writable.map(({ file }) => file.path)
    report.fileHashes = owned
  }
  if (report.conflicts.length || params.preview)
    return {
      previewPlan: params.preview ? plan : undefined,
      fingerprint: hash(Buffer.from(JSON.stringify({ manifest: before.content, local, index: git.trackedEntries, head: git.headPaths, planned: planDigest(plan) }))),
      scope: 'local',
      configuredAgents: union(sharedAgents, local.agents),
      sharedAgents,
      localAgents: local.agents,
      report,
      manifestChanged: false,
      localStateChanged: false
    }
  const currentGit = await inspectGitAgentScope(root)
  if (
    JSON.stringify(currentGit.trackedEntries) !== JSON.stringify(git.trackedEntries) ||
    (await snapshot(root)).content !== before.content ||
    JSON.stringify(await readLocalState(git)) !== JSON.stringify(local)
  )
    throw new Error('Project state changed during local preflight; no setup was applied. Retry.')
  await mkdir(dirname(statePath(git)), { recursive: true })
  const lockPath = join(dirname(statePath(git)), 'agents.lock')
  const lock = await open(lockPath, 'wx', 0o600).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'EEXIST') throw new Error('Another local agent setup holds agents.lock; retry when it finishes.')
    throw error
  })
  let primaryFailure: unknown
  try {
    const verifiedPlan = await params.verify?.()
    if (verifiedPlan && planDigest(plan) !== planDigest(verifiedPlan)) throw new Error('Instruction plan changed during local preflight; generate a fresh preview.')
    const lockedGit = await inspectGitAgentScope(root)
    if (
      JSON.stringify(lockedGit.trackedEntries) !== JSON.stringify(git.trackedEntries) ||
      JSON.stringify(lockedGit.headPaths) !== JSON.stringify(git.headPaths) ||
      (await snapshot(root)).content !== before.content ||
      JSON.stringify(await readLocalState(git)) !== JSON.stringify(local)
    ) {
      throw new Error('Project state changed before acquiring the local setup lock; retry with current state.')
    }
    const noLongerOwned = Object.keys(local.fileHashes).filter((path) => !Object.prototype.hasOwnProperty.call(owned, path))
    if (Object.keys(owned).length) {
      const excludes = await configureLocalAgentExcludes(root, Object.keys(owned))
      report.warnings.push(...excludes.warnings)
    }
    // Journal expected outputs before writing: if the process stops, the next
    // attempt can identify only exact generated bytes, without adopting user files.
    // Successful fileHashes and configured agents remain unchanged until completion.
    let journal = local
    let journalChanged = false
    if (writable.length) {
      journal = { ...local, pendingFileHashes: { ...local.pendingFileHashes, ...Object.fromEntries(writable.map(({ file }) => [file.path, hash(file.content)])) } }
      journalChanged = await persistLocal(git, local, journal)
    }
    for (const item of writable) {
      const current = await checkLocalPath(root, item.file.path)
      if (item.before ? !current?.equals(item.before) : current !== undefined) throw new Error(`Local target changed after preflight: ${item.file.path}. Retry setup.`)
      await safeWriteAgentFile(root, item.file.path, item.file.content, item.file.mode, current)
      report.written.push(item.file.path)
    }
    report.fileHashes = owned
    const finalized = await persistLocal(git, journal, { version: 1, agents: localAgents, fileHashes: owned })
    if (noLongerOwned.length) {
      const cleanup = await removeLocalAgentExcludes(root, noLongerOwned)
      report.warnings.push(...cleanup.warnings)
    }
    const localStateChanged = journalChanged || finalized
    return { scope: 'local', configuredAgents: effective, sharedAgents, localAgents, report, manifestChanged: false, localStateChanged }
  } catch (error) {
    primaryFailure = error
    if (params.adoption) throw adoptionFailure('local', report, error)
    throw error
  } finally {
    await releaseLock(lock, lockPath, report, primaryFailure)
  }
}

function adoptionFailure(scope: string, report: AgentInstructionsReport, cause: unknown): Error {
  return Object.assign(new Error(`The ${scope} adoption stopped before completion. Inspect the partial report and generate a fresh preview before retrying.`), {
    report,
    recovery: 'Original instructions remain protected. Exact generated files can be reused; reconcile changed files before retry. Configuration may have been saved if only the final cleanup failed.',
    cause
  })
}

function planDigest(plan: AgentInstructionPlan): string {
  return hash(Buffer.from(JSON.stringify(plan.files.map((file) => [file.path, file.mode, hash(file.content)]))))
}

async function releaseLock(lock: Awaited<ReturnType<typeof open>>, path: string, report?: AgentInstructionsReport, primaryFailure?: unknown): Promise<void> {
  let cleanupFailure: unknown
  try {
    await lock.close()
  } catch (error) {
    cleanupFailure = error
  }
  try {
    await unlink(path)
  } catch (error) {
    cleanupFailure ??= error
  }
  if (!cleanupFailure) return
  const warning = 'Agent setup lock cleanup failed. Inspect the lock before retrying; do not remove a lock held by another running setup.'
  report?.warnings.push(warning)
  if (!primaryFailure)
    throw Object.assign(new Error(warning), {
      report,
      recovery: 'Files or inventory may already be saved; inspect the report and generate a fresh preview after resolving the lock.',
      cause: cleanupFailure
    })
}
