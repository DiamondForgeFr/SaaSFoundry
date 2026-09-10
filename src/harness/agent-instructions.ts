import { createHash } from 'crypto'
import { lstat, readFile, readdir } from 'fs/promises'
import { join, posix, resolve } from 'path'

import { safeWriteAgentFile } from './agent-file-writer'
import { getAgentProfile } from './agent-registry'
import { HarnessAgent, skillsTemplatesPath } from '../types'
import { hashFileContent } from '../utils'

const hashBytes = (content: Buffer): string => createHash('sha256').update(content).digest('hex')

export type { HarnessAgent } from '../types'

export interface AgentInstructionsReport {
  written: string[]
  unchanged: string[]
  conflicts: string[]
  warnings: string[]
  /** Baselines for successfully installed files only; merge these into the manifest. */
  fileHashes: Record<string, string>
}

export class AgentInstructionsError extends Error {
  readonly cause: unknown
  readonly report: AgentInstructionsReport

  constructor(path: string, report: AgentInstructionsReport, cause: unknown) {
    super(`Failed to install ${path}. Inspect the destination and the partial report, then retry the agent instruction installation.`)
    this.name = 'AgentInstructionsError'
    this.cause = cause
    this.report = report
  }
}

export interface InstallAgentInstructionsParams {
  targetPath: string
  agents: HarnessAgent[]
  manifest?: { fileHashes?: Record<string, string> }
  /** Adoption references source instructions without copying or normalizing skills. */
  referenceOnly?: boolean
}

const WORKTREE_ORCHESTRATION = `## Parallel implementation and Git worktrees

Propose parallel worktrees only when the user's request contains independent writing streams
that can be delivered concurrently. Read-only exploration and review may use parallel agents
without separate worktrees. Work with sequential dependencies, overlapping file ownership or
unclear boundaries must use one feature worktree and sequential execution.

Before proposing parallel implementation, read \`.saasfoundry.json\` and use
\`workflow.workingBranch\`; never hardcode a branch name. Keep the primary checkout on that
configured working branch. Do not let feature workers write in the primary checkout while
parallel worktrees are active.

For each independent writing stream, define one ticket, branch and worktree path, plus its owned
files and dependency boundary. Start from a synchronized configured working branch. Each worker
must stay inside its assigned worktree and ownership boundary, preserve other agents' changes
and never revert unrelated work. The agent proposes this execution shape; the user retains
control when parallel implementation was not already authorized. If authorization, clean
separation, Git support or a synchronized base is unavailable, explain the constraint and use
one worktree or sequential execution.

After each stream is complete, commit and push through the configured workflow. After its merge,
return to the primary checkout, check out and synchronize the configured working branch, verify
the merge, then remove the completed worktree and local branch only when they are merged and no
longer in use. Never remove or overwrite user-owned worktrees, branches, uncommitted changes,
stashes or credentials implicitly.
`

const CAPABILITIES = `## Execution capabilities

Use the current agent's native tools for reading, editing, shell commands and delegation.
When delegation is available and authorized, assign independent work to agents; otherwise
execute the same steps sequentially. A sequential self-review is not an independent review:
report that limitation and retain any required human review. Tool names in legacy examples
describe capabilities, not required APIs. Use the user's current request as skill arguments.
Do not assume Claude Code hooks, model selection, tool permissions or credentials transfer.
Run preconditions explicitly, and stop to report a missing capability when no equivalent exists.
Never bypass CLI guards, required approvals, tests or workflow status exit conditions.
The project manifest and workflow rules take precedence over generic skill examples,
including branch names, commit formats, staging, pushing and approval requirements.
Legacy /task examples name roles: use native delegation if available and authorized,
or perform the role's work sequentially with the review limitation stated above.

${WORKTREE_ORCHESTRATION}
`

export const COMMON_INSTRUCTIONS = `# SaaSFoundry agent instructions

Read \`CLAUDE.md\` in this project before working: it remains the authoritative project
instructions during this additive compatibility phase. Read files that it references as well.
This preserves the existing project rules and developer customizations without duplicating them.
Do not rewrite paths to \`.claude/\`: the existing guarded scripts and docs remain there.

Read \`.saasfoundry.json\` and run \`sf status --claude-friendly --no-network\` before
asking about configured scope, tools or modules. Follow its output language and workflow.
Discover shared skills under \`.agents/skills/sf-*/SKILL.md\`. Before a status transition,
read the matching status document and execute the existing workflow CLI:
\`.claude/skills/sf-workflow/workflow-cli.sh\`. Use its configured board tool, not raw mutations.
Commit and push before AI testing; preserve Human testing requirements. Delivery tickets
need a verified merge before Done, except for a validated \`nature:bundled-pr\` child whose
commit ships in its non-Epic delivery parent's PR. An Epic has no PR: its first child entering
In progress starts it, and it reaches Done only after every native child has board status Done.

${CAPABILITIES}`

