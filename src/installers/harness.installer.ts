import { copy } from 'fs-extra'
import { readFile, writeFile } from 'fs/promises'
import { join, resolve, sep } from 'path'

import { installClaudeDocs } from './claude-docs.installer'
import { installCoreSkills } from './core-skills.installer'
import { installOptionalSkills } from './optional-skills.installer'
import { installToolSkill } from './tool-skill.installer'
import { injectWorkflowSection, installWorkflowSkill } from './workflow-skill.installer'
import { AgentInstructionsReport, HarnessAgent, installAgentInstructions } from '../harness/agent-instructions'
import { needsSharedInstructions } from '../harness/agent-registry'
import type { ModuleInstaller } from '../migrations/module/types'
import { SaaSFoundryManifest, WorkflowConfig, skillsTemplatesPath } from '../types'
import { ClaudeHooksConfig, mergeClaudeSettingsHooks } from '../utils/claude-settings'
import { computeFileHashes, fileExists } from '../utils'

export const harnessInstallerMeta: ModuleInstaller = {
  name: 'harness',
  currentVersion: 1,
  migrations: []
}

/**
 * Scope of the harness hash tracking that drives the conflict-aware refresh
 * in `sf update`:
 * - `.claude/docs/**` — entirely deposit-owned
 * - `.claude/skills/sf-*` — the `sf-` prefix is reserved for SaaSFoundryAI
 *   deposits; user-authored skills outside that prefix are never tracked,
 *   never touched
 * CLAUDE.md and .claude/settings.json are deliberately NOT tracked: both are
 * user-owned and managed through targeted merges (section re-injection /
 * hook merging), never through the file sweep.
 */
export const HARNESS_SKILL_PREFIX = 'sf-'

/** Is this project-root-relative path inside the harness-tracked scope? */
export function isHarnessTrackedPath(relPath: string): boolean {
  if (relPath.startsWith('.claude/docs/')) return true
  return relPath.startsWith(`.claude/skills/${HARNESS_SKILL_PREFIX}`)
}

/**
 * Hash every file of the harness deposits, keyed by project-root-relative
 * path — the entries `installHarness` and the `sf update` refresh store in
 * `manifest.fileHashes` so user edits are detected (same mechanism as the
 * scaffold template tracking and `writeMigratedFile`).
 */
export async function computeHarnessFileHashes(targetPath: string): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {}
  for (const dir of ['.claude/skills', '.claude/docs']) {
    const dirPath = join(targetPath, dir)
    if (!(await fileExists(dirPath))) continue
    const dirHashes = await computeFileHashes(dirPath)
    for (const [relPath, hash] of Object.entries(dirHashes)) {
      // Normalize to forward slashes so baselines committed from Windows
      // still match on POSIX (and vice versa).
      const projectRelPath = `${dir}/${relPath.split(sep).join('/')}`
      if (isHarnessTrackedPath(projectRelPath)) hashes[projectRelPath] = hash
    }
  }
  return hashes
}

export interface InstallWorkflowArtifactsParams {
  targetPath: string
  workflow?: WorkflowConfig
}

/**
 * Workflow-related deposits shared by every install path: the sf-workflow
 * skill (with CLAUDE.md section injection) and the tool-specific skill.
 * Builders (full profile) and the standalone harness install both delegate
 * here, so the deposited files stay identical across profiles.
 */
export async function installWorkflowArtifacts({ targetPath, workflow }: InstallWorkflowArtifactsParams): Promise<void> {
  if (!workflow || workflow.tool === 'none') return

  await installWorkflowSkill({
    targetPath,
    workflow,
    projectUrl: workflow.projectUrl
  })

  await installToolSkill({
    targetPath,
    tool: workflow.tool as 'github-projects' | 'jira' | 'notion' | 'linear'
  })
}

export interface InstallHarnessParams {
  targetPath: string
  projectName: string
  version: string
  mainBranch?: string
  workflow?: WorkflowConfig
  advancedSkills?: string[]
  /** Additive instruction adapters. Omission preserves the legacy Claude installation. */
  agents?: HarnessAgent[]
}

const HARNESS_HOOKS: ClaudeHooksConfig = {
  SessionStart: [{ hooks: [{ type: 'command', command: 'sf status --claude-friendly --no-network' }] }],
  UserPromptSubmit: [{ hooks: [{ type: 'command', command: '.claude/skills/sf-srs/scripts/srs-intent-hook.sh' }] }]
}

