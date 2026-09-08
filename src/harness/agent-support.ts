import { randomUUID } from 'crypto'
import { lstat, open, readFile, rename, unlink } from 'fs/promises'
import { join, resolve } from 'path'

import { AgentInstructionsReport, HarnessAgent, installAgentInstructions } from './agent-instructions'
import { harnessInstallerMeta } from '../installers/harness.installer'
import { SaaSFoundryManifest } from '../types'

const AGENTS: HarnessAgent[] = ['claude-code', 'codex', 'kimi']

export interface AgentSupportInventory {
  configuredAgents: HarnessAgent[]
  discovered: { claudeInstructions: boolean; sharedInstructions: boolean; sharedSkills: boolean }
  runtime: 'not-checked'
}

export interface AgentSupportResult {
  configuredAgents: HarnessAgent[]
  report: AgentInstructionsReport
  manifestChanged: boolean
}

interface SupportParams {
  targetPath: string
  scope?: string
}
interface ManifestSnapshot {
  manifest: SaaSFoundryManifest
  content: string
  mode: number
}
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

function validateAgents(agents: unknown): asserts agents is HarnessAgent[] {
  if (!Array.isArray(agents) || agents.length === 0 || agents.some((agent) => typeof agent !== 'string' || !AGENTS.includes(agent as HarnessAgent))) {
    throw new Error('Choose coding agents: claude-code, codex, kimi. Model names and CLI installations are not agent support configurations.')
  }
}

function requireSharedScope(scope?: string): void {
  if (scope !== 'shared') throw new Error('Agent setup currently requires explicit --scope shared. Local scope is not available yet; no project files were changed.')
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

function configured(manifest: SaaSFoundryManifest): HarnessAgent[] {
  // Legacy managed harnesses already provide Claude instruction discovery.
  return [...new Set(manifest.modules?.harness?.agents ?? ['claude-code'])] as HarnessAgent[]
}

async function inspect(root: string): Promise<{ before: ManifestSnapshot; discovered: AgentSupportInventory['discovered'] }> {
  const before = await snapshot(root)
  await regularPath(root, 'CLAUDE.md', 'file')
  await regularPath(root, '.claude/skills', 'directory')
  const sharedInstructions = await regularPath(root, 'AGENTS.md', 'file', false)
  const sharedSkills = await regularPath(root, '.agents/skills', 'directory', false)
  return { before, discovered: { claudeInstructions: true, sharedInstructions, sharedSkills } }
}

export async function readAgentSupport(targetPath: string): Promise<AgentSupportInventory> {
  const { before, discovered } = await inspect(resolve(targetPath))
  return { configuredAgents: configured(before.manifest), discovered, runtime: 'not-checked' }
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
  requireSharedScope(params.scope)
  const root = resolve(params.targetPath)
  const { before } = await inspect(root)
  const lockPath = join(root, '.saasfoundry.agents.lock')
  let lock
  try {
    lock = await open(lockPath, 'wx', 0o600)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw new Error('Another agent setup holds .saasfoundry.agents.lock. Wait for it to finish; if interrupted, inspect that lock before retrying.')
    throw error
  }
  try {
    // Cooperating enables cannot overwrite each other; external manifest edits are
    // checked again before saving. No installer, hooks, Git commands or credentials.
    if ((await snapshot(root)).content !== before.content) throw new Error('Manifest changed before agent setup; retry with the current configuration.')
    const previous = configured(before.manifest)
    const candidates = AGENTS.filter((agent) => previous.includes(agent) || requested?.includes(agent))
    const report = await installAgentInstructions({ targetPath: root, agents: candidates, manifest: before.manifest })
    const configuredAgents = report.conflicts.length ? previous : candidates
    const next: SaaSFoundryManifest = { ...before.manifest }
    if (!report.conflicts.length) {
      next.modules = {
        ...before.manifest.modules,
        harness: {
          ...before.manifest.modules?.harness,
          version: before.manifest.modules?.harness?.version ?? harnessInstallerMeta.currentVersion,
          agents: configuredAgents
        }
      }
    }
    if (Object.keys(report.fileHashes).length) next.fileHashes = { ...before.manifest.fileHashes, ...report.fileHashes }
    const manifestChanged = await persist(root, before, next)
    return { configuredAgents, report, manifestChanged }
  } finally {
    await lock.close()
    await unlink(lockPath)
  }
}

export async function enableAgents(params: SupportParams & { agents: string[] }): Promise<AgentSupportResult> {
  requireSharedScope(params.scope)
  validateAgents(params.agents)
  return apply(params, params.agents)
}

export async function refreshAgents(params: SupportParams): Promise<AgentSupportResult> {
  return apply(params)
}
