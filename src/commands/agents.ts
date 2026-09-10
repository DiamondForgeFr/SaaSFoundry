import { Command } from 'commander'
import { AGENT_REGISTRY_VERSION, getAgentIds, listAgentProfiles } from '../harness/agent-registry'
import { enableAgents, readAgentSupport, refreshAgents, replaceAgents } from '../harness/agent-support'
import { applyAgentAdoption, planAgentAdoption } from '../harness/agent-adoption'
import { collectAgentDiagnostics, type DiagnosticCheck } from '../harness/agent-diagnostics'

interface AgentCommandOptions {
  json?: boolean
  scope?: string
  apply?: boolean
  plan?: string
  mode?: string
  checkRuntime?: boolean
}

function errorPayload(error: unknown): { error: string; report?: unknown; recovery?: unknown } {
  const record = typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : undefined
  return {
    error: error instanceof Error ? error.message : String(error),
    ...(record?.report !== undefined ? { report: record.report } : {}),
    ...(record?.recovery !== undefined ? { recovery: record.recovery } : {})
  }
}

async function adoptAgents(agents: string[], options: AgentCommandOptions): Promise<void> {
  if (options.apply && !options.plan) throw new Error("Applying adoption requires the reviewed plan ID: rerun with '--apply --plan <id>'.")
  if (!options.apply && options.plan) throw new Error("'--plan' is only valid with '--apply'. Preview adoption without either flag first.")

  if (options.apply) {
    const result = await applyAgentAdoption({ targetPath: process.cwd(), agents, scope: options.scope, mode: options.mode, planId: options.plan! })
    if (options.json) process.stdout.write(JSON.stringify(result, null, 2) + '\n')
    else {
      process.stdout.write(`Adoption applied in ${result.scope} scope.\n`)
      process.stdout.write(`Effective agents: ${result.configuredAgents.join(', ') || '(none recorded)'}\n`)
      process.stdout.write(`${result.report.written.length} files written, ${result.report.unchanged.length} unchanged, ${result.report.conflicts.length} conflicts.\n`)
      for (const warning of result.report.warnings) process.stderr.write(`Warning: ${warning}\n`)
      for (const conflict of result.report.conflicts) process.stderr.write(`Conflict: ${conflict}\n`)
    }
    if (result.report.conflicts.length) process.exitCode = 1
    return
  }

  const plan = await planAgentAdoption({ targetPath: process.cwd(), agents, scope: options.scope, mode: options.mode })
  if (options.json) process.stdout.write(JSON.stringify(plan, null, 2) + '\n')
  else {
    process.stdout.write(`Adoption preview (${plan.scope} scope)\n`)
    process.stdout.write(`Mode: ${plan.mode}\n`)
    process.stdout.write(`Source: ${plan.source}\n`)
    process.stdout.write('Inventory:\n')
    for (const entry of plan.inventory) process.stdout.write(`  ${entry.kind}: ${entry.path}\n`)
    process.stdout.write('Files:\n')
    for (const file of plan.files) process.stdout.write(`  ${file.action}: ${file.path}\n`)
    if (!plan.files.length) process.stdout.write('  (none)\n')
    if (plan.prerequisites.length) {
      process.stdout.write('Prerequisites:\n')
      for (const prerequisite of plan.prerequisites) process.stdout.write(`  - ${prerequisite}\n`)
    }
    if (plan.warnings.length) {
      process.stdout.write('Warnings:\n')
      for (const warning of plan.warnings) process.stdout.write(`  - ${warning}\n`)
    }
    if (plan.conflicts.length) {
      process.stdout.write('Conflicts:\n')
      for (const conflict of plan.conflicts) process.stdout.write(`  - ${conflict}\n`)
    }
    if (plan.canApply) {
      const mode = plan.mode === 'replace' ? ' --mode replace' : ''
      process.stdout.write(`Apply this exact plan: sf agents adopt ${plan.requestedAgents.join(' ')} --scope ${plan.scope}${mode} --apply --plan ${plan.planId}\n`)
    } else process.stdout.write('This plan cannot be applied until its prerequisites and conflicts are resolved.\n')
  }
}

function writeDiagnosticCheck(check: DiagnosticCheck, indent = ''): void {
  process.stdout.write(`${indent}[${check.status}] ${check.id}\n`)
  process.stdout.write(`${indent}  Evidence: ${check.summary}\n`)
  if (check.remediation) process.stdout.write(`${indent}  Remediation: ${check.remediation}\n`)
}

async function doctorAgents(agents: string[], options: AgentCommandOptions): Promise<void> {
  const report = await collectAgentDiagnostics(process.cwd(), {
    ...(agents.length ? { agents } : {}),
    checkRuntime: options.checkRuntime === true
  })
  if (options.json) process.stdout.write(JSON.stringify(report, null, 2) + '\n')
  else {
    process.stdout.write('Agent diagnostics (read-only)\n')
    process.stdout.write('These checks do not assure runtime activation, native instruction or skill loading, hook execution, authentication, permissions, delegation, or workflow execution.\n')
    process.stdout.write('\nProject checks\n')
    for (const check of report.checks) writeDiagnosticCheck(check, '  ')
    for (const agent of report.agents) {
      process.stdout.write(`\n${agent.id}\n`)
      for (const check of agent.checks) writeDiagnosticCheck(check, '  ')
    }
    if (report.initialization.length) {
      process.stdout.write('\nInitialization required\n')
      for (const instruction of report.initialization) process.stdout.write(`  - ${instruction}\n`)
    }
  }
  if ([...report.checks, ...report.agents.flatMap((agent) => agent.checks)].some((check) => check.status === 'failed')) process.exitCode = 1
}

