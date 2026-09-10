import { mkdir, rm, readFile } from 'fs/promises'
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
import { createMonorepoRoot } from '../../../builders/monorepo.builder'
import { createDevServicesCompose } from '../../../builders/dev-services.builder'
import { installSkills } from '../../../installers/skills.installer'
import { initAndStartDb } from '../../../runners/database.runner'
import { initAndStartS3 } from '../../../runners/s3.runner'
import { openTerminal } from '../../../runners/terminal.runner'

const mockedPrompt = inquirer.prompt as unknown as jest.Mock
const mockedCreateApiApp = createApiApp as jest.MockedFunction<typeof createApiApp>
const mockedCreateWebApp = createWebApp as jest.MockedFunction<typeof createWebApp>
const mockedCreateMonorepoRoot = createMonorepoRoot as jest.MockedFunction<typeof createMonorepoRoot>
const mockedCreateDevServices = createDevServicesCompose as jest.MockedFunction<typeof createDevServicesCompose>
const mockedInstallSkills = installSkills as jest.MockedFunction<typeof installSkills>
const mockedInitAndStartDb = initAndStartDb as jest.MockedFunction<typeof initAndStartDb>
const mockedInitAndStartS3 = initAndStartS3 as jest.MockedFunction<typeof initAndStartS3>
const mockedOpenTerminal = openTerminal as jest.MockedFunction<typeof openTerminal>

describe('newCommand (non-interactive integration)', () => {
  let tempDir: string
  let originalCwd: string
  let logSpy: jest.SpyInstance
  let errorSpy: jest.SpyInstance
  let exitSpy: jest.SpyInstance

  beforeEach(async () => {
    tempDir = join(tmpdir(), `sf-int-new-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    originalCwd = process.cwd()
    await mkdir(tempDir, { recursive: true })
    process.chdir(tempDir)

    jest.clearAllMocks()

    // Simulate Inquirer's native prefill behavior: when all applicable
    // questions are prefilled, inquirer.prompt returns the prefilled answers as-is.
    mockedPrompt.mockImplementation(((_questions: unknown, answers: Record<string, unknown>) => Promise.resolve(answers ?? {})) as never)

    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {})
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
    exitSpy = jest.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`)
    }) as never)
  })

  afterEach(async () => {
    logSpy.mockRestore()
    errorSpy.mockRestore()
    exitSpy.mockRestore()
    process.chdir(originalCwd)
    await rm(tempDir, { recursive: true, force: true }).catch(() => {})
  })

  const baseOpts = {
    nonInteractive: true,
    projectName: 'acme',
    projectDescription: 'My acme project',
    structure: 'multirepo' as const,
    mainBranch: 'main' as const,
    setupRepo: 'local' as const,
    dbSetup: 'manual' as const,
    s3Setup: 'manual' as const,
    emailService: 'none' as const,
    analytics: false,
    workflow: 'none'
  }

  it('runs end-to-end from flags alone without asking the user any question', async () => {
    await newCommand(baseOpts)

    expect(mockedCreateApiApp).toHaveBeenCalledTimes(1)
    expect(mockedCreateWebApp).toHaveBeenCalledTimes(1)
    expect(mockedInstallSkills).toHaveBeenCalledTimes(1)

    // Every prompt call must have received the full prefill (never prompted for real input).
    for (const call of mockedPrompt.mock.calls) {
      expect(call[1]).toBeDefined()
    }
  })

  it('propagates flags through to the API builder', async () => {
    await newCommand({
      nonInteractive: true,
      projectName: 'acme',
      projectDescription: 'd',
      structure: 'multirepo',
      mainBranch: 'main',
      setupRepo: 'local',
      dbSetup: 'credentials',
      dbType: 'postgresql',
      dbHost: 'db.example.com',
      dbPort: '5432',
      dbUser: 'admin',
      dbPassword: 'secret',
      dbName: 'acme_prod',
      s3Setup: 'manual',
      emailService: 'mailersend',
      mailersendApiKey: 'ms-key',
      mailersendSenderEmail: 'hello@acme.com',
      mailersendSenderName: 'Acme',
      analytics: false,
      workflow: 'none'
    })

    expect(mockedCreateApiApp).toHaveBeenCalledWith(
      expect.objectContaining({
        projectName: 'acme',
        isMonorepo: false,
        mainBranch: 'main',
        emailService: 'mailersend',
        mailersendApiKey: 'ms-key',
        mailersendSenderEmail: 'hello@acme.com',
        mailersendSenderName: 'Acme',
        dbCredentials: expect.objectContaining({
          dbType: 'postgresql',
          host: 'db.example.com',
          port: '5432',
          user: 'admin',
          password: 'secret',
          database: 'acme_prod'
        })
      })
    )
  })

  it('writes a manifest reflecting the flags', async () => {
    await newCommand({
      ...baseOpts,
      structure: 'monorepo',
      analytics: true
    })

    // newCommand chdir's into the project directory before writing the manifest
    const manifest = JSON.parse(await readFile('.saasfoundry.json', 'utf8'))
    expect(manifest).toMatchObject({
      projectName: 'acme',
      structure: 'monorepo',
      mainBranch: 'main',
      modules: {
        email: { provider: 'none', version: 1 },
        s3Setup: 'manual',
        dbSetup: 'manual',
        includeAnalytics: true,
        advancedSkills: []
      }
    })
  })

  it('creates a monorepo root when --structure monorepo', async () => {
    await newCommand({ ...baseOpts, structure: 'monorepo' })

    expect(mockedCreateMonorepoRoot).toHaveBeenCalledTimes(1)
  })

  const dockerOpts = {
    ...baseOpts,
    dbSetup: 'docker' as const,
    dbUser: 'postgres',
    dbPassword: 'postgres',
    dbName: 'acme_db',
    s3Setup: 'docker' as const,
    s3Bucket: 'acme-uploads'
  }

  it('does not start services by default in non-interactive mode', async () => {
    await newCommand(dockerOpts)

    expect(mockedInitAndStartDb).not.toHaveBeenCalled()
    expect(mockedInitAndStartS3).not.toHaveBeenCalled()
    expect(mockedOpenTerminal).not.toHaveBeenCalled()
  })

  it('starts services when --start-services is passed', async () => {
    await newCommand({ ...dockerOpts, startServices: true, startApps: 'none' })

    expect(mockedInitAndStartDb).toHaveBeenCalledTimes(1)
    expect(mockedInitAndStartS3).toHaveBeenCalledTimes(1)
    expect(mockedOpenTerminal).not.toHaveBeenCalled()
  })

  it('skips dev services builder when dbSetup=manual and s3Setup=manual', async () => {
    await newCommand(baseOpts)

    expect(mockedCreateDevServices).not.toHaveBeenCalled()
  })

  it('calls the dev services builder when docker services are requested', async () => {
    await newCommand(dockerOpts)

    expect(mockedCreateDevServices).toHaveBeenCalledTimes(1)
  })

  it('surfaces missing required flags as a thrown error (not a hang)', async () => {
    await expect(
      newCommand({
        nonInteractive: true,
        // projectName intentionally missing
        structure: 'multirepo'
      })
    ).rejects.toThrow(/Missing required values in --non-interactive mode/)

    // The profile and agent steps render with non-interactive defaults before
    // the project step throws — the guarantee is that no prompt call
    // ever ran without a complete prefill (i.e. the user was never asked).
    expect(mockedPrompt.mock.calls.length).toBeLessThanOrEqual(2)
    for (const call of mockedPrompt.mock.calls) {
      expect(call[1]).toMatchObject({ profile: 'full' })
    }
  })
})
