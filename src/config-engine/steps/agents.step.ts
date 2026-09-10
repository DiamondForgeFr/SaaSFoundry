import { listAgentProfiles } from '../../harness/agent-registry'
import { FieldDefinition, StepDefinition } from '../types'

const agentChoices: FieldDefinition['choices'] = listAgentProfiles().map((profile) => ({
  name: `${profile.displayName} (${profile.id})`,
  value: profile.id,
  checked: profile.id === 'claude-code'
}))

/** Select the coding-agent adapters deposited into the generated harness. */
export const agentsStep: StepDefinition = {
  id: 'agents',
  title: 'Coding agents',
  appliesTo: (state) => state.profile !== 'stack',
  fields: [
    {
      type: 'checkbox',
      name: 'agents',
      message: 'Which coding-agent tools should this project support?',
      choices: agentChoices,
      default: ['claude-code']
    }
  ],
  decisions: (collected) => [{ stepId: 'agents', name: 'agents', value: collected.agents }]
}