export async function agentsCommand(action: 'enable' | 'replace' | 'refresh' | 'list' | 'catalog' | 'adopt' | 'doctor', agents: string[] = [], options: AgentCommandOptions = {}): Promise<void> {
  try {
    if (action === 'adopt') {
      await adoptAgents(agents, options)
      return
    }
    if (action === 'doctor') {
      await doctorAgents(agents, options)
      return
    }
    if (action === 'catalog') {
      const profiles = listAgentProfiles()
      if (options.json) process.stdout.write(JSON.stringify({ registryVersion: AGENT_REGISTRY_VERSION, runtime: 'not-checked', profiles }, null, 2) + '\n')
      else {
        process.stdout.write('Agent tool profiles (runtime capabilities are not checked):\n')
        for (const profile of profiles) process.stdout.write(`${profile.id}: ${profile.displayName} — ${profile.instructionFile}\n`)
        process.stdout.write('Use --json for declared support, sources and limitations. Models and providers are configured in your agent tool.\n')
      }
      return
    }
    if (action === 'list') {
      const inventory = await readAgentSupport(process.cwd())
      if (options.json) process.stdout.write(JSON.stringify(inventory, null, 2) + '\n')
      else {
        process.stdout.write(`Effective agents: ${inventory.configuredAgents.join(', ') || '(none recorded)'}\n`)
        process.stdout.write(`Shared agents: ${inventory.sharedAgents.join(', ')}\nLocal agents: ${inventory.localAgents.join(', ') || '(none)'}\n`)
        process.stdout.write(`Discovered files: ${JSON.stringify(inventory.discovered)}\nRuntime discovery: not checked\n`)
      }
      return
    }
    const params = { targetPath: process.cwd(), scope: options.scope }
    const result = action === 'enable' ? await enableAgents({ ...params, agents }) : action === 'replace' ? await replaceAgents({ ...params, agents }) : await refreshAgents(params)
    if (options.json) process.stdout.write(JSON.stringify(result, null, 2) + '\n')
    else {
      process.stdout.write(`Scope: ${options.scope ?? 'local'}\n`)
      process.stdout.write(`Effective agents: ${result.configuredAgents.join(', ') || '(none recorded)'}\n`)
      process.stdout.write(`${result.report.written.length} files written, ${result.report.unchanged.length} unchanged, ${result.report.conflicts.length} conflicts.\n`)
      for (const warning of result.report.warnings) process.stderr.write(`Warning: ${warning}\n`)
      for (const conflict of result.report.conflicts) process.stderr.write(`Conflict: ${conflict}\n`)
    }
    if (result.report.conflicts.length) process.exitCode = 1
  } catch (error) {
    const payload = errorPayload(error)
    if (options.json) process.stdout.write(JSON.stringify(payload) + '\n')
    else {
      process.stderr.write(`Error: ${payload.error}\n`)
      if (payload.report !== undefined) process.stderr.write(`Report: ${JSON.stringify(payload.report, null, 2)}\n`)
      if (payload.recovery !== undefined) process.stderr.write(`Recovery: ${JSON.stringify(payload.recovery, null, 2)}\n`)
    }
    process.exitCode = 1
  }
}

export function registerAgentCommands(command: Command): void {
  command
    .command('doctor')
    .description('Diagnose local agent artifacts and declared capabilities without changing the project')
    .argument('[agents...]', getAgentIds().join(', '))
    .option('--check-runtime', 'Check for declared executables in PATH without running them')
    .option('--json', 'Output only the machine-readable diagnostic report')
    .action((agents: string[], options: AgentCommandOptions) => agentsCommand('doctor', agents, options))
  command
    .command('adopt')
    .description('Preview or apply additive agent support to an existing repository')
    .argument('<agents...>', getAgentIds().join(', '))
    .option('--scope <scope>', 'Configuration scope: local (default) or shared', 'local')
    .option('--apply', 'Apply a previously reviewed adoption plan')
    .option('--plan <id>', 'Exact plan ID returned by the preview')
    .option('--mode <mode>', 'Selection mode: add (default) or replace', 'add')
    .option('--json', 'Output only the machine-readable plan or result')
    .action((agents: string[], options: AgentCommandOptions) => agentsCommand('adopt', agents, options))
  command
    .command('catalog')
    .description('List registered tool profiles and declared support without probing runtimes')
    .option('--json', 'Output versioned profile metadata')
    .action((options: AgentCommandOptions) => agentsCommand('catalog', [], options))
  command
    .command('enable')
    .description('Add support without disabling other configured agents')
    .argument('<agents...>', getAgentIds().join(', '))
    .option('--scope <scope>', 'Configuration scope: local (default) or shared', 'local')
    .option('--json', 'Output a machine-readable report')
    .action((agents: string[], options: AgentCommandOptions) => agentsCommand('enable', agents, options))
  command
    .command('replace')
    .description("Replace the selected scope's declared agents without deleting existing files")
    .argument('<agents...>', getAgentIds().join(', '))
    .option('--scope <scope>', 'Configuration scope: local (default) or shared', 'local')
    .option('--json', 'Output a machine-readable report')
    .action((agents: string[], options: AgentCommandOptions) => agentsCommand('replace', agents, options))
  command
    .command('refresh')
    .description('Refresh instructions in the selected scope')
    .option('--scope <scope>', 'Configuration scope: local (default) or shared', 'local')
    .option('--json', 'Output a machine-readable report')
    .action((options: AgentCommandOptions) => agentsCommand('refresh', [], options))
  command
    .command('list')
    .description('List configured support and discovered files without probing runtimes')
    .option('--json', 'Output a machine-readable inventory')
    .action((options: AgentCommandOptions) => agentsCommand('list', [], options))
}
