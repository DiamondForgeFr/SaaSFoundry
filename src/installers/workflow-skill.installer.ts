import { copy, ensureDir, move, remove } from 'fs-extra'
import { readFile, writeFile } from 'fs/promises'
import { resolve } from 'path'

import type { ModuleInstaller } from '../migrations/module/types'
import { WorkflowConfig, skillsTemplatesPath } from '../types'
import { fileExists } from '../utils'

export const workflowSkillInstallerMeta: ModuleInstaller = {
  name: 'workflow-skill',
  currentVersion: 1,
  migrations: []
}

interface InstallWorkflowSkillParams {
  targetPath: string
  workflow: WorkflowConfig
  projectUrl?: string
}

/**
 * Install workflow skill from template.
 *
 * This function:
 * 1. Copies workflow skill template from scaffolds/skills-templates/workflow/
 * 2. Replaces placeholders in SKILL.md
 * 3. Injects workflow section into CLAUDE.md
 *
 * Configuration is read from .saasfoundry.json (no .env needed).
 *
 * Used by builders when workflow is configured during project generation.
 */
export async function installWorkflowSkill({ targetPath, workflow, projectUrl }: InstallWorkflowSkillParams) {
  // Source: scaffolds/skills-templates/workflow/
  const templatePath = resolve(skillsTemplatesPath, 'workflow')
  const targetSkillPath = `${targetPath}/.claude/skills/sf-workflow`

  // Re-installs (e.g. `sf workflow use` preset upgrades) must not leave stale
  // docs from the previous preset behind.
  await remove(targetSkillPath)

  // Copy entire skill template
  await copy(templatePath, targetSkillPath)

  // Keep only the status docs of the configured preset — a 5-status solo
  // project must never ship orphan Human Testing / Ready docs.
  const soloPreset = workflow.template === 'SaaSFoundry Solo'
  if (soloPreset) {
    await remove(`${targetSkillPath}/statuses`)
    await move(`${targetSkillPath}/statuses-solo`, `${targetSkillPath}/statuses`)
  } else {
    await remove(`${targetSkillPath}/statuses-solo`)
  }

  // Install the trusted-base board listener only for GitHub Projects. Existing
  // project workflows are user-owned and must never be overwritten on refresh.
  if (workflow.tool === 'github-projects') {
    const actionsDir = resolve(targetPath, '.github/workflows')
    await ensureDir(actionsDir)
    await copy(resolve(templatePath, 'github/pr-review-sync.yml'), resolve(actionsDir, 'pr-review-sync.yml'), { overwrite: false, errorOnExist: false })
  }

  // Replace placeholders in SKILL.md
  const skillMdPath = `${targetSkillPath}/SKILL.md`
  let skillMdContent = await readFile(skillMdPath, 'utf8')
  const workflowName = workflow.template || workflow.tool
  const toolDisplayName =
    workflow.tool === 'github-projects' ? 'GitHub Projects' : workflow.tool === 'jira' ? 'Jira' : workflow.tool === 'notion' ? 'Notion' : workflow.tool === 'linear' ? 'Linear' : workflow.tool
  const statusesList = (workflow.statuses || [])
    .map((s, i) => {
      const slug = s.name.toLowerCase().replace(/\s+/g, '-')
      return `${i + 1}. **${s.name}**${s.color ? ` (${s.color})` : ''} — Read \`statuses/${i + 1}-${slug}.md\` for full description`
    })
    .join('\n')

  skillMdContent = skillMdContent
    .replace(/\{\{WORKFLOW_NAME\}\}/g, workflowName || '')
    .replace(/\{\{TOOL\}\}/g, toolDisplayName || '')
    .replace(/\{\{STATUSES_LIST\}\}/g, statusesList || 'No statuses configured.')
  await writeFile(skillMdPath, skillMdContent)

  // Inject workflow section into CLAUDE.md
  await injectWorkflowSection({ targetPath, workflow, projectUrl })
}

/**
 * Generate and inject workflow section into CLAUDE.md
 */
