import { createHash } from 'crypto'
import { lstat, mkdir, readFile, readdir, writeFile } from 'fs/promises'
import { dirname, join, posix, resolve } from 'path'

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

export interface InstallAgentInstructionsParams {
  targetPath: string
  agents: HarnessAgent[]
  manifest?: { fileHashes?: Record<string, string> }
}

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
`

const COMMON_INSTRUCTIONS = `# SaaSFoundry agent instructions

Read \`CLAUDE.md\` in this project before working: it remains the authoritative project
instructions during this additive compatibility phase. Read files that it references as well.
This preserves the existing project rules and developer customizations without duplicating them.
Do not rewrite paths to \`.claude/\`: the existing guarded scripts and docs remain there.

Read \`.saasfoundry.json\` and run \`sf status --claude-friendly --no-network\` before
asking about configured scope, tools or modules. Follow its output language and workflow.
Discover shared skills under \`.agents/skills/sf-*/SKILL.md\`. Before a status transition,
read the matching status document and execute the existing workflow CLI:
\`.claude/skills/sf-workflow/workflow-cli.sh\`. Use its configured board tool, not raw mutations.
Commit and push before AI testing; preserve Human testing requirements and merge before Done.

${CAPABILITIES}`

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
      await writeFile(join(root, sidecar), content, { flag: 'wx', mode })
      report.warnings.push(`${path}: user content preserved; reconcile ${sidecar}.`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      report.warnings.push(`${path}: user content and existing ${sidecar} preserved; sidecar may be stale.`)
    }
    return
  }
  await mkdir(dirname(fullPath), { recursive: true })
  await writeFile(fullPath, content, { mode })
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
export async function planAgentInstructions({ targetPath, agents, manifest }: InstallAgentInstructionsParams): Promise<AgentInstructionPlan> {
  const report: AgentInstructionsReport = { written: [], unchanged: [], conflicts: [], warnings: [], fileHashes: {} }
  const plan: AgentInstructionPlan = { files: [], warnings: report.warnings }
  if (!agents.some((agent) => agent === 'codex' || agent === 'kimi')) return plan
  const baselines = manifest?.fileHashes ?? {}
  try {
    await readFile(join(targetPath, 'CLAUDE.md'), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    report.warnings.push('CLAUDE.md is missing: deposit the existing project harness before installing shared instructions.')
    return plan
  }
  plan.files.push({ path: 'AGENTS.md', content: Buffer.from(COMMON_INSTRUCTIONS), mode: 0o644 })
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
  const report: AgentInstructionsReport = { written: [], unchanged: [], conflicts: [], warnings: plan.warnings, fileHashes: {} }
  for (const file of plan.files) await deposit(params.targetPath, file.path, file.content, file.mode, params.manifest?.fileHashes ?? {}, report)
  return report
}
