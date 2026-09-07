import inquirer from 'inquirer'
import chalk from 'chalk'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { execSync } from 'child_process'
import { promptWorkflowConfiguration, listGlobalWorkflows, loadGlobalWorkflow, saveGlobalWorkflow, updateGitHubProjectStatuses, WORKFLOW_PRESETS } from '../prompts/workflow.prompts'
import { installWorkflowSkill } from '../installers/workflow-skill.installer'
import { readManifest, writeManifest } from '../utils'
import type { SaaSFoundryManifest, WorkflowTemplate } from '../types'

const WORKFLOWS_DIR = path.join(os.homedir(), '.claude', 'workflows')
const HISTORY_FILE = path.join(WORKFLOWS_DIR, '.history.json')

/**
 * Main workflow command handler
 */
export async function workflowCommand(subcommand?: string, ...args: string[]) {
  // Commands that don't require a project
  const globalCommands = ['list', 'create', 'delete', 'show-template']

  if (!subcommand || subcommand === 'help') {
    showUsage()
    return
  }

  // Check if we're in a project (unless it's a global command)
  const manifest = await readManifest(process.cwd())

  if (!globalCommands.includes(subcommand) && !manifest) {
    console.error(chalk.red('\n❌ Not a SaaSFoundryAI project (no .saasfoundry.json found)\n'))
    console.log(chalk.gray('Global commands available everywhere:'))
    console.log(chalk.gray('  sf workflow list'))
    console.log(chalk.gray('  sf workflow create <name>'))
    console.log(chalk.gray('  sf workflow show-template <name>\n'))
    process.exit(1)
  }

  switch (subcommand) {
    // Project-level commands
    case 'show':
      showWorkflowConfig(manifest!)
      break
    case 'use':
      await useTemplate(manifest!, args[0])
      break
    case 'set-working-branch':
      await setWorkingBranch(manifest!, args[0])
      break
    case 'set-ai-rules':
      await setAIRules(manifest!)
      break
    case 'validate':
      await validateWorkflowConfig(manifest!)
      break
    case 'save':
      await saveAsTemplate(manifest!, args[0])
      break

    // Global template commands
    case 'list':
      await listTemplates()
      break
    case 'create':
      await createTemplate(args[0])
      break
    case 'delete':
      await deleteTemplate(args[0])
      break
    case 'show-template':
      await showTemplate(args[0])
      break

    default:
      console.log(chalk.red(`\n❌ Unknown subcommand: ${subcommand}\n`))
      showUsage()
      process.exit(1)
  }
}

function showUsage() {
  console.log(chalk.blue('\nUsage: sf workflow <subcommand> [options]\n'))
  console.log(chalk.bold('Project-level commands:'))
  console.log('  show                        Display current workflow configuration')
  console.log('  use <template>              Apply a global template to current project')
  console.log('  set-working-branch <branch> Change branch de travail')
  console.log('  set-ai-rules                Modify AI development rules')
  console.log('  validate                    Validate workflow configuration')
  console.log('  save <name>                 Save as global template')
  console.log()
  console.log(chalk.bold('Global template commands:'))
  console.log('  list                        List all templates')
  console.log('  create <name>               Create new template')
  console.log('  delete <name>               Delete template')
  console.log('  show-template <name>        View template details\n')
}

// ============================================================================
// Project-level commands
// ============================================================================

function showWorkflowConfig(manifest: SaaSFoundryManifest) {
  const { workflow, aiRules } = manifest

  if (!workflow) {
    console.log(chalk.yellow('\n⚠️  No workflow configured\n'))
    return
  }

  console.log(chalk.blue('\n📋 Workflow Configuration\n'))

  if (workflow.template) {
    console.log(chalk.bold('Template:'), chalk.cyan(workflow.template))
  }
  console.log(chalk.bold('Tool:'), workflow.tool)
  if (workflow.projectUrl) {
    console.log(chalk.bold('Project URL:'), workflow.projectUrl)
  }
  console.log(chalk.bold('Branch de travail:'), chalk.cyan(workflow.workingBranch))
  console.log(chalk.bold('PR target branch:'), workflow.prTargetBranch)
  console.log(chalk.bold('Require code review:'), workflow.requireCodeReview ? 'Yes' : 'No')

  if (workflow.validated !== undefined) {
    console.log(chalk.bold('Validated:'), workflow.validated ? chalk.green('Yes') : chalk.yellow('No'))
    if (workflow.lastValidated) {
      console.log(chalk.gray(`  Last validated: ${workflow.lastValidated}`))
    }
  }

  console.log(chalk.blue('\n⚙️  AI Development Rules\n'))
  if (aiRules) {
    Object.entries(aiRules).forEach(([key, value]) => {
      const label = key
        .replace(/([A-Z])/g, ' $1')
        .toLowerCase()
        .replace(/^./, (str) => str.toUpperCase())
      console.log(`  ${value ? chalk.green('✅') : chalk.gray('❌')} ${label}`)
    })
  }

  console.log(chalk.blue('\n📊 Workflow Statuses\n'))
  if (workflow.statuses) {
    Object.entries(workflow.statuses).forEach(([key, value]) => {
      if (value) {
        console.log(`  ${chalk.gray(key)}: ${value}`)
      }
    })
  }
  console.log()
}

