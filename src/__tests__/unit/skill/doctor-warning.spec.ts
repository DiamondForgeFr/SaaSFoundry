import { maybeEmitStaleSkillWarning } from '../../../skill/warn'
import { checkSkillStatus } from '../../../skill/update'

jest.mock('../../../skill/update', () => ({ checkSkillStatus: jest.fn() }))

describe('doctor startup isolation', () => {
  it('does not inspect the user skill installation or emit its advisory', async () => {
    await maybeEmitStaleSkillWarning(['node', 'sf', 'agents', 'doctor', '--json'], '1.0.0')
    expect(checkSkillStatus).not.toHaveBeenCalled()
  })
})