export interface MergeHarnessUserFilesParams {
  targetPath: string
  projectName: string
  version: string
  mainBranch?: string
  workflow?: WorkflowConfig
}

/**
 * The merge-managed (non-swept) side of a harness install: CLAUDE.md
 * (template deposited only when absent, placeholders resolved, workflow
 * section re-injected idempotently) and the Claude Code hooks. Used by the
 * conflict-safe install path of `sf update` after the three-way deposit
 * merge, which by design never touches these user-owned files.
 */
export async function mergeHarnessUserFiles({ targetPath, projectName, version, mainBranch = 'main', workflow }: MergeHarnessUserFilesParams): Promise<void> {
  const claudeMdPath = join(targetPath, 'CLAUDE.md')
  const depositedClaudeMd = !(await fileExists(claudeMdPath))

  if (depositedClaudeMd) {
    await copy(resolve(skillsTemplatesPath, 'harness', 'CLAUDE.md'), claudeMdPath)
    let content = await readFile(claudeMdPath, 'utf8')
    content = content
      .replace(/\{\{PROJECT_NAME\}\}/g, projectName)
      .replace(/\{\{VERSION\}\}/g, version)
      .replace(/\{\{MAIN_BRANCH\}\}/g, mainBranch)
    await writeFile(claudeMdPath, content)
  }

  if (workflow && workflow.tool !== 'none') {
    await injectWorkflowSection({ targetPath, workflow, projectUrl: workflow.projectUrl })
  }

  await mergeClaudeSettingsHooks(targetPath, HARNESS_HOOKS)
}

/**
 * Install the AI harness onto an EXISTING repository (harness profile):
 * core skills, shared docs, optional tool skills, workflow artefacts,
 * Claude Code hooks and a minimal CLAUDE.md when the repo has none.
 *
 * The user's files are respected: an existing CLAUDE.md is only appended to
 * (workflow section injection), and .claude/settings.json is merged, never
 * overwritten.
 */
export async function installHarness({
  targetPath,
  projectName,
  version,
  mainBranch = 'main',
  workflow,
  advancedSkills = [],
  agents
}: InstallHarnessParams): Promise<AgentInstructionsReport | undefined> {
  // Adding discovery must not reinstall the user's customized legacy skills.
  // Refreshing those files belongs to the conflict-aware update flow.
  if (agents && needsSharedInstructions(agents) && (await fileExists(join(targetPath, '.claude', 'skills')))) {
    if (!(await fileExists(join(targetPath, 'CLAUDE.md')))) {
      throw new Error('Existing Claude skills have no CLAUDE.md instruction source. Reconcile this partial harness before adding shared agent instructions; existing files were left unchanged.')
    }
    return addAgentInstructions(targetPath, agents)
  }
  const claudeMdPath = join(targetPath, 'CLAUDE.md')
  const depositedClaudeMd = !(await fileExists(claudeMdPath))

  if (depositedClaudeMd) {
    await copy(resolve(skillsTemplatesPath, 'harness', 'CLAUDE.md'), claudeMdPath)
  }

  await installCoreSkills({ targetPath })
  await installClaudeDocs({ targetPath })

  if (advancedSkills.length > 0) {
    await installOptionalSkills({ targetPath, selectedSkills: advancedSkills })
  }

  await installWorkflowArtifacts({ targetPath, workflow })

  await mergeClaudeSettingsHooks(targetPath, HARNESS_HOOKS)

  if (depositedClaudeMd) {
    let content = await readFile(claudeMdPath, 'utf8')
    content = content
      .replace(/\{\{PROJECT_NAME\}\}/g, projectName)
      .replace(/\{\{VERSION\}\}/g, version)
      .replace(/\{\{MAIN_BRANCH\}\}/g, mainBranch)
    await writeFile(claudeMdPath, content)
  }

  if (agents) {
    return addAgentInstructions(targetPath, agents)
  }
}

async function addAgentInstructions(targetPath: string, agents: HarnessAgent[]): Promise<AgentInstructionsReport> {
  const manifestPath = join(targetPath, '.saasfoundry.json')
  const manifest: SaaSFoundryManifest | undefined = (await fileExists(manifestPath)) ? JSON.parse(await readFile(manifestPath, 'utf8')) : undefined
  const report = await installAgentInstructions({ targetPath, agents, manifest })
  for (const warning of report.warnings) console.warn(warning)
  for (const conflict of report.conflicts) console.warn(`Agent instructions need reconciliation: ${conflict}`)
  return report
}
