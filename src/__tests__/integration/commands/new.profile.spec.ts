import { mkdir, readFile, readdir, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

import inquirer from 'inquirer'

jest.mock('inquirer')

jest.mock('../../../utils', () => ({
  ...jest.requireActual('../../../utils'),
  checkNodeVersion: jest.fn(),
  computeFileHashes: jest.fn().mockResolvedValue({})
}))

jest.mock('../../../builders/api.builder', () => ({ createApiApp: jest.fn() }))
jest.mock('../../../builders/web.builder', () => ({ createWebApp: jest.fn() }))
jest.mock('../../../builders/monorepo.builder', () => ({ createMonorepoRoot: jest.fn() }))
jest.mock('../../../builders/dev-services.builder', () => ({ createDevServicesCompose: jest.fn() }))
jest.mock('../../../installers/skills.installer', () => ({ ...jest.requireActual('../../../installers/skills.installer'), installSkills: jest.fn() }))

jest.mock('../../../runners/database.runner', () => ({ initAndStartDb: jest.fn() }))
jest.mock('../../../runners/s3.runner', () => ({ initAndStartS3: jest.fn() }))
jest.mock('../../../runners/server.runner', () => ({
  startBackend: jest.fn(),
  startFrontend: jest.fn(),
  startMonorepoApps: jest.fn(),
  waitForServer: jest.fn()
}))
jest.mock('../../../runners/terminal.runner', () => ({
  openTerminal: jest.fn(),
  getHuskySetupCommand: jest.fn().mockReturnValue('')
}))

jest.mock('ora', () => () => ({
  start: () => ({ text: '', succeed: jest.fn(), fail: jest.fn() })
}))

jest.mock('terminal-link', () => ({
  __esModule: true,
  default: (text: string) => text
}))

import { newCommand } from '../../../commands/new'
import { createApiApp } from '../../../builders/api.builder'
import { createWebApp } from '../../../builders/web.builder'
import { collectStatus } from '../../../status/collect'
import { evaluatePreconditions } from '../../../status/preconditions'

const mockedPrompt = inquirer.prompt as unknown as jest.Mock
const mockedCreateApiApp = createApiApp as jest.MockedFunction<typeof createApiApp>
const mockedCreateWebApp = createWebApp as jest.MockedFunction<typeof createWebApp>

describe('newCommand (--profile integration)', () => {
  let tempDir: string
  let originalCwd: string
  let logSpy: jest.SpyInstance

  beforeEach(async () => {
    tempDir = join(tmpdir(), `sf-int-profile-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    originalCwd = process.cwd()
    await mkdir(tempDir, { recursive: true })
    process.chdir(tempDir)

    jest.clearAllMocks()
    mockedPrompt.mockImplementation(((_questions: unknown, answers: Record<string, unknown>) => Promise.resolve(answers ?? {})) as never)
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(async () => {
    logSpy.mockRestore()
    process.chdir(originalCwd)
    await rm(tempDir, { recursive: true, force: true }).catch(() => {})
  })

  const stackOpts = {
    nonInteractive: true,
    profile: 'stack' as const,
    projectName: 'acme',
    projectDescription: 'd',
    structure: 'multirepo' as const,
    mainBranch: 'main' as const,
    setupRepo: 'local' as const,
    dbSetup: 'manual' as const,
    s3Setup: 'manual' as const,
    emailService: 'none' as const,
    analytics: false
  }

  it('stack profile scaffolds the stack with no workflow, skills or SRS in the manifest', async () => {
    await newCommand(stackOpts)

    expect(mockedCreateApiApp).toHaveBeenCalledTimes(1)
    expect(mockedCreateWebApp).toHaveBeenCalledTimes(1)
    const apiParams = mockedCreateApiApp.mock.calls[0][0]
    expect(apiParams.workflow).toBeUndefined()
    expect(apiParams.advancedSkills ?? []).toEqual([])

    const manifest = JSON.parse(await readFile('.saasfoundry.json', 'utf8'))
    expect(manifest.workflow).toBeUndefined()
    expect(manifest.tools).toBeUndefined()
    expect(manifest.modules.advancedSkills).toEqual([])
  })

  it('stack profile never asks workflow/skills/SRS questions', async () => {
    await newCommand(stackOpts)

    const askedNames = mockedPrompt.mock.calls.flatMap((call) => (call[0] as { name: string }[]).map((q) => q.name))
    expect(askedNames).not.toContain('srsEnable')
    expect(askedNames).not.toContain('configureWorkflow')
  })

  it('harness profile installs the AI harness onto the existing repo without scaffolding', async () => {
    await newCommand({
      nonInteractive: true,
      profile: 'harness',
      projectName: 'acme',
      mainBranch: 'main'
    })

    expect(mockedCreateApiApp).not.toHaveBeenCalled()
    expect(mockedCreateWebApp).not.toHaveBeenCalled()

    // Minimal manifest: structure cli, harness deposits version+hash-tracked
    // (scoped to the deposit dirs only — never the user's own code)
    const manifest = JSON.parse(await readFile('.saasfoundry.json', 'utf8'))
    expect(manifest).toMatchObject({ structure: 'cli', projectName: 'acme', mainBranch: 'main' })
    expect(manifest.modules).toEqual({ harness: { version: 1 }, advancedSkills: [] })
    // computeFileHashes is mocked to {} in this spec — the field wiring is
    // asserted here, real hash content is covered by the installer unit spec.
    expect(manifest.fileHashes).toBeDefined()
    for (const trackedPath of Object.keys(manifest.fileHashes)) {
      expect(trackedPath).toMatch(/^(?:\.claude\/(?:skills|docs)\/|AGENTS\.md$|GEMINI\.md$)/)
    }

    // Harness deposits, no scaffold directories
    expect(await readFile('CLAUDE.md', 'utf8')).toContain('# acme')
    expect(await readFile('AGENTS.md', 'utf8')).toContain('SaaSFoundry agent instructions')
    expect(await readFile('GEMINI.md', 'utf8')).toContain('@AGENTS.md')
    const settings = JSON.parse(await readFile(join(tempDir, '.claude', 'settings.json'), 'utf8'))
    expect(JSON.stringify(settings.hooks.SessionStart)).toContain('sf status --claude-friendly --no-network')
    expect(await readdir(tempDir)).not.toContain('apps')

    // TC-1: sf status preconditions all pass on the harness install
    const report = await collectStatus(tempDir, { checkNetwork: false })
    const failing = evaluatePreconditions(report).filter((p) => p.status === 'fail')
    expect(failing).toEqual([])
  })

  // Covers the S4 scenarios of #514, which were only validated by hand: a fresh
  // project must carry the block, and the flag must reach all three surfaces.
  it('writes the language block at English defaults when --language is not passed', async () => {
    await newCommand({ nonInteractive: true, profile: 'harness', projectName: 'acme', mainBranch: 'main' })

    const manifest = JSON.parse(await readFile('.saasfoundry.json', 'utf8'))
    expect(manifest.language).toEqual({ srs: 'en', tickets: 'en', codeComments: 'en' })
  })

  it('applies --language to all three surfaces', async () => {
    await newCommand({ nonInteractive: true, profile: 'harness', projectName: 'acme', mainBranch: 'main', language: 'fr' })

    const manifest = JSON.parse(await readFile('.saasfoundry.json', 'utf8'))
    expect(manifest.language).toEqual({ srs: 'fr', tickets: 'fr', codeComments: 'fr' })
  })

  // The stack profile never sees the question — its manifest must still carry
  // the block, or a later `sf update` would be the first to introduce it.
  it('stack profile carries the block at English defaults despite skipping the step', async () => {
    await newCommand(stackOpts)

    const manifest = JSON.parse(await readFile('.saasfoundry.json', 'utf8'))
    expect(manifest.language).toEqual({ srs: 'en', tickets: 'en', codeComments: 'en' })
  })

  it('harness profile refuses to run when a manifest already exists', async () => {
    const { writeFile: write } = jest.requireActual<typeof import('fs/promises')>('fs/promises')
    await write(join(tempDir, '.saasfoundry.json'), '{"structure":"cli","projectName":"x","version":"1.0.0"}')

    await expect(
      newCommand({
        nonInteractive: true,
        profile: 'harness',
        projectName: 'acme',
        mainBranch: 'main'
      })
    ).rejects.toThrow(/already has a \.saasfoundry\.json/)

    expect(mockedCreateApiApp).not.toHaveBeenCalled()
  })

  it('defaults to the full profile in non-interactive mode without --profile (regression guard)', async () => {
    await newCommand({ ...stackOpts, profile: undefined })

    expect(mockedCreateApiApp).toHaveBeenCalledTimes(1)
    const manifest = JSON.parse(await readFile('.saasfoundry.json', 'utf8'))
    expect(manifest.projectName).toBe('acme')
  })
})