async function useTemplate(manifest: SaaSFoundryManifest, templateName?: string) {
  if (!templateName) {
    console.error(chalk.red('\n❌ Template name is required\n'))
    console.log('Usage: sf workflow use <template-name>\n')
    process.exit(1)
  }

  // Saved templates first, then built-in presets (saasfoundry | solo) — the
  // preset path is the in-place upgrade/downgrade between team and solo:
  // tool, URLs and branch config come from the current manifest, only the
  // status set (and docs) change. Tickets, issue types and labels stay valid.
  let template = await loadGlobalWorkflow(templateName)

  if (!template) {
    const presetKey = templateName.toLowerCase() as keyof typeof WORKFLOW_PRESETS
    const preset = WORKFLOW_PRESETS[presetKey]
    if (preset) {
      template = {
        name: preset.name,
        tool: manifest.workflow?.tool ?? 'none',
        workingBranch: manifest.workflow?.workingBranch,
        prTargetBranch: manifest.workflow?.prTargetBranch,
        requireCodeReview: manifest.workflow?.requireCodeReview,
        statuses: preset.statuses,
        issueTypes: preset.issueTypes,
        branchNaming: manifest.workflow?.branchNaming,
        commitFormat: manifest.workflow?.commitFormat,
        aiRules: manifest.aiRules
      }
    }
  }

  if (!template) {
    console.error(chalk.red(`\n❌ Template "${templateName}" not found\n`))
    console.log('Run: sf workflow list (or use a built-in preset: saasfoundry | solo)\n')
    process.exit(1)
  }

  // Prompt for project-specific values
  const answers = await inquirer.prompt([
    {
      type: 'input',
      name: 'projectUrl',
      message: `${template.tool} project URL:`,
      default: manifest.workflow?.projectUrl,
      validate: (input) => input.length > 0 || 'URL is required',
      when: () => template.tool !== 'none'
    }
  ])

  // Apply template to project
  manifest.workflow = {
    template: template.name ?? templateName,
    tool: template.tool,
    projectUrl: answers.projectUrl,
    workingBranch: template.workingBranch,
    prTargetBranch: template.prTargetBranch,
    requireCodeReview: template.requireCodeReview,
    statuses: template.statuses,
    issueTypes: template.issueTypes,
    branchNaming: template.branchNaming,
    commitFormat: template.commitFormat,
    validated: false
  }

  manifest.aiRules = template.aiRules

  await writeManifest(process.cwd(), manifest)
  await updateWorkflowHistory(templateName)

  // Regenerate the workflow skill so SKILL.md and the statuses/ docs match
  // the new status set — without this, an in-place preset upgrade leaves the
  // agent documentation describing the previous workflow.
  if (manifest.workflow.tool !== 'none') {
    await installWorkflowSkill({ targetPath: process.cwd(), workflow: manifest.workflow, projectUrl: manifest.workflow.projectUrl })
    console.log(chalk.green('✅ Workflow skill regenerated (SKILL.md + statuses docs)'))
  }

  // Align the GitHub Project board with the new status set (best-effort).
  if (manifest.workflow.tool === 'github-projects' && manifest.workflow.projectUrl && manifest.workflow.statuses?.length) {
    await updateGitHubProjectStatuses(manifest.workflow.projectUrl, manifest.workflow.statuses)
  }

  console.log(chalk.green(`\n✅ Workflow template "${templateName}" applied\n`))
}

