import { constants, type Stats } from 'fs'
import { access, lstat, open, stat } from 'fs/promises'
import { delimiter, join, resolve } from 'path'

import { AGENT_REGISTRY_VERSION, getAgentIds, getAgentProfile, type HarnessAgent } from './agent-registry'

export type DiagnosticStatus = 'supported' | 'unavailable' | 'not-checked' | 'failed'

export interface DiagnosticCheck {
  id: string
  status: DiagnosticStatus
  summary: string
  remediation?: string
}

export interface AgentDiagnostic {
  id: HarnessAgent
  checks: DiagnosticCheck[]
}

export interface AgentDiagnosticsReport {
  version: 1
  registryVersion: number
  checks: DiagnosticCheck[]
  agents: AgentDiagnostic[]
  initialization: string[]
}

export interface CollectAgentDiagnosticsOptions {
  agents?: string[]
  checkRuntime?: boolean
}

type ExpectedKind = 'file' | 'directory'

interface PathMetadata {
  state: 'present' | 'missing' | 'failed'
  mode?: number
  dev?: number
  ino?: number
  detail?: 'symbolic-link' | 'wrong-type' | 'unreadable'
}

interface ManifestEvidence {
  check: DiagnosticCheck
  sharedAgents?: HarnessAgent[]
  sharedAgentsValid: boolean
  workflow: DiagnosticCheck
}

interface AgentArtifacts {
  skills: string
  hooks?: string
  runtime?: string
}

const MAX_MANIFEST_BYTES = 512 * 1024
const MAX_PATH_BYTES = 64 * 1024
const MAX_PATH_ENTRIES = 256

/**
 * Paths and executable names are trusted code literals. The declarative registry
 * deliberately cannot add commands or arbitrary paths.
 */
const ARTIFACTS: Record<HarnessAgent, AgentArtifacts> = {
  'claude-code': { skills: '.claude/skills', hooks: '.claude/settings.json', runtime: 'claude' },
  codex: { skills: '.agents/skills', hooks: '.codex/config.toml', runtime: 'codex' },
  kimi: { skills: '.agents/skills', runtime: 'kimi' },
  'gemini-cli': { skills: '.agents/skills', hooks: '.gemini/settings.json', runtime: 'gemini' },
  'qwen-code': { skills: '.agents/skills', runtime: 'qwen' },
  generic: { skills: '.agents/skills' }
}

const INITIALIZATION = [
  'Start a fresh session at the project root. Read the selected instruction file and all its references, then .saasfoundry.json for workflow, SRS and language. Verify what the host loaded; file presence alone is not native discovery.',
  'Run `sf status --agent-friendly --no-network` and resolve its failing preconditions before work. Its hook-compatible exit code is zero even when checks fail; read the report. The legacy --claude-friendly alias remains supported.',
  'Read applicable SKILL.md procedures explicitly when native discovery is not verified. Reference-only adoption may retain the original skill directory; do not copy or replace custom skills to satisfy a missing-directory check.',
  'Before a workflow transition, read the matching sf-workflow status document and use the existing guarded workflow CLI selected by project instructions. Known locations are .claude/skills/sf-workflow/workflow-cli.sh and .agents/skills/sf-workflow/workflow-cli.sh. Resolve missing scripts with `sf workflow`, never direct board mutations.',
  'Verify provider authentication and configured board/SRS access through the existing connectors and credential resolvers. Repository and Projects permissions require separate verification. Respect host sandbox, network and approval controls; diagnostics do not grant access.',
  'Verify required hook events in the actual host. Until verified, repeat this initialization manually each session and explicitly apply the project SRS/workflow procedures when their triggers occur.',
  'Use native delegation only when available and authorized. Verify child instructions and skill context. Otherwise disclose sequential fallback for eligible work. Sequential self-review is not independent review: keep a required review incomplete in AI testing until a separate authorized agent context or independent human reviewer performs it.'
]

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

function errorCode(error: unknown): string | undefined {
  return object(error) && typeof error.code === 'string' ? error.code : undefined
}