export const CODEX_SOURCE_CLAUDE_BRIDGE = `# SaaSFoundry Claude compatibility instructions

@AGENTS.md

Read \`AGENTS.md\` as the authoritative project instructions and follow every file it
references. Claude Code must load applicable procedures manually from
\`.agents/skills/*/SKILL.md\`; do not copy skills into \`.claude/skills\`.

${CAPABILITIES}
Do not copy or change agent settings, hooks, permissions, credentials, secrets or models.
`

export const ADOPTION_COMMON_INSTRUCTIONS = `# SaaSFoundry agent adoption instructions

Read \`CLAUDE.md\` in this project before working: it remains the authoritative project
instructions. Read every file it references. Load applicable procedures manually from
\`.claude/skills/*/SKILL.md\`; do not copy or normalize them into another skill directory.

Read \`.saasfoundry.json\` and run \`sf status --claude-friendly --no-network\` before
asking about configured scope, tools or modules. Follow its output language and workflow.
Before a status transition, read the matching status document and execute the guarded CLI:
\`.claude/skills/sf-workflow/workflow-cli.sh\`. Use its configured board tool and preserve
all workflow guards, tests and approval requirements.

${CAPABILITIES}
Do not copy or change agent settings, hooks, permissions, credentials, secrets or models.
`

export interface InstructionSourceReport {
  source: 'claude' | 'codex' | 'mixed' | 'missing'
  claudeInstructions: boolean
  sharedInstructions: boolean
}

