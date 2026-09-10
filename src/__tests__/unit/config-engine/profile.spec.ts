import { mkdir, rm } from 'fs/promises'
import { execSync } from 'node:child_process'
import { tmpdir } from 'os'
import { join } from 'path'

import { configSteps } from '../../../config-engine/registry'
import { harnessProjectStep } from '../../../config-engine/steps/harness-project.step'
import { profileStep } from '../../../config-engine/steps/profile.step'
import { ConfigState, FieldDefinition, SessionContext, StepContext } from '../../../config-engine/types'

const sessionCtx: SessionContext = { prefill: {}, nonInteractive: false, derived: {} }

const stepContext = (overrides: Partial<StepContext> = {}): StepContext => ({
  state: {},
  prefill: {},
  nonInteractive: false,
  derived: {},
  render: jest.fn(async () => ({})),
  ...overrides
})

describe('profileStep', () => {
  it('is the first step of the registry', () => {
    expect(configSteps[0].id).toBe('profile')
  })

  it('offers the three intent profiles, defaulting to full', () => {
    const field = (profileStep.fields as FieldDefinition[])[0]
    expect(field.name).toBe('profile')
    expect(field.choices?.map((c) => c.value)).toEqual(['full', 'harness', 'stack'])
    expect(field.default).toBe('full')
  })
})

describe('profile gating across steps', () => {
  const applicable = (state: ConfigState): string[] => configSteps.filter((s) => !s.appliesTo || s.appliesTo(state, sessionCtx)).map((s) => s.id)

  it('full keeps every step', () => {
    expect(applicable({ profile: 'full', emailService: 'mailersend' })).toEqual([
      'profile',
      'agents',
      'project',
      'email-credentials',
      'storage',
      'analytics',
      'pwa',
      'tools',
      'workflow',
      'language',
      'skills',
      'srs'
    ])
  })

  it('harness skips the stack steps and swaps in the detection step (emailService is never collected)', () => {
    expect(applicable({ profile: 'harness' })).toEqual(['profile', 'agents', 'harness-project', 'tools', 'workflow', 'language', 'skills', 'srs'])
  })

  it('stack skips the AI-harness steps', () => {
    expect(applicable({ profile: 'stack', emailService: 'mailersend' })).toEqual(['profile', 'project', 'email-credentials', 'storage', 'analytics', 'pwa'])
  })
})

describe('harnessProjectStep', () => {
  let dir: string
  let originalCwd: string

  beforeEach(async () => {
    dir = join(tmpdir(), `sf-harness-step-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    originalCwd = process.cwd()
    await mkdir(dir, { recursive: true })
    process.chdir(dir)
  })

  afterEach(async () => {
    process.chdir(originalCwd)
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  })

  const initRepo = (branch: string, remote?: string) => {
    execSync(`git init -b ${branch}`, { stdio: 'pipe' })
    execSync('git -c user.email=t@t -c user.name=t commit --allow-empty -m init', { stdio: 'pipe' })
    if (remote) execSync(`git remote add origin ${remote}`, { stdio: 'pipe' })
  }

  it('detects name and branch from the repository without asking', async () => {
    initRepo('master', 'https://github.com/acme/notulias.git')
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {})
    const render = jest.fn<Promise<ConfigState>, [FieldDefinition[]]>(async () => ({}))

    const result = await harnessProjectStep.collect?.(stepContext({ render }))

    expect(result).toEqual({ projectName: 'notulias', mainBranch: 'master' })
    expect(render).not.toHaveBeenCalled()
    logSpy.mockRestore()
  })

  it('lets explicit flags win over detection', async () => {
    initRepo('main')
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {})

    const result = await harnessProjectStep.collect?.(stepContext({ prefill: { projectName: 'custom-name' } }))

    expect(result).toMatchObject({ projectName: 'custom-name', mainBranch: 'main' })
    logSpy.mockRestore()
  })

  it('falls back to asking when the directory is not a git repository (interactive)', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {})
    const render = jest.fn<Promise<ConfigState>, [FieldDefinition[]]>(async () => ({ projectName: 'typed', mainBranch: 'main' }))

    const result = await harnessProjectStep.collect?.(stepContext({ render }))

    expect(render).toHaveBeenCalledTimes(1)
    expect(render.mock.calls[0][0].map((f) => f.name)).toEqual(['projectName', 'mainBranch'])
    expect(result).toMatchObject({ projectName: 'typed' })
    logSpy.mockRestore()
  })

  it('fails fast in non-interactive mode without a repo nor flags', async () => {
    await expect(harnessProjectStep.collect?.(stepContext({ nonInteractive: true }))).rejects.toThrow(/existing git repository/)
  })

  it('accepts explicit flags in non-interactive mode without a repo', async () => {
    const result = await harnessProjectStep.collect?.(stepContext({ nonInteractive: true, prefill: { projectName: 'acme', mainBranch: 'main' } }))

    expect(result).toEqual({ projectName: 'acme', mainBranch: 'main' })
  })

  it('applies only to the harness profile', () => {
    expect(harnessProjectStep.appliesTo?.({ profile: 'harness' }, sessionCtx)).toBe(true)
    expect(harnessProjectStep.appliesTo?.({ profile: 'full' }, sessionCtx)).toBe(false)
    expect(harnessProjectStep.appliesTo?.({}, sessionCtx)).toBe(false)
  })
})