async function assertProjectRoot(root: string): Promise<Stats> {
  let rootStat
  try {
    rootStat = await lstat(root)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') throw new Error('Agent diagnostics require an existing regular project directory.')
    throw new Error('Unable to inspect the project directory for agent diagnostics.')
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error('Agent diagnostics require a regular project directory, not a symbolic link or file.')
  return rootStat
}

/** Inspect path metadata without following links inside the project. */
async function inspectPath(root: string, relativePath: string, expected: ExpectedKind): Promise<PathMetadata> {
  let current = root
  const parts = relativePath.split('/')
  for (let index = 0; index < parts.length; index++) {
    current = join(current, parts[index])
    let pathStat
    try {
      pathStat = await lstat(current)
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return { state: 'missing' }
      return { state: 'failed', detail: 'unreadable' }
    }
    if (pathStat.isSymbolicLink()) return { state: 'failed', detail: 'symbolic-link' }
    const isLeaf = index === parts.length - 1
    if (!isLeaf && !pathStat.isDirectory()) return { state: 'failed', detail: 'wrong-type' }
    if (isLeaf) {
      const matches = expected === 'file' ? pathStat.isFile() : pathStat.isDirectory()
      if (!matches) return { state: 'failed', detail: 'wrong-type' }
      return { state: 'present', mode: pathStat.mode & 0o777, dev: pathStat.dev, ino: pathStat.ino }
    }
  }
  return { state: 'failed', detail: 'unreadable' }
}

function metadataCheck(id: string, relativePath: string, expected: ExpectedKind, metadata: PathMetadata): DiagnosticCheck {
  const label = expected === 'file' ? 'file' : 'directory'
  if (metadata.state === 'present') return { id, status: 'supported', summary: `${relativePath} is present as a regular ${label}; loading was not verified.` }
  if (metadata.state === 'missing') {
    return {
      id,
      status: 'unavailable',
      summary: `${relativePath} is absent.`,
      remediation: `Install or restore the expected ${relativePath} artifact, then run diagnostics again.`
    }
  }
  const reason = metadata.detail === 'symbolic-link' ? 'contains a symbolic link' : metadata.detail === 'wrong-type' ? `is not a regular ${label}` : 'could not be inspected'
  return {
    id,
    status: 'failed',
    summary: `${relativePath} ${reason}; no contents were read.`,
    remediation: `Replace ${relativePath} with the expected regular ${label} inside the project before retrying.`
  }
}

async function inspectArtifact(root: string, id: string, relativePath: string, expected: ExpectedKind): Promise<DiagnosticCheck> {
  return metadataCheck(id, relativePath, expected, await inspectPath(root, relativePath, expected))
}

function invalidManifest(summary: string): ManifestEvidence {
  return {
    check: {
      id: 'project.manifest',
      status: 'failed',
      summary,
      remediation: 'Repair .saasfoundry.json, then run agent diagnostics again.'
    },
    sharedAgentsValid: false,
    workflow: {
      id: 'workflow.configuration',
      status: 'not-checked',
      summary: 'Workflow configuration was not checked because the manifest diagnostic fields are invalid.',
      remediation: 'Repair .saasfoundry.json and configure a workflow with `sf workflow`.'
    }
  }
}

function workflowCheck(manifest: Record<string, unknown>): DiagnosticCheck {
  if (manifest.workflow === undefined) {
    return {
      id: 'workflow.configuration',
      status: 'unavailable',
      summary: 'No workflow configuration is declared in .saasfoundry.json.',
      remediation: 'Run `sf workflow` to configure the project workflow.'
    }
  }
  if (!object(manifest.workflow)) {
    return {
      id: 'workflow.configuration',
      status: 'failed',
      summary: 'The workflow diagnostic fields in .saasfoundry.json are malformed.',
      remediation: 'Repair the workflow configuration, then run agent diagnostics again.'
    }
  }
  const tool = manifest.workflow.tool
  if (tool === undefined || tool === 'none') {
    return {
      id: 'workflow.configuration',
      status: 'unavailable',
      summary: 'No workflow tool is configured in .saasfoundry.json.',
      remediation: 'Run `sf workflow` to configure the project workflow.'
    }
  }
  if (typeof tool !== 'string' || !['github-projects', 'jira', 'notion', 'linear'].includes(tool)) {
    return {
      id: 'workflow.configuration',
      status: 'failed',
      summary: 'The workflow tool diagnostic field in .saasfoundry.json is malformed or unsupported.',
      remediation: 'Repair the workflow configuration, then run agent diagnostics again.'
    }
  }
  return { id: 'workflow.configuration', status: 'supported', summary: 'The manifest declares a workflow tool; its availability, authentication and guard execution were not checked.' }
}

function sharedAgentEvidence(manifest: Record<string, unknown>): { valid: boolean; agents?: HarnessAgent[] } {
  if (manifest.modules === undefined) return { valid: true }
  if (!object(manifest.modules)) return { valid: false }
  const harness = manifest.modules.harness
  if (harness === undefined) return { valid: true }
  if (!object(harness) || !Number.isInteger(harness.version) || Number(harness.version) < 0) return { valid: false }
  const agents = harness.agents
  if (agents === undefined) return { valid: true }
  if (!Array.isArray(agents) || agents.length === 0 || agents.some((agent) => typeof agent !== 'string' || !getAgentIds().includes(agent as HarnessAgent))) return { valid: false }
  return { valid: true, agents: [...new Set(agents)] as HarnessAgent[] }
}

async function inspectManifest(root: string, rootSnapshot: Stats): Promise<ManifestEvidence> {
  const path = '.saasfoundry.json'
  const metadata = await inspectPath(root, path, 'file')
  if (metadata.state === 'missing') {
    return {
      check: {
        id: 'project.manifest',
        status: 'unavailable',
        summary: '.saasfoundry.json is absent; agent artifacts can still be inspected.',
        remediation: 'Configure the project with `sf workflow` before relying on managed workflow prerequisites.'
      },
      sharedAgentsValid: false,
      workflow: {
        id: 'workflow.configuration',
        status: 'not-checked',
        summary: 'Workflow configuration was not checked because .saasfoundry.json is absent.',
        remediation: 'Configure the project with `sf workflow`.'
      }
    }
  }
  if (metadata.state === 'failed') return invalidManifest(`.saasfoundry.json ${metadata.detail === 'symbolic-link' ? 'is a symbolic link' : 'is not a readable regular file'}; no contents were read.`)

  let handle
  try {
    handle = await open(join(root, path), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    const fileStat = await handle.stat()
    const [currentRoot, currentLeaf] = await Promise.all([lstat(root), lstat(join(root, path))])
    if (
      !fileStat.isFile() ||
      fileStat.dev !== metadata.dev ||
      fileStat.ino !== metadata.ino ||
      currentRoot.isSymbolicLink() ||
      !currentRoot.isDirectory() ||
      currentRoot.dev !== rootSnapshot.dev ||
      currentRoot.ino !== rootSnapshot.ino ||
      currentLeaf.isSymbolicLink() ||
      !currentLeaf.isFile() ||
      currentLeaf.dev !== fileStat.dev ||
      currentLeaf.ino !== fileStat.ino
    )
      return invalidManifest('The manifest or project directory changed during inspection; no contents were read. Retry from a stable checkout.')
    if (fileStat.size > MAX_MANIFEST_BYTES) return invalidManifest(`.saasfoundry.json exceeds the ${MAX_MANIFEST_BYTES}-byte diagnostics limit; no contents were read.`)
    const buffer = Buffer.alloc(MAX_MANIFEST_BYTES + 1)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length)
      if (!bytesRead) break
      length += bytesRead
    }
    if (length > MAX_MANIFEST_BYTES) return invalidManifest('The manifest exceeded the bounded diagnostics read limit; no contents were reported.')
    const text = buffer.toString('utf8', 0, length)
    let manifest: unknown
    try {
      manifest = JSON.parse(text)
    } catch {
      return invalidManifest('.saasfoundry.json is not valid JSON.')
    }
    if (!object(manifest)) return invalidManifest('.saasfoundry.json must contain a JSON object.')
    if (
      typeof manifest.version !== 'string' ||
      !manifest.version ||
      typeof manifest.projectName !== 'string' ||
      !manifest.projectName ||
      typeof manifest.structure !== 'string' ||
      !['cli', 'monorepo', 'multirepo'].includes(manifest.structure)
    ) {
      return invalidManifest('The manifest requires version, projectName and a supported project structure.')
    }
    const shared = sharedAgentEvidence(manifest)
    if (!shared.valid) return { ...invalidManifest('The harness agent diagnostic fields in .saasfoundry.json are malformed.'), workflow: workflowCheck(manifest) }
    return {
      check: { id: 'project.manifest', status: 'supported', summary: '.saasfoundry.json is a bounded regular JSON manifest; unrelated fields were not reported.' },
      sharedAgents: shared.agents,
      sharedAgentsValid: true,
      workflow: workflowCheck(manifest)
    }
  } catch {
    return invalidManifest('.saasfoundry.json could not be opened safely; no contents were reported.')
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

async function workflowGuardCheck(root: string, id: string, relativePath: string): Promise<DiagnosticCheck> {
  const metadata = await inspectPath(root, relativePath, 'file')
  if (metadata.state !== 'present') {
    const check = metadataCheck(id, relativePath, 'file', metadata)
    if (metadata.state === 'missing')
      check.remediation =
        'Use the existing guarded CLI named by project instructions; these locations are alternatives and require no duplicate copies. If no guarded CLI exists, configure the workflow with `sf workflow` before transitions.'
    return check
  }
  if (((metadata.mode ?? 0) & 0o111) === 0) {
    return {
      id,
      status: 'unavailable',
      summary: `${relativePath} is a regular file but is not executable; it was not run.`,
      remediation: `Restore executable permissions on ${relativePath}, then verify the guarded CLI in the actual host.`
    }
  }
  return { id, status: 'supported', summary: `${relativePath} is present and executable by mode metadata; it was not run.` }
}

async function runtimePathCheck(command: string | undefined, enabled: boolean): Promise<DiagnosticCheck> {
  if (!enabled) {
    return {
      id: 'runtime.path',
      status: 'not-checked',
      summary: 'Executable-name availability on PATH was not requested.',
      remediation: 'Run `sf agents doctor --check-runtime` for a filesystem-only PATH check.'
    }
  }
  if (!command) {
    return {
      id: 'runtime.path',
      status: 'not-checked',
      summary: 'This profile has no trusted executable name for a PATH metadata check.',
      remediation: 'Verify the selected coding-agent runtime directly in its actual host.'
    }
  }
  if (process.platform === 'win32') {
    return {
      id: 'runtime.path',
      status: 'not-checked',
      summary: 'Windows executable-extension discovery is not implemented; no runtime availability was inferred.',
      remediation: 'Verify the runtime in the actual Windows host.'
    }
  }
  const pathValue = process.env.PATH ?? ''
  if (Buffer.byteLength(pathValue) > MAX_PATH_BYTES || pathValue.split(delimiter).length > MAX_PATH_ENTRIES) {
    return {
      id: 'runtime.path',
      status: 'not-checked',
      summary: 'PATH exceeds the bounded diagnostics lookup limit; runtime availability was not inferred.',
      remediation: 'Use a smaller PATH or verify the runtime in its actual host.'
    }
  }
  const entries = pathValue.split(delimiter).filter(Boolean)
  for (const entry of entries) {
    const candidate = resolve(entry, command)
    try {
      const [candidateStat] = await Promise.all([stat(candidate), access(candidate, constants.X_OK)])
      if (candidateStat.isFile()) {
        return {
          id: 'runtime.path',
          status: 'supported',
          summary: `Executable name ${command} is available on PATH by filesystem metadata; it was not invoked and host functionality was not verified.`
        }
      }
    } catch {
      // Missing, inaccessible and non-executable candidates are all simply unavailable.
    }
  }
  return {
    id: 'runtime.path',
    status: 'unavailable',
    summary: `Executable name ${command} is not available on PATH by filesystem metadata; no binary was invoked.`,
    remediation: `Install or expose ${command} on PATH, then verify the coding-agent runtime directly in its actual host.`
  }
}

function nativeChecks(agent: HarnessAgent): DiagnosticCheck[] {
  const profile = getAgentProfile(agent)
  const instructionSupport = profile.instructions === 'documented' ? 'Registry sources document instruction discovery' : 'The profile requires manual instruction loading'
  const skillSupport =
    profile.skills === 'documented'
      ? 'Registry sources document skill discovery'
      : profile.skills === 'manual'
        ? 'The profile requires manual skill loading'
        : 'Skill discovery is not declared by the profile'
  return [
    {
      id: 'native.runtime',
      status: 'not-checked',
      summary: `${profile.displayName} was not started, so runtime functionality was not verified.`,
      remediation: 'Start a fresh session in the project root and verify the runtime in the actual host.'
    },
    {
      id: 'native.instructions',
      status: 'not-checked',
      summary: `${instructionSupport}; this command did not initialize ${profile.displayName} to verify loading.`,
      remediation: `In a fresh ${profile.displayName} session, ask which project instruction file was loaded and provide it explicitly if absent.`
    },
    {
      id: 'native.skills',
      status: 'not-checked',
      summary: `${skillSupport}; this command did not verify activation in ${profile.displayName}.`,
      remediation: 'Ask the host which project skills are active and read the applicable SKILL.md explicitly when discovery is unavailable.'
    },
    {
      id: 'native.hooks',
      status: 'not-checked',
      summary: 'Hook discovery and execution were not checked; hook-file presence is not execution evidence.',
      remediation: 'Verify required initialization hooks in the actual host and perform their documented initialization manually when unavailable.'
    },
    {
      id: 'native.authentication',
      status: 'not-checked',
      summary: 'Provider authentication and configured board/SRS access were not checked; no credential stores were inspected.',
      remediation: 'Verify provider login and configured connector access separately through existing resolvers, including repository and Projects permissions. Never copy tokens into reports.'
    },
    {
      id: 'native.tools',
      status: 'not-checked',
      summary: 'Host read, edit, shell and network tool capabilities were not checked.',
      remediation: 'Verify the required tools and approval boundaries inside the actual coding-agent host.'
    },
    {
      id: 'native.permissions',
      status: 'not-checked',
      summary: 'Filesystem, command and network permissions were not checked.',
      remediation: 'Verify the project, command and network permissions required by the task in the actual host.'
    },
    {
      id: 'native.delegation',
      status: 'not-checked',
      summary: 'Delegation support and child-task context propagation were not checked.',
      remediation: 'When native delegation is available and authorized, verify child instructions and skills. Otherwise disclose sequential fallback; it cannot satisfy a required independent review.'
    }
  ]
}

function registrationChecks(agent: HarnessAgent, manifest: ManifestEvidence): DiagnosticCheck[] {
  let shared: DiagnosticCheck
  if (!manifest.sharedAgentsValid || manifest.sharedAgents === undefined) {
    shared = {
      id: 'registration.shared',
      status: 'not-checked',
      summary: 'No valid explicit shared agent inventory was extracted from the manifest; legacy or host state was not inferred.',
      remediation: 'Use `sf agents enable <agent> --scope shared` when shared project registration is intended.'
    }
  } else if (manifest.sharedAgents.includes(agent)) {
    shared = {
      id: 'registration.shared',
      status: 'supported',
      summary: `${agent} is explicitly registered in the shared manifest inventory; runtime activation was not inferred.`
    }
  } else {
    shared = {
      id: 'registration.shared',
      status: 'unavailable',
      summary: `${agent} is not registered in the explicit shared manifest inventory.`,
      remediation: `Run \`sf agents enable ${agent} --scope shared\` if shared project support is intended.`
    }
  }
  return [
    shared,
    {
      id: 'registration.local',
      status: 'not-checked',
      summary: 'Checkout-private local agent registration was not inspected and current-host selection was not inferred.',
      remediation: `Run \`sf agents list --json\` in this checkout to inspect local registration for ${agent}.`
    }
  ]
}

async function collectAgent(root: string, agent: HarnessAgent, manifest: ManifestEvidence, checkRuntime: boolean): Promise<AgentDiagnostic> {
  const artifacts = ARTIFACTS[agent]
  const profile = getAgentProfile(agent)
  const checks: DiagnosticCheck[] = [
    ...registrationChecks(agent, manifest),
    await inspectArtifact(root, 'artifacts.instructions', profile.instructionFile, 'file'),
    await inspectArtifact(root, 'artifacts.skills', artifacts.skills, 'directory')
  ]
  const skillsCheck = checks.find((check) => check.id === 'artifacts.skills')!
  if (skillsCheck.status === 'unavailable')
    skillsCheck.remediation = 'Read the project instructions for the original skill directory. Reference-only adoption may intentionally have no copies here; read applicable procedures explicitly.'
  const hookArtifact = artifacts.hooks ? await inspectArtifact(root, 'artifacts.hooks', artifacts.hooks, 'file') : undefined
  checks.push(
    hookArtifact
      ? {
          ...hookArtifact,
          summary: `${hookArtifact.summary} Configuration metadata only; hook configuration and execution were not inspected.`,
          remediation: 'Verify hooks in the actual host; perform documented session initialization manually until verified.'
        }
      : {
          id: 'artifacts.hooks',
          status: 'not-checked',
          summary: `No bounded hook artifact path is declared for ${profile.displayName}; native hook support was not inferred.`
        }
  )
  checks.push(await runtimePathCheck(artifacts.runtime, checkRuntime), ...nativeChecks(agent))
  return { id: agent, checks }
}

/**
 * Collect bounded compatibility evidence without starting agents, running hooks,
 * invoking binaries, reading settings, or inspecting credential stores.
 */
export async function collectAgentDiagnostics(targetPath: string, options: CollectAgentDiagnosticsOptions = {}): Promise<AgentDiagnosticsReport> {
  const selected = options.agents?.length ? [...new Set(options.agents)] : getAgentIds()
  // Registry lookup provides one deterministic rejection path for model/provider names
  // and unknown tool identifiers before any project artifact is inspected.
  const agents = selected.map((agent) => getAgentProfile(agent).id)
  const root = resolve(targetPath)
  const rootSnapshot = await assertProjectRoot(root)

  const manifest = await inspectManifest(root, rootSnapshot)
  const checks: DiagnosticCheck[] = [
    { id: 'project.root', status: 'supported', summary: 'The project root was inspected as a regular directory.' },
    manifest.check,
    manifest.workflow,
    await workflowGuardCheck(root, 'workflow.guard.claude', '.claude/skills/sf-workflow/workflow-cli.sh'),
    await workflowGuardCheck(root, 'workflow.guard.agents', '.agents/skills/sf-workflow/workflow-cli.sh'),
    {
      id: 'workflow.tools',
      status: 'not-checked',
      summary: 'The guarded workflow scripts require local bash, node, git and jq tools; none were executed or functionally verified.',
      remediation: 'Verify bash, node, git and jq availability inside the actual host before running a workflow transition.'
    }
  ]
  const diagnostics: AgentDiagnostic[] = []
  for (const agent of agents) diagnostics.push(await collectAgent(root, agent, manifest, options.checkRuntime === true))
  try {
    const currentRoot = await lstat(root)
    if (currentRoot.isSymbolicLink() || !currentRoot.isDirectory() || currentRoot.dev !== rootSnapshot.dev || currentRoot.ino !== rootSnapshot.ino) throw new Error('changed')
  } catch {
    checks[0] = {
      id: 'project.root',
      status: 'failed',
      summary: 'The project directory changed during inspection; artifact observations cannot establish a stable checkout.',
      remediation: 'Retry diagnostics from a stable project directory.'
    }
  }
  return {
    version: 1,
    registryVersion: AGENT_REGISTRY_VERSION,
    checks,
    agents: diagnostics,
    initialization: [...INITIALIZATION]
  }
}