async function setWorkingBranch(manifest: SaaSFoundryManifest, branch?: string) {
  if (!branch) {
    const { workingBranch } = await inquirer.prompt([
      {
        type: 'input',
        name: 'workingBranch',
        message: 'Branch de travail (working branch):',
        default: manifest.workflow?.workingBranch || 'develop'
      }
    ])
    branch = workingBranch
  }

  if (!manifest.workflow) {
    console.error(chalk.red('\n❌ No workflow configured\n'))
    process.exit(1)
  }

  manifest.workflow.workingBranch = branch!

  await writeManifest(process.cwd(), manifest)
  console.log(chalk.green(`\n✅ Branch de travail set to: ${chalk.cyan(branch!)}\n`))
}

async function setAIRules(manifest: SaaSFoundryManifest) {
  console.log(chalk.blue('\n⚙️  AI Development Rules\n'))

  const current = manifest.aiRules || {
    alwaysCreateBranchFromWorking: false,
    alwaysCreateTicketBeforeCode: false,
    autoUpdateTicketStatus: false,
    requireHumanCheckOnPushedBranch: false
  }

  const { aiRules } = await inquirer.prompt([
    {
      type: 'checkbox',
      name: 'aiRules',
      message: 'Select rules for AI to follow:',
      choices: [
        {
          name: 'Always create branch from working branch',
          value: 'alwaysCreateBranchFromWorking',
          checked: current.alwaysCreateBranchFromWorking
        },
        {
          name: 'Always create ticket before writing code',
          value: 'alwaysCreateTicketBeforeCode',
          checked: current.alwaysCreateTicketBeforeCode
        },
        {
          name: 'Auto-update ticket status when creating branches/PRs',
          value: 'autoUpdateTicketStatus',
          checked: current.autoUpdateTicketStatus
        },
        {
          name: 'Require human validation before marking PR ready for review',
          value: 'requireHumanCheckOnPushedBranch',
          checked: current.requireHumanCheckOnPushedBranch
        }
      ]
    }
  ])

  manifest.aiRules = {
    alwaysCreateBranchFromWorking: aiRules.includes('alwaysCreateBranchFromWorking'),
    alwaysCreateTicketBeforeCode: aiRules.includes('alwaysCreateTicketBeforeCode'),
    autoUpdateTicketStatus: aiRules.includes('autoUpdateTicketStatus'),
    requireHumanCheckOnPushedBranch: aiRules.includes('requireHumanCheckOnPushedBranch')
  }

  await writeManifest(process.cwd(), manifest)
  console.log(chalk.green('\n✅ AI rules updated\n'))
}

async function saveAsTemplate(manifest: SaaSFoundryManifest, templateName?: string) {
  if (!manifest.workflow) {
    console.error(chalk.red('\n❌ No workflow configured in this project\n'))
    process.exit(1)
  }

  if (!templateName) {
    const { name, description } = await inquirer.prompt([
      {
        type: 'input',
        name: 'name',
        message: 'Template name:',
        validate: (input) => {
          if (!input || input.length === 0) return 'Name is required'
          if (!/^[a-z0-9-]+$/.test(input)) {
            return 'Use lowercase letters, numbers, and hyphens only'
          }
          return true
        }
      },
      {
        type: 'input',
        name: 'description',
        message: 'Description (optional):'
      }
    ])
    templateName = name

    const template: WorkflowTemplate = {
      name: templateName!,
      description,
      tool: manifest.workflow.tool,
      workingBranch: manifest.workflow.workingBranch,
      prTargetBranch: manifest.workflow.prTargetBranch,
      requireCodeReview: manifest.workflow.requireCodeReview,
      statuses: manifest.workflow.statuses,
      issueTypes: manifest.workflow.issueTypes,
      branchNaming: manifest.workflow.branchNaming,
      commitFormat: manifest.workflow.commitFormat,
      aiRules: manifest.aiRules || {
        alwaysCreateBranchFromWorking: false,
        alwaysCreateTicketBeforeCode: false,
        autoUpdateTicketStatus: false,
        requireHumanCheckOnPushedBranch: false
      }
    }

    await saveGlobalWorkflow(templateName!, template)
  } else {
    const template: WorkflowTemplate = {
      name: templateName!,
      tool: manifest.workflow.tool,
      workingBranch: manifest.workflow.workingBranch,
      prTargetBranch: manifest.workflow.prTargetBranch,
      requireCodeReview: manifest.workflow.requireCodeReview,
      statuses: manifest.workflow.statuses,
      issueTypes: manifest.workflow.issueTypes,
      branchNaming: manifest.workflow.branchNaming,
      commitFormat: manifest.workflow.commitFormat,
      aiRules: manifest.aiRules || {
        alwaysCreateBranchFromWorking: false,
        alwaysCreateTicketBeforeCode: false,
        autoUpdateTicketStatus: false,
        requireHumanCheckOnPushedBranch: false
      }
    }

    await saveGlobalWorkflow(templateName!, template)
  }

  console.log(chalk.green(`\n✅ Workflow saved as template: ${chalk.cyan(templateName!)}\n`))
}