/** Refuse links in destinations, including linked ancestor directories. */
async function hasLinkedAncestor(root: string, relativePath: string): Promise<boolean> {
  let current = resolve(root)
  for (const part of relativePath.split('/')) {
    current = join(current, part)
    try {
      if ((await lstat(current)).isSymbolicLink()) return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
  }
  return false
}

async function readInstructionFile(root: string, path: 'CLAUDE.md' | 'AGENTS.md'): Promise<Buffer | undefined> {
  if (await hasLinkedAncestor(root, path)) throw new Error(`${path}: symbolic links are not allowed while inspecting instruction sources.`)
  const fullPath = join(root, path)
  try {
    const stat = await lstat(fullPath)
    if (!stat.isFile()) throw new Error(`${path}: expected a regular instruction file.`)
    return await readFile(fullPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

interface InspectedInstructionSource {
  report: InstructionSourceReport
  referenceOnly: boolean
}

async function inspectInstructionFiles(targetPath: string): Promise<InspectedInstructionSource> {
  const [claude, shared] = await Promise.all([readInstructionFile(targetPath, 'CLAUDE.md'), readInstructionFile(targetPath, 'AGENTS.md')])
  const claudeInstructions = claude !== undefined
  const sharedInstructions = shared !== undefined
  const generatedClaudeBridge = claude?.equals(Buffer.from(CODEX_SOURCE_CLAUDE_BRIDGE)) ?? false
  const generatedAdoptionBridge = shared?.equals(Buffer.from(ADOPTION_COMMON_INSTRUCTIONS)) ?? false
  const generatedSharedBridge = generatedAdoptionBridge || (shared?.equals(Buffer.from(COMMON_INSTRUCTIONS)) ?? false)

  if (generatedClaudeBridge && generatedSharedBridge) {
    throw new Error('CLAUDE.md and AGENTS.md form a generated instruction cycle; reconcile the authoritative instructions before retrying.')
  }
  if (generatedClaudeBridge && !sharedInstructions) {
    throw new Error('CLAUDE.md is a dangling generated bridge because AGENTS.md is missing; restore or reconcile the authoritative instructions before retrying.')
  }
  if (generatedSharedBridge && !claudeInstructions) {
    throw new Error('AGENTS.md is a dangling generated bridge because CLAUDE.md is missing; restore or reconcile the authoritative instructions before retrying.')
  }

  let source: InstructionSourceReport['source']
  if (!claudeInstructions && !sharedInstructions) source = 'missing'
  else if (generatedClaudeBridge || (!claudeInstructions && sharedInstructions)) source = 'codex'
  else if (generatedSharedBridge || (claudeInstructions && !sharedInstructions)) source = 'claude'
  else source = 'mixed'
  return { report: { source, claudeInstructions, sharedInstructions }, referenceOnly: generatedAdoptionBridge }
}

/** Identify the authoritative root without following links or interpreting user text. */
export async function inspectInstructionSource(targetPath: string): Promise<InstructionSourceReport> {
  return (await inspectInstructionFiles(targetPath)).report
}

/**
 * An untracked existing file is user-owned, unlike writeMigratedFile's new-file
 * case. Preserve it and any existing reconciliation sidecar instead of replacing it.
 */
async function deposit(root: string, path: string, content: Buffer, mode: number, baselines: Record<string, string>, report: AgentInstructionsReport): Promise<void> {
  if (await hasLinkedAncestor(root, path)) {
    report.conflicts.push(path)
    report.warnings.push(`${path}: symbolic link destination left untouched.`)
    return
  }
  const fullPath = join(root, path)
  let current: Buffer | undefined
  try {
    const stat = await lstat(fullPath)
    if (!stat.isFile()) {
      report.conflicts.push(path)
      report.warnings.push(`${path}: destination is not a regular file.`)
      return
    }
    current = await readFile(fullPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const hash = hashBytes(content)
  if (current?.equals(content)) {
    report.unchanged.push(path)
    report.fileHashes[path] = hash
    return
  }
  if (current && (!baselines[path] || hashBytes(current) !== baselines[path])) {
    report.conflicts.push(path)
    const sidecar = `${path}.saasfoundry.new`
    if (await hasLinkedAncestor(root, sidecar)) {
      report.warnings.push(`${path}: conflict; symbolic link sidecar left untouched.`)
      return
    }
    try {
      await safeWriteAgentFile(root, sidecar, content, mode)
      report.warnings.push(`${path}: user content preserved; reconcile ${sidecar}.`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      report.warnings.push(`${path}: user content and existing ${sidecar} preserved; sidecar may be stale.`)
    }
    return
  }
  await safeWriteAgentFile(root, path, content, mode, current)
  report.written.push(path)
  report.fileHashes[path] = hash
}

function normalizeSkill(content: string, name: string, path: string, warnings: string[]): string | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content)
  if (!match && content.startsWith('---')) {
    warnings.push(`${path}: malformed frontmatter; skill not installed.`)
    return undefined
  }
  // Serialize a narrow discovery schema instead of carrying host-specific YAML
  // (including malformed or duplicate fields) into another agent's parser.
  const fallback = `SaaSFoundry ${name.replace(/^sf-/, '').replace(/-/g, ' ')} procedures. Follow the project workflow and CLI guards.`
  const metadataLines = match?.[1].split(/\r?\n/) ?? []
  const descriptionIndex = metadataLines.findIndex((line) => /^description:/.test(line))
  let description = descriptionIndex >= 0 ? metadataLines[descriptionIndex].slice('description:'.length).trim() : ''
  if (!description || /^[|>][-+]?$/.test(description)) {
    const continuation: string[] = []
    for (let index = descriptionIndex + 1; descriptionIndex >= 0 && index < metadataLines.length && /^[ \t]+\S/.test(metadataLines[index]); index++) {
      continuation.push(metadataLines[index].trim())
    }
    description = continuation.join(' ')
  }
  if (!description) description = fallback
  const common = [`name: ${name}`, `description: ${JSON.stringify(description)}`]
  if (description === fallback) warnings.push(`${path}: generated discovery metadata for a legacy skill.`)
  if (match) {
    for (const field of match[1].matchAll(/^([\w-]+):/gm)) {
      if (!['name', 'description'].includes(field[1])) warnings.push(`${path}: omitted frontmatter '${field[1]}'; native configuration is unchanged.`)
    }
  }
  let body = match ? content.slice(match[0].length) : content
  body = body
    .replace(/\$ARGUMENTS\b/g, 'the current user request')
    .replace(/!`([^`]+)`/g, 'run `$1` and read its output')
    .replace(/\bPARALLEL ONLY\b/g, 'Prefer parallel delegation when available; otherwise execute sequentially')
    .replace(/`?Task`? tool/gi, 'native delegation when available (otherwise execute the same work sequentially)')
  if (/\bTask\s*\(|\bsubagent_type\b|\b(?:haiku|sonnet|opus)\b|\bclaude\s+-[a-z]|\$\{?CLAUDE_|\/(?:task|sf-)\b|SessionStart|UserPromptSubmit/i.test(body)) {
    warnings.push(`${path}: legacy model/tool-specific examples remain; translate capabilities explicitly before executing them.`)
  }
  return `---\n${common.join('\n')}\n---\n\n${CAPABILITIES}\n${body}`
}

/** The package inventory is the boundary; local caches and private files are never deposits. */
async function bundledFiles(name: string): Promise<Set<string>> {
  const candidates = [join(skillsTemplatesPath, 'core', name), join(skillsTemplatesPath, 'optional', name)]
  if (name === 'sf-workflow') candidates.push(join(skillsTemplatesPath, 'workflow'))
  if (name === 'sf-srs') candidates.push(join(skillsTemplatesPath, 'sf-srs'))
  if (name.startsWith('sf-tool-')) candidates.push(join(skillsTemplatesPath, 'tools', name.slice('sf-tool-'.length)))
  const files = new Set<string>()
  async function visit(root: string, relative = ''): Promise<void> {
    let entries
    try {
      entries = await readdir(join(root, relative), { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    for (const entry of entries) {
      const path = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isDirectory()) await visit(root, path)
      else if (entry.isFile()) files.add(path)
    }
  }
  for (const candidate of candidates) await visit(candidate)
  return files
}

function retainLegacyDocLinks(content: string, skillPath: string): string {
  return content.replace(/\]\(([^\s)]+)([^)]*)\)/g, (link, destination: string, title: string) => {
    if (!destination.startsWith('.')) return link
    const sourceTarget = posix.normalize(posix.join('.claude/skills', posix.dirname(skillPath), destination))
    if (!sourceTarget.startsWith('.claude/docs/')) return link
    const sharedDirectory = posix.join('.agents/skills', posix.dirname(skillPath))
    return `](${posix.relative(sharedDirectory, sourceTarget)}${title})`
  })
}

/**
 * Additive bridge after legacy harness deposition. No credentials, hooks, existing
 * Claude files or agent-specific settings are changed. Structural migration and
 * persisted agent selection belong to later lifecycle commands.
 */
export interface AgentInstructionFile {
  path: string
  content: Buffer
  mode: number
}
export interface AgentInstructionPlan {
  files: AgentInstructionFile[]
  warnings: string[]
}

/** Render the complete candidate set without changing the target project. */
export async function planAgentInstructions({ targetPath, agents, manifest, referenceOnly = false }: InstallAgentInstructionsParams): Promise<AgentInstructionPlan> {
  const report: AgentInstructionsReport = { written: [], unchanged: [], conflicts: [], warnings: [], fileHashes: {} }
  const plan: AgentInstructionPlan = { files: [], warnings: report.warnings }
  const profiles = [...new Set(agents)].map((agent) => getAgentProfile(agent))
  const inspected = await inspectInstructionFiles(targetPath)
  const instructionSource = inspected.report
  const effectiveReferenceOnly =
    referenceOnly ||
    inspected.referenceOnly ||
    manifest?.fileHashes?.['AGENTS.md'] === hashFileContent(ADOPTION_COMMON_INSTRUCTIONS) ||
    manifest?.fileHashes?.['CLAUDE.md'] === hashFileContent(CODEX_SOURCE_CLAUDE_BRIDGE)
  const needsShared = profiles.some((profile) => profile.sharedInstructions)
  const needsClaudeBridge = instructionSource.source === 'codex' && profiles.some((profile) => profile.id === 'claude-code')
  if (!needsShared && !needsClaudeBridge) return plan
  for (const profile of profiles) {
    const limitations =
      instructionSource.source === 'codex' && profile.id === 'claude-code' ? profile.limitations.filter((limitation) => !limitation.startsWith('Existing Claude instructions')) : profile.limitations
    report.warnings.push(...limitations.map((limitation) => `${profile.displayName}: ${limitation}`))
    if (profile.instructions === 'manual') report.warnings.push(`${profile.displayName}: Manual instruction loading is required; runtime discovery is not checked.`)
  }
  const baselines = manifest?.fileHashes ?? {}
  if (instructionSource.source === 'missing') {
    report.warnings.push('CLAUDE.md and AGENTS.md are missing: deposit or author the project instructions before installing compatibility bridges.')
    return plan
  }
  const wrappers = new Set(profiles.filter((profile) => profile.sharedInstructions && profile.instructionFile !== 'AGENTS.md').map((profile) => profile.instructionFile))
  if (instructionSource.source === 'codex') {
    if (needsClaudeBridge) plan.files.push({ path: 'CLAUDE.md', content: Buffer.from(CODEX_SOURCE_CLAUDE_BRIDGE), mode: 0o644 })
    for (const path of wrappers) plan.files.push({ path, content: Buffer.from('# SaaSFoundry shared instructions\n\n@AGENTS.md\n'), mode: 0o644 })
    return plan
  }
  if (instructionSource.source === 'mixed') {
    report.warnings.push('CLAUDE.md and AGENTS.md both contain custom instructions. Reconcile their authority manually; AGENTS.md will be reported as a normal conflict.')
  }
  plan.files.push({ path: 'AGENTS.md', content: Buffer.from(effectiveReferenceOnly ? ADOPTION_COMMON_INSTRUCTIONS : COMMON_INSTRUCTIONS), mode: 0o644 })
  for (const path of wrappers) {
    plan.files.push({ path, content: Buffer.from('# SaaSFoundry shared instructions\n\n@AGENTS.md\n'), mode: 0o644 })
  }
  if (effectiveReferenceOnly) return plan
  const source = '.claude/skills'
  if (await hasLinkedAncestor(targetPath, source)) {
    report.warnings.push(`${source}: symbolic link source skipped; use regular installed harness files.`)
    return plan
  }
  let skills
  try {
    skills = await readdir(join(targetPath, source), { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    report.warnings.push(`${source}: no installed compatibility skills found.`)
    return plan
  }
  for (const skill of skills.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!skill.name.startsWith('sf-')) continue
    if (!skill.isDirectory()) {
      report.warnings.push(`${source}/${skill.name}: non-directory or symbolic link skill skipped.`)
      continue
    }
    const inventory = await bundledFiles(skill.name)
    if (!inventory.has('SKILL.md')) {
      report.warnings.push(`${source}/${skill.name}: no bundled file inventory; custom skill left untouched.`)
      continue
    }
    const skillPath = `${source}/${skill.name}/SKILL.md`
    if (await hasLinkedAncestor(targetPath, skillPath)) {
      report.warnings.push(`${skillPath}: symbolic link skill skipped.`)
      continue
    }
    let original
    try {
      original = await readFile(join(targetPath, skillPath), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      report.warnings.push(`${skillPath}: missing skill entry point; skipped.`)
      continue
    }
    if (baselines[skillPath] && baselines[skillPath] !== hashFileContent(original)) {
      report.warnings.push(`${skillPath}: customized source preserved; review its generated shared adaptation.`)
    }
    const normalized = normalizeSkill(original, skill.name, skillPath, report.warnings)
    if (!normalized) continue
    const copyTree = async (relativePath: string): Promise<void> => {
      const entries = await readdir(join(targetPath, source, relativePath), { withFileTypes: true })
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        const rel = `${relativePath}/${entry.name}`
        if (entry.isSymbolicLink() || entry.name.startsWith('.') || /\.(pem|key|p12)$/i.test(entry.name) || /^(credentials|node_modules)$/i.test(entry.name)) {
          report.warnings.push(`${source}/${rel}: link, private file or dependency directory skipped.`)
          continue
        }
        if (entry.isDirectory()) await copyTree(rel)
        else if (entry.isFile()) {
          if (!inventory.has(rel.slice(skill.name.length + 1))) {
            report.warnings.push(`${source}/${rel}: not in the bundled file inventory; skipped.`)
            continue
          }
          const sourcePath = join(targetPath, source, rel)
          let content = rel === `${skill.name}/SKILL.md` ? Buffer.from(normalized) : await readFile(sourcePath)
          if (rel.endsWith('.md')) content = Buffer.from(retainLegacyDocLinks(content.toString('utf8'), rel))
          plan.files.push({ path: `.agents/skills/${rel}`, content, mode: (await lstat(sourcePath)).mode & 0o777 })
        }
      }
    }
    await copyTree(skill.name)
  }
  return plan
}

export async function installAgentInstructions(params: InstallAgentInstructionsParams): Promise<AgentInstructionsReport> {
  const plan = await planAgentInstructions(params)
  return installPlannedAgentInstructions(params.targetPath, plan, params.manifest?.fileHashes)
}

/** Apply an already reviewed render without inspecting or rendering the source again. */
export async function installPlannedAgentInstructions(targetPath: string, plan: AgentInstructionPlan, baselines: Record<string, string> = {}): Promise<AgentInstructionsReport> {
  const report: AgentInstructionsReport = { written: [], unchanged: [], conflicts: [], warnings: [...plan.warnings], fileHashes: {} }
  for (const file of plan.files) {
    try {
      await deposit(targetPath, file.path, file.content, file.mode, baselines, report)
    } catch (error) {
      throw new AgentInstructionsError(file.path, report, error)
    }
  }
  return report
}
