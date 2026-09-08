import { Command } from 'commander'
import { enableAgents, readAgentSupport, refreshAgents } from '../harness/agent-support'

interface AgentCommandOptions {
  json?: boolean
  scope?: string
}

export async function agentsCommand(action: 'enable' | 'refresh' | 'list', agents: string[] = [], options: AgentCommandOptions = {}): Promise<void> {
  try {
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
    const result = action === 'enable' ? await enableAgents({ ...params, agents }) : await refreshAgents(params)
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
    const message = error instanceof Error ? error.message : String(error)
    if (options.json) process.stdout.write(JSON.stringify({ error: message }) + '\n')
    else process.stderr.write(`Error: ${message}\n`)
    process.exitCode = 1
  }
}

export function registerAgentCommands(command: Command): void {
  command
    .command('enable')
    .description('Add support without disabling other configured agents')
    .argument('<agents...>', 'claude-code, codex, kimi')
    .option('--scope <scope>', 'Configuration scope: local (default) or shared', 'local')
    .option('--json', 'Output a machine-readable report')
    .action((agents: string[], options: AgentCommandOptions) => agentsCommand('enable', agents, options))
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