async function validateWorkflowConfig(manifest: SaaSFoundryManifest) {
  // Check if workflow validator skill exists in generated project
  const skillPath = path.join(process.cwd(), '.claude', 'skills-optional', 'sf-tool-workflow-validator', 'validate-workflow.sh')

  try {
    await fs.access(skillPath)
  } catch {
    console.log(chalk.yellow('\n⚠️  Workflow validator skill not found in project\n'))
    console.log(chalk.gray('The validator skill may not have been generated with your project.'))
    console.log(chalk.gray('It is available in newer versions of SaaSFoundryAI.\n'))

    // Fallback to basic validation
    console.log(chalk.blue('🔍 Running basic validation...\n'))

    const issues: string[] = []

    if (!manifest.workflow) {
      issues.push('No workflow configuration found')
    } else {
      if (!manifest.workflow.tool) {
        issues.push('Tool not specified')
      }
      if (manifest.workflow.tool !== 'none' && !manifest.workflow.projectUrl) {
        issues.push('Project URL not specified')
      }
      if (!manifest.workflow.workingBranch) {
        issues.push('Working branch not specified')
      }
      if (!manifest.workflow.prTargetBranch) {
        issues.push('PR target branch not specified')
      }
    }

    if (issues.length === 0) {
      console.log(chalk.green('✅ Workflow configuration is valid\n'))
    } else {
      console.log(chalk.red('❌ Validation failed:\n'))
      issues.forEach((issue) => console.log(`  - ${issue}`))
      console.log()
      process.exit(1)
    }

    return
  }

  // Run the workflow validator script
  try {
    execSync(`bash "${skillPath}"`, {
      stdio: 'inherit',
      cwd: process.cwd()
    })
  } catch {
    // Script already outputs errors, just exit with error code
    process.exit(1)
  }
}

// ============================================================================
// Global template commands
// ============================================================================

async function listTemplates() {
  const templates = await listGlobalWorkflows()

  if (templates.length === 0) {
    console.log(chalk.yellow('\n⚠️  No workflow templates found\n'))
    console.log('Create one with: sf workflow create <name>\n')
    return
  }

  console.log(chalk.blue('\n📋 Global Workflow Templates\n'))

  templates.forEach((template) => {
    console.log(chalk.cyan(`  ${template.name}`))
    if (template.description) {
      console.log(chalk.gray(`    ${template.description}`))
    }
    console.log(chalk.gray(`    Tool: ${template.tool}`))
    console.log()
  })

  console.log(chalk.gray(`Total: ${templates.length} template(s)\n`))
}

async function createTemplate(templateName?: string) {
  if (!templateName) {
    const { name } = await inquirer.prompt([
      {
        type: 'input',
        name: 'name',
        message: 'Template name:',
        validate: (input) => {
          if (!input || input.length === 0) return 'Name is required'
          if (!/^[a-z0-9-]+$/.test(input)) {
            return 'Use lowercase letters, numbers, and hyphens only'
          }
          return true
        }
      }
    ])
    templateName = name
  }

  // Validate template name (even when passed as argument)
  if (!templateName || !/^[a-z0-9-]+$/.test(templateName)) {
    console.error(chalk.red('\n❌ Invalid template name'))
    console.log(chalk.gray('Use lowercase letters, numbers, and hyphens only\n'))
    process.exit(1)
  }

  // Check if template already exists (templateName is guaranteed to be string here)
  const existing = await loadGlobalWorkflow(templateName)
  if (existing) {
    const { overwrite } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'overwrite',
        message: `Template "${templateName}" already exists. Overwrite?`,
        default: false
      }
    ])

    if (!overwrite) {
      console.log(chalk.yellow('\n⚠️  Template creation cancelled\n'))
      return
    }
  }

  console.log(chalk.blue(`\n📋 Creating template: ${chalk.cyan(templateName!)}\n`))

  // Use the standard workflow configuration prompts (but skip project URL and template save)
  const { workflow, aiRules } = await promptWorkflowConfiguration()

  const template: WorkflowTemplate = {
    name: templateName!,
    description: workflow.template, // Reuse description if provided
    tool: workflow.tool,
    workingBranch: workflow.workingBranch,
    prTargetBranch: workflow.prTargetBranch,
    requireCodeReview: workflow.requireCodeReview,
    statuses: workflow.statuses,
    issueTypes: workflow.issueTypes,
    branchNaming: workflow.branchNaming,
    commitFormat: workflow.commitFormat,
    aiRules
  }

  await saveGlobalWorkflow(templateName!, template)

  console.log(chalk.green(`\n✅ Template "${templateName}" created\n`))
}

