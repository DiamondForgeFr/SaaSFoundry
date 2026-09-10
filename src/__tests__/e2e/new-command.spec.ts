import { mkdir, readFile, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import shelljs from 'shelljs'

import { createApiApp } from '../../builders/api.builder'
import { createWebApp } from '../../builders/web.builder'
import { createMonorepoRoot } from '../../builders/monorepo.builder'
import { createDevServicesCompose } from '../../builders/dev-services.builder'
import { installSkills } from '../../installers/skills.installer'
import { computeFileHashes } from '../../utils'
import { SaaSFoundryManifest } from '../../types'
import { expectFileExists } from '../helpers/assertions'
import { apiParams, webParams, monorepoRootParams } from '../helpers/fixtures'
import { installSelectedAgentInstructions, writeMultirepoAgentManifests } from '../../installers/agent-topology'

/**
 * E2E tests for the `sf new` command flow.
 *
 * Since newCommand() relies on interactive prompts, browser opening, and terminal spawning,
 * we test the core orchestration: builders → skills → manifest generation.
 * This simulates what newCommand does without the interactive parts.
 */
describe('newCommand flow (E2E)', () => {
  let tempDir: string
  let originalCwd: string
  let shellSpy: jest.SpyInstance

  beforeEach(async () => {
    tempDir = join(tmpdir(), `sf-e2e-new-${Date.now()}`)
    originalCwd = process.cwd()
    await mkdir(tempDir, { recursive: true })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    shellSpy = jest.spyOn(shelljs, 'exec').mockImplementation((() => ({ code: 0, stdout: '10.0.0', stderr: '' })) as any)
  })

  afterEach(async () => {
    shellSpy.mockRestore()
    process.chdir(originalCwd)
    await rm(tempDir, { recursive: true, force: true }).catch(() => {})
  })

  it('projects the multirepo manifest and selected agent entrypoints into both app checkouts', async () => {
    const projectDir = join(tempDir, 'agent-multi')
    await mkdir(join(projectDir, 'apps/agent-multi-api/.claude/skills'), { recursive: true })
    await mkdir(join(projectDir, 'apps/agent-multi-web/.claude/skills'), { recursive: true })
    await mkdir(join(projectDir, 'apps/agent-multi-api'), { recursive: true })
    await mkdir(join(projectDir, 'apps/agent-multi-web'), { recursive: true })
    await Promise.all([writeFile(join(projectDir, 'apps/agent-multi-api/CLAUDE.md'), '# agent-multi API\n'), writeFile(join(projectDir, 'apps/agent-multi-web/CLAUDE.md'), '# agent-multi web\n')])

    const manifest: SaaSFoundryManifest = {
      version: '1.0.0-beta',
      generatedAt: new Date().toISOString(),
      structure: 'multirepo',
      projectName: 'agent-multi',
      modules: { harness: { version: 1, agents: ['claude-code', 'codex', 'gemini-cli'] } }
    }
    const originalCwd = process.cwd()
    process.chdir(projectDir)
    try {
      await writeMultirepoAgentManifests(manifest, 'agent-multi')
      await installSelectedAgentInstructions(manifest, 'agent-multi', ['claude-code', 'codex', 'gemini-cli'])
    } finally {
      process.chdir(originalCwd)
    }

    for (const app of ['agent-multi-api', 'agent-multi-web']) {
      const appRoot = join(projectDir, 'apps', app)
      const appManifest = JSON.parse(await readFile(join(appRoot, '.saasfoundry.json'), 'utf8'))
      expect(appManifest.structure).toBe('cli')
      expect(appManifest.projectName).toBe(app)
      expect(appManifest.modules.harness.agents).toEqual(['claude-code', 'codex', 'gemini-cli'])
      expect(Object.keys(appManifest.modules).sort()).toEqual(['advancedSkills', 'harness'])
      expect(await readFile(join(appRoot, 'AGENTS.md'), 'utf8')).toContain('SaaSFoundry agent instructions')
      expect(await readFile(join(appRoot, 'GEMINI.md'), 'utf8')).toContain('@AGENTS.md')
    }
  })

  /**
   * Simulate the newCommand flow for a given configuration.
   * This mirrors the logic in src/commands/new.ts without prompts/runners.
   */
  async function simulateNewCommand(config: {
    projectName: string
    isMonorepo: boolean
    dbSetup: 'docker' | 'credentials' | 'manual'
    s3Setup: 'docker' | 'credentials' | 'manual'
    emailService: 'none' | 'mailersend'
    includeAnalytics: boolean
  }) {
    const projectDir = join(tempDir, config.projectName)
    await mkdir(join(projectDir, 'apps'), { recursive: true })
    process.chdir(projectDir)

    // Step 1: Create API app
    await createApiApp(
      apiParams({
        isMonorepo: config.isMonorepo,
        projectName: config.projectName,
        emailService: config.emailService,
        mailersendApiKey: config.emailService === 'mailersend' ? 'ms-test-key' : undefined,
        mailersendSenderEmail: config.emailService === 'mailersend' ? 'noreply@test.com' : undefined,
        mailersendSenderName: config.emailService === 'mailersend' ? 'Test' : undefined,
        s3Setup: config.s3Setup,
        dbCredentials: config.dbSetup !== 'manual' ? { host: 'localhost', port: '5435', user: 'dev', password: 'dev', database: 'dev', dbType: 'postgresql' } : undefined
      })
    )

    // Step 2: Dev services (if docker)
    const hasDevServices = config.dbSetup === 'docker' || config.s3Setup === 'docker'
    if (hasDevServices) {
      const devApiPath = config.isMonorepo ? 'apps/api' : `apps/${config.projectName}-api`
      await createDevServicesCompose({
        apiPath: devApiPath,
        projectName: config.projectName,
        dbSetup: config.dbSetup,
        s3Setup: config.s3Setup
      })
    }

    // Step 3: Create Web app
    await createWebApp(
      webParams({
        isMonorepo: config.isMonorepo,
        projectName: config.projectName,
        s3Setup: config.s3Setup,
        includeAnalytics: config.includeAnalytics
      })
    )

    // Step 4: Monorepo root (if applicable)
    if (config.isMonorepo) {
      await createMonorepoRoot(
        monorepoRootParams({
          projectName: config.projectName
        })
      )
    }

    // Step 5: Install skills
    const skillsApiPath = config.isMonorepo ? 'apps/api' : `apps/${config.projectName}-api`
    const skillsWebPath = config.isMonorepo ? 'apps/web' : `apps/${config.projectName}-web`
    await installSkills({
      isMonorepo: config.isMonorepo,
      apiPath: skillsApiPath,
      webPath: skillsWebPath,
      projectName: config.projectName,
      version: '1.0.0-beta'
    })

    // Step 6: Generate manifest
    const fileHashes = await computeFileHashes('.')
    const manifest: SaaSFoundryManifest = {
      version: '1.0.0-beta',
      generatedAt: new Date().toISOString(),
      structure: config.isMonorepo ? 'monorepo' : 'multirepo',
      projectName: config.projectName,
      modules: {
        email: { provider: config.emailService, version: 1 },
        s3Setup: config.s3Setup,
        dbSetup: config.dbSetup,
        includeAnalytics: config.includeAnalytics,
        advancedSkills: []
      },
      fileHashes
    }
    const { writeFile } = await import('fs/promises')
    await writeFile('.saasfoundry.json', JSON.stringify(manifest, null, 2))

    return manifest
  }

  // ── Scenario 1: Minimal Multirepo ───────────────────────────

  describe('Scenario 1: Minimal multirepo', () => {
    it('should create a complete project', async () => {
      const manifest = await simulateNewCommand({
        projectName: 'minimal',
        isMonorepo: false,
        dbSetup: 'manual',
        s3Setup: 'manual',
        emailService: 'none',
        includeAnalytics: false
      })

      expect(manifest.structure).toBe('multirepo')
      await expectFileExists(join(tempDir, 'minimal/apps/minimal-api/src/main.ts'))
      await expectFileExists(join(tempDir, 'minimal/apps/minimal-web/src/main.tsx'))
      await expectFileExists(join(tempDir, 'minimal/.saasfoundry.json'))
    })
  })

  // ── Scenario 2: Full Monorepo ───────────────────────────────

  describe('Scenario 2: Full monorepo', () => {
    it('should create a monorepo with all features', async () => {
      const manifest = await simulateNewCommand({
        projectName: 'full-mono',
        isMonorepo: true,
        dbSetup: 'docker',
        s3Setup: 'docker',
        emailService: 'mailersend',
        includeAnalytics: true
      })

      expect(manifest.structure).toBe('monorepo')
      expect(manifest.modules!.email).toEqual({ provider: 'mailersend', version: 1 })
      expect(manifest.modules!.includeAnalytics).toBe(true)

      await expectFileExists(join(tempDir, 'full-mono/apps/api/src/main.ts'))
      await expectFileExists(join(tempDir, 'full-mono/apps/web/src/main.tsx'))
      await expectFileExists(join(tempDir, 'full-mono/apps/api/docker-compose.dev-services.yml'))
    })
  })

  // ── Scenario 3: Multirepo with Docker DB ────────────────────

  describe('Scenario 3: Multirepo with Docker DB', () => {
    it('should create dev services compose with DB only', async () => {
      const manifest = await simulateNewCommand({
        projectName: 'db-only',
        isMonorepo: false,
        dbSetup: 'docker',
        s3Setup: 'manual',
        emailService: 'none',
        includeAnalytics: false
      })

      expect(manifest.modules!.dbSetup).toBe('docker')

      const composeContent = await readFile(join(tempDir, 'db-only/apps/db-only-api/docker-compose.dev-services.yml'), 'utf8')
      expect(composeContent).toContain('db-dev:')
      expect(composeContent).not.toContain('s3-dev:')
    })
  })

  // ── Scenario 4: Monorepo with email only ────────────────────

  describe('Scenario 4: Monorepo with email', () => {
    it('should activate email module and keep storage disabled', async () => {
      const manifest = await simulateNewCommand({
        projectName: 'email-only',
        isMonorepo: true,
        dbSetup: 'manual',
        s3Setup: 'manual',
        emailService: 'mailersend',
        includeAnalytics: false
      })

      expect(manifest.modules!.email).toEqual({ provider: 'mailersend', version: 1 })

      const emailService = await readFile(join(tempDir, 'email-only/apps/api/src/modules/email/services/email.service.ts'), 'utf8')
      expect(emailService).not.toContain("console.log('html', html)")
    })
  })

  // ── Scenario 5: Analytics only ──────────────────────────────

  describe('Scenario 5: Multirepo with analytics', () => {
    it('should activate analytics module', async () => {
      const manifest = await simulateNewCommand({
        projectName: 'analytics-app',
        isMonorepo: false,
        dbSetup: 'manual',
        s3Setup: 'manual',
        emailService: 'none',
        includeAnalytics: true
      })

      expect(manifest.modules!.includeAnalytics).toBe(true)

      const mainTsx = await readFile(join(tempDir, 'analytics-app/apps/analytics-app-web/src/main.tsx'), 'utf8')
      expect(mainTsx).toContain("import { initAnalytics } from '@/lib/analytics/analytics'")
    })
  })

  // ── Manifest Integrity ──────────────────────────────────────

  describe('manifest integrity', () => {
    it('should generate non-empty fileHashes', async () => {
      const manifest = await simulateNewCommand({
        projectName: 'hash-check',
        isMonorepo: false,
        dbSetup: 'manual',
        s3Setup: 'manual',
        emailService: 'none',
        includeAnalytics: false
      })

      expect(manifest.fileHashes).toBeDefined()
      expect(Object.keys(manifest.fileHashes!).length).toBeGreaterThan(10)

      // Verify hashes are valid SHA-256
      for (const hash of Object.values(manifest.fileHashes!)) {
        expect(hash).toMatch(/^[a-f0-9]{64}$/)
      }
    })

    it('should not include .env in fileHashes', async () => {
      const manifest = await simulateNewCommand({
        projectName: 'no-env-hash',
        isMonorepo: false,
        dbSetup: 'manual',
        s3Setup: 'manual',
        emailService: 'none',
        includeAnalytics: false
      })

      const paths = Object.keys(manifest.fileHashes!)
      const envPaths = paths.filter((p) => p.endsWith('.env') || p.endsWith('.env.test'))
      expect(envPaths).toHaveLength(0)
    })
  })
})
