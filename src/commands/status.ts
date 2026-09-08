import { collectStatus } from '../status/collect'
import { evaluatePreconditions } from '../status/preconditions'
import { renderAgentFriendly, renderHuman, renderJson } from '../status/render'

export interface StatusCommandOptions {
  json?: boolean
  agentFriendly?: boolean
  claudeFriendly?: boolean
  network?: boolean
  checkGh?: boolean
}

export async function statusCommand(options: StatusCommandOptions = {}): Promise<void> {
  const agentFriendly = options.agentFriendly || options.claudeFriendly
  const report = await collectStatus(process.cwd(), {
    checkNetwork: options.network !== false,
    checkGh: options.checkGh === true
  })
  const preconditions = evaluatePreconditions(report)
  const payload = { report, preconditions }

  if (options.json) {
    process.stdout.write(renderJson(payload) + '\n')
  } else if (agentFriendly) {
    process.stdout.write(renderAgentFriendly(payload))
  } else {
    process.stdout.write(renderHuman(payload))
  }

  const hasFail = preconditions.some((p) => p.status === 'fail')
  if (hasFail && !agentFriendly) {
    process.exitCode = 1
  }
}