async function deleteTemplate(templateName?: string) {
  if (!templateName) {
    console.error(chalk.red('\n❌ Template name is required\n'))
    console.log('Usage: sf workflow delete <name>\n')
    process.exit(1)
  }

  const template = await loadGlobalWorkflow(templateName)
  if (!template) {
    console.error(chalk.red(`\n❌ Template "${templateName}" not found\n`))
    process.exit(1)
  }

  const { confirm } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'confirm',
      message: `Delete template "${templateName}"?`,
      default: false
    }
  ])

  if (!confirm) {
    console.log(chalk.yellow('\n⚠️  Deletion cancelled\n'))
    return
  }

  await fs.unlink(path.join(WORKFLOWS_DIR, `${templateName}.json`))
  console.log(chalk.green(`\n✅ Template "${templateName}" deleted\n`))
}

async function showTemplate(templateName?: string) {
  if (!templateName) {
    console.error(chalk.red('\n❌ Template name is required\n'))
    console.log('Usage: sf workflow show-template <name>\n')
    process.exit(1)
  }

  const template = await loadGlobalWorkflow(templateName)

  if (!template) {
    console.error(chalk.red(`\n❌ Template "${templateName}" not found\n`))
    process.exit(1)
  }

  console.log(chalk.blue(`\n📋 Template: ${chalk.cyan(templateName)}\n`))

  if (template.description) {
    console.log(chalk.bold('Description:'), template.description)
  }
  console.log(chalk.bold('Tool:'), template.tool)
  console.log(chalk.bold('Branch de travail:'), chalk.cyan(template.workingBranch))
  console.log(chalk.bold('PR target branch:'), template.prTargetBranch)
  console.log(chalk.bold('Require code review:'), template.requireCodeReview ? 'Yes' : 'No')

  console.log(chalk.blue('\n⚙️  AI Development Rules\n'))
  if (template.aiRules) {
    Object.entries(template.aiRules).forEach(([key, value]) => {
      const label = key
        .replace(/([A-Z])/g, ' $1')
        .toLowerCase()
        .replace(/^./, (str) => str.toUpperCase())
      console.log(`  ${value ? chalk.green('✅') : chalk.gray('❌')} ${label}`)
    })
  }

  console.log()
}

// ============================================================================
// Helper functions
// ============================================================================

async function ensureWorkflowsDir(): Promise<void> {
  try {
    await fs.mkdir(WORKFLOWS_DIR, { recursive: true })
  } catch {
    // Directory already exists
  }
}

async function updateWorkflowHistory(name: string): Promise<void> {
  await ensureWorkflowsDir()

  let history: {
    recentWorkflows: string[]
    usage: Record<string, { lastUsed: string; projectCount: number }>
  }

  try {
    const content = await fs.readFile(HISTORY_FILE, 'utf-8')
    history = JSON.parse(content)
  } catch {
    history = { recentWorkflows: [], usage: {} }
  }

  // Update recent workflows
  history.recentWorkflows = [name, ...history.recentWorkflows.filter((w) => w !== name)].slice(0, 10)

  // Update usage stats
  if (!history.usage[name]) {
    history.usage[name] = { lastUsed: new Date().toISOString(), projectCount: 0 }
  }
  history.usage[name].lastUsed = new Date().toISOString()
  history.usage[name].projectCount++

  await fs.writeFile(HISTORY_FILE, JSON.stringify(history, null, 2), 'utf-8')
}