export async function injectWorkflowSection({ targetPath, workflow, projectUrl }: InstallWorkflowSkillParams) {
  const claudeMdPath = `${targetPath}/CLAUDE.md`

  if (!(await fileExists(claudeMdPath))) {
    return
  }

  let claudeMdContent = await readFile(claudeMdPath, 'utf8')

  // Generate workflow section
  const workflowSection = generateWorkflowSection(workflow, projectUrl)

  const sectionMarker = '## Workflow System'
  const gitWorkflowMarker = '## Git Workflow'
  const developmentCommandsMarker = '## Development Commands'

  if (claudeMdContent.includes(sectionMarker)) {
    // Idempotent re-install (preset upgrade): replace the existing section,
    // which spans from its heading to the next top-level heading (or EOF).
    const sectionRegex = /## Workflow System[\s\S]*?(?=\n## |$)/
    claudeMdContent = claudeMdContent.replace(sectionRegex, `${workflowSection}\n`)
  } else if (claudeMdContent.includes(gitWorkflowMarker) && claudeMdContent.includes(developmentCommandsMarker)) {
    // Inject between Git Workflow and Development Commands
    claudeMdContent = claudeMdContent.replace(developmentCommandsMarker, `${workflowSection}\n\n${developmentCommandsMarker}`)
  } else {
    // Append at the end
    claudeMdContent += `\n\n${workflowSection}`
  }

  await writeFile(claudeMdPath, claudeMdContent)
}

/**
 * Generate workflow section content for CLAUDE.md
 */
function generateWorkflowSection(workflow: WorkflowConfig, projectUrl?: string): string {
  const workingBranch = workflow.workingBranch || 'develop'
  const prTargetBranch = workflow.prTargetBranch || workingBranch
  const workflowName = workflow.template || workflow.tool

  const sections: string[] = []

  sections.push('## Workflow System')
  sections.push('')
  sections.push('**This project uses an AI-assisted workflow system. All workflow documentation is managed by the `sf-workflow` skill.**')
  sections.push('')
  sections.push('### Quick Reference')
  sections.push('')
  sections.push('- **Tool**: ' + (workflow.tool === 'github-projects' ? 'GitHub Projects' : workflow.tool))
  if (projectUrl) {
    sections.push('- **Project URL**: ' + projectUrl)
  }
  sections.push('- **Working Branch**: `' + workingBranch + '`')
  sections.push('- **PR Target Branch**: `' + prTargetBranch + '`')
  if (workflowName) {
    sections.push('- **Workflow Template**: ' + workflowName)
  }
  sections.push('')

  // Branch naming
  if (workflow.branchNaming) {
    sections.push('### Branch Naming')
    sections.push('')
    if (workflow.branchNaming.feature) {
      sections.push('- Features: `' + workflow.branchNaming.feature + '`')
    }
    if (workflow.branchNaming.fix) {
      sections.push('- Fixes: `' + workflow.branchNaming.fix + '`')
    }
    if (workflow.branchNaming.release) {
      sections.push('- Releases: `' + workflow.branchNaming.release + '`')
    }
    sections.push('')
  }

  // Commit format
  if (workflow.commitFormat) {
    sections.push('### Commit Format')
    sections.push('')
    if (workflow.commitFormat.pattern) {
      sections.push('Pattern: `' + workflow.commitFormat.pattern + '`')
      sections.push('')
    }
    if (workflow.commitFormat.requireTicket) {
      sections.push('**Ticket reference is required in commit messages.**')
      sections.push('')
    }
    if (workflow.commitFormat.types && workflow.commitFormat.types.length > 0) {
      sections.push('Allowed types: ' + workflow.commitFormat.types.map((t) => `\`${t}\``).join(', '))
      sections.push('')
    }
  }

  // Workflow CLI commands
  sections.push('### Workflow Commands')
  sections.push('')
  sections.push('Use the `sf-workflow` skill CLI to check your current status and next steps:')
  sections.push('')
  sections.push('```bash')
  sections.push('# Check current ticket status and what to do')
  sections.push('.claude/skills/sf-workflow/workflow-cli.sh status <ticket-number>')
  sections.push('')
  sections.push('# Show next status in the workflow')
  sections.push('.claude/skills/sf-workflow/workflow-cli.sh next <ticket-number>')
  sections.push('')
  sections.push('# Display full workflow documentation')
  sections.push('.claude/skills/sf-workflow/workflow-cli.sh help')
  sections.push('```')
  sections.push('')
  sections.push(
    '**IMPORTANT**: The workflow skill contains detailed status descriptions, mandatory actions, and exit conditions for each workflow phase. Always consult it before moving tickets between statuses.'
  )

  return sections.join('\n')
}
