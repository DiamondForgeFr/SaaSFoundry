#!/usr/bin/env node
// ── Docker Build Test Harness ──────────────────────────────────
// Generates real SaaSFoundryAI projects and validates they build.
// Runs inside Docker via `Dockerfile.test`.
//
// Usage:
//   TEST_SCENARIO=multirepo-minimal node --import tsx generate-and-build.ts
//   TEST_SCENARIO=all node --import tsx generate-and-build.ts
//   node --import tsx generate-and-build.ts  # runs all scenarios

import { execFileSync, execSync, spawn, spawnSync } from 'child_process'
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { createRequire } from 'module'
import { join } from 'path'

import {
  assertApiBuildOutput,
  assertDirExists,
  assertFileContains,
  assertFileExists,
  assertPwaBuildOutput,
  assertClaudeMdConfigured,
  assertMonorepoBuildOutput,
  assertMonorepoSharedPackages,
  assertMonorepoEmailSharedTypes,
  assertMonorepoStorageSharedConfig,
  assertMonorepoUiPrimitives,
  assertMultirepoEmailInlined,
  assertMultirepoStorageInlined,
  assertMultirepoUiPrimitivesUntouched,
  assertMonorepoSkills,
  assertMultirepoSkills,
  assertWebBuildOutput,
  assertWorkflowSkill,
  AssertionResult,
  reportResults,
  scanForUnreplacedPlaceholders
} from './assertions'
import { auditCriticalWorkspaces } from './npm-audit'
import { ALL_SCENARIOS, getScenario, getTopScenarios, GenerationScenario, UpdateScenario, AIScenario, MigrationScenario, TestScenario, CliScenario, BootScenario } from './scenarios'

// ── Config ─────────────────────────────────────────────────────

const WORKSPACE = process.env.WORKSPACE_DIR || '/workspace/projects'
const CLI_PATH = process.env.CLI_PATH || '/cli'
const SCENARIO_ENV = process.env.TEST_SCENARIO || 'all'

// ── Shell Helper ───────────────────────────────────────────────

function run(cmd: string, cwd: string, label?: string, timeoutMs = 300_000): void {
  const displayLabel = label || cmd.slice(0, 80)
  console.log(`  > ${displayLabel}`)
  try {
    execSync(cmd, {
      cwd,
      stdio: 'pipe',
      timeout: timeoutMs,
      env: {
        ...process.env,
        HUSKY: '0',
        CI: 'true',
        npm_config_loglevel: 'error',
        // Prisma needs this even for generate (schema parsing)
        DATABASE_URL: process.env.DATABASE_URL || 'postgresql://test:test@localhost:5432/test'
      }
    })
    console.log(`    Done`)
  } catch (err: unknown) {
    const error = err as { stdout?: Buffer; stderr?: Buffer }
    const stdout = error.stdout?.toString().slice(-2000) || ''
    const stderr = error.stderr?.toString().slice(-2000) || ''
    console.error(`    FAILED: ${displayLabel}`)
    if (stdout) console.error(`    stdout: ${stdout}`)
    if (stderr) console.error(`    stderr: ${stderr}`)
    throw new Error(`Command failed: ${cmd}`)
  }
}

// ── Project Generation (uses CLI builders directly) ────────────

async function generateProject(scenario: GenerationScenario | (UpdateScenario['base'] & { projectName: string })): Promise<string> {
  const projectDir = join(WORKSPACE, scenario.projectName)
  mkdirSync(join(projectDir, 'apps'), { recursive: true })

  const originalCwd = process.cwd()
  process.chdir(projectDir)

  try {
    // Import builders from the built CLI
    const { createApiApp } = await import(join(CLI_PATH, 'dist', 'builders', 'api.builder'))
    const { createWebApp } = await import(join(CLI_PATH, 'dist', 'builders', 'web.builder'))
    const { createMonorepoRoot } = await import(join(CLI_PATH, 'dist', 'builders', 'monorepo.builder'))
    const { createDevServicesCompose } = await import(join(CLI_PATH, 'dist', 'builders', 'dev-services.builder'))
    const { installSkills } = await import(join(CLI_PATH, 'dist', 'installers', 'skills.installer'))

    // Create API
    await createApiApp({
      isMonorepo: scenario.isMonorepo,
      projectName: scenario.projectName,
      projectDescription: `Docker test: ${scenario.projectName}`,
      backendRepoUrl: 'https://github.com/test/test-api.git',
      dbCredentials: scenario.dbSetup !== 'manual' ? { host: 'localhost', port: '5435', user: 'dev', password: 'dev', database: 'dev', dbType: 'postgresql' as const } : undefined,
      mainBranch: 'main',
      emailService: scenario.emailService,
      mailersendApiKey: scenario.emailService === 'mailersend' ? 'ms-test-key' : undefined,
      mailersendSenderEmail: scenario.emailService === 'mailersend' ? 'noreply@test.com' : undefined,
      mailersendSenderName: scenario.emailService === 'mailersend' ? 'Test' : undefined,
      s3Setup: scenario.s3Setup,
      s3Credentials:
        scenario.s3Setup === 'credentials' ? { endpoint: 'http://localhost:9000', accessKey: 'minioadmin', secretKey: 'minioadmin', bucket: 'test-uploads', region: 'us-east-1' } : undefined
    })

    // Dev services (if docker)
    const hasDevServices = scenario.dbSetup === 'docker' || scenario.s3Setup === 'docker'
    if (hasDevServices) {
      const apiPath = scenario.isMonorepo ? 'apps/api' : `apps/${scenario.projectName}-api`
      await createDevServicesCompose({
        apiPath,
        projectName: scenario.projectName,
        dbSetup: scenario.dbSetup,
        s3Setup: scenario.s3Setup
      })
    }

    // Create Web
    await createWebApp({
      isMonorepo: scenario.isMonorepo,
      projectName: scenario.projectName,
      projectDescription: `Docker test: ${scenario.projectName}`,
      frontendRepoUrl: 'https://github.com/test/test-web.git',
      mainBranch: 'main',
      s3Setup: scenario.s3Setup,
      includeAnalytics: scenario.includeAnalytics,
      includePwa: scenario.includePwa === true
    })

    // Monorepo root
    if (scenario.isMonorepo) {
      await createMonorepoRoot({
        projectName: scenario.projectName,
        projectDescription: `Docker test: ${scenario.projectName}`,
        monorepoUrl: 'https://github.com/test/test-mono.git',
        mainBranch: 'main'
      })
    }

    // Install skills
    const apiPath = scenario.isMonorepo ? 'apps/api' : `apps/${scenario.projectName}-api`
    const webPath = scenario.isMonorepo ? 'apps/web' : `apps/${scenario.projectName}-web`
    await installSkills({
      isMonorepo: scenario.isMonorepo,
      apiPath,
      webPath,
      projectName: scenario.projectName,
      version: '1.0.0-beta'
    })

    // Write a minimal .saasfoundry.json manifest
    writeFileSync(
      join(projectDir, '.saasfoundry.json'),
      JSON.stringify(
        {
          version: '1.0.0-beta',
          generatedAt: new Date().toISOString(),
          structure: scenario.isMonorepo ? 'monorepo' : 'multirepo',
          projectName: scenario.projectName,
          modules: {
            email: { provider: scenario.emailService, version: 1 },
            s3Setup: scenario.s3Setup,
            dbSetup: scenario.dbSetup,
            includeAnalytics: scenario.includeAnalytics,
            advancedSkills: [],
            ...(scenario.includePwa === true ? { pwa: { version: 1 } } : {})
          }
        },
        null,
        2
      )
    )

    return projectDir
  } finally {
    process.chdir(originalCwd)
  }
}

// ── Build Commands ─────────────────────────────────────────────

function buildMultirepoApi(projectDir: string, projectName: string): void {
  const apiPath = join(projectDir, 'apps', `${projectName}-api`)
  run('npm install --ignore-scripts', apiPath, 'npm install (API)')
  run('npx prisma generate', apiPath, 'prisma generate')
  run('npx nest build', apiPath, 'nest build')
}

function buildMultirepoWeb(projectDir: string, projectName: string): void {
  const webPath = join(projectDir, 'apps', `${projectName}-web`)
  run('npm install --ignore-scripts', webPath, 'npm install (Web)')
  run('npx tsc -b', webPath, 'tsc -b (Web)')
  run('npx vite build', webPath, 'vite build')
}

function buildMonorepo(projectDir: string): void {
  run('npm install --ignore-scripts', projectDir, 'npm install (monorepo root)')
  run('npx prisma generate', join(projectDir, 'apps', 'api'), 'prisma generate')
  run('npm run lint', projectDir, 'lint all monorepo workspaces')
  run('npx turbo run build', projectDir, 'turbo run build')
}

type OpenApiDocument = {
  paths?: Record<string, unknown>
}

const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds))

async function stopProcessGroup(child: ReturnType<typeof spawn>): Promise<void> {
  if (!child.pid) return

  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return
    throw error
  }

  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    try {
      process.kill(-child.pid, 0)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return
      throw error
    }
    await wait(50)
  }

  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
  }
}

/**
 * Recreate the checked-in snapshot through the generated application's real bootstrap.
 * Removing it first prevents the scaffold fixture from satisfying the wait by itself.
 */
async function emitOpenApiDocument(projectDir: string): Promise<string> {
  const apiDir = join(projectDir, 'apps', 'api')
  const openApiPath = join(apiDir, 'docs', 'openapi.json')
  const logPath = join(projectDir, 'openapi-emission.log')
  if (existsSync(openApiPath)) unlinkSync(openApiPath)

  startPostgres()
  const databaseUrl = 'postgresql://dev:dev@localhost:5432/devdb'

  const log = openSync(logPath, 'a')
  const child = spawn(process.execPath, ['dist/src/main.js'], {
    cwd: apiDir,
    detached: true,
    stdio: ['ignore', log, log],
    env: {
      ...process.env,
      HUSKY: '0',
      CI: 'true',
      NODE_ENV: 'development',
      DATABASE_URL: databaseUrl,
      DIRECT_URL: databaseUrl
    }
  })

  try {
    const deadline = Date.now() + 30_000
    while (!existsSync(openApiPath)) {
      if (child.exitCode !== null || child.signalCode !== null) {
        const tail = existsSync(logPath) ? readFileSync(logPath, 'utf8').slice(-2_000) : '(no output captured)'
        throw new Error(`generated API exited before emitting OpenAPI (exit=${child.exitCode}, signal=${child.signalCode})\n--- server output ---\n${tail}`)
      }
      if (Date.now() >= deadline) throw new Error('generated API did not emit docs/openapi.json within 30 seconds')
      await wait(100)
    }
    return openApiPath
  } finally {
    await stopProcessGroup(child)
    closeSync(log)
  }
}

async function validateGeneratedApiContract(projectDir: string, projectName: string): Promise<AssertionResult[]> {
  console.log('  > emit and validate OpenAPI, regenerate client, type-check client')
  const openApiPath = await emitOpenApiDocument(projectDir)
  const require = createRequire(join(process.cwd(), 'package.json'))
  const SwaggerParser = require('@apidevtools/swagger-parser') as {
    validate(path: string): Promise<OpenApiDocument>
  }
  const document = await SwaggerParser.validate(openApiPath)

  run('npm run codegen:api-client', projectDir, 'regenerate api-client from emitted OpenAPI')
  run(`npm run type-check -w @${projectName}/api-client`, projectDir, 'type-check regenerated api-client')

  return [
    {
      passed: Object.prototype.hasOwnProperty.call(document.paths || {}, '/api/health'),
      message: Object.prototype.hasOwnProperty.call(document.paths || {}, '/api/health')
        ? 'OK: validated emitted OpenAPI includes /api/health'
        : 'FAIL: validated emitted OpenAPI is missing /api/health'
    }
  ]
}

// ── Scenario Runners ───────────────────────────────────────────

async function runGenerationScenario(scenario: GenerationScenario): Promise<boolean> {
  console.log(`\nGenerating project: ${scenario.projectName} (${scenario.isMonorepo ? 'monorepo' : 'multirepo'})`)

  const projectDir = await generateProject(scenario)

  console.log(`Building...`)
  if (scenario.isMonorepo) {
    buildMonorepo(projectDir)
  } else {
    buildMultirepoApi(projectDir, scenario.projectName)
    buildMultirepoWeb(projectDir, scenario.projectName)
  }

  // Assertions
  const results: AssertionResult[] = []

  if (scenario.validateApiContract === true) {
    results.push(...(await validateGeneratedApiContract(projectDir, scenario.projectName)))
  }

  if (scenario.auditDependencies === true) {
    console.log('  > npm audit (critical) across generated workspaces')
    results.push(...auditCriticalWorkspaces(projectDir))
  }

  const storageInstalled = scenario.s3Setup !== 'manual'
  const emailInstalled = scenario.emailService === 'mailersend'

  if (scenario.isMonorepo) {
    results.push(...assertMonorepoBuildOutput(projectDir))
    results.push(...assertMonorepoSharedPackages(projectDir, scenario.projectName))
    results.push(...assertMonorepoUiPrimitives(projectDir, scenario.projectName))
    if (storageInstalled) results.push(...assertMonorepoStorageSharedConfig(projectDir, scenario.projectName))
    if (emailInstalled) results.push(...assertMonorepoEmailSharedTypes(projectDir, scenario.projectName))
  } else {
    const apiPath = join(projectDir, 'apps', `${scenario.projectName}-api`)
    results.push(...assertApiBuildOutput(apiPath))
    results.push(...assertWebBuildOutput(join(projectDir, 'apps', `${scenario.projectName}-web`)))
    results.push(...assertMultirepoUiPrimitivesUntouched(join(projectDir, 'apps', `${scenario.projectName}-web`)))
    if (storageInstalled) results.push(...assertMultirepoStorageInlined(apiPath))
    if (emailInstalled) results.push(...assertMultirepoEmailInlined(apiPath))
  }

  // The PWA module ships build artefacts, not just source config — assert what actually
  // reaches dist/, since that is all the browser ever sees.
  if (scenario.includePwa === true) {
    const webPath = scenario.isMonorepo ? join(projectDir, 'apps', 'web') : join(projectDir, 'apps', `${scenario.projectName}-web`)
    results.push(...assertPwaBuildOutput(webPath))
  }

  results.push(scanForUnreplacedPlaceholders(projectDir))

  return reportResults(scenario.name, results)
}

async function runUpdateScenario(scenario: UpdateScenario): Promise<boolean> {
  console.log(`\nGenerating base project: ${scenario.base.projectName}`)

  const projectDir = await generateProject({ ...scenario.base })

  // Build base project first to verify it works
  console.log(`Building base project...`)
  if (scenario.base.isMonorepo) {
    buildMonorepo(projectDir)
  } else {
    buildMultirepoApi(projectDir, scenario.base.projectName)
    buildMultirepoWeb(projectDir, scenario.base.projectName)
  }

  // Apply module updates
  const originalCwd = process.cwd()
  process.chdir(projectDir)

  try {
    const apiPath = scenario.base.isMonorepo ? 'apps/api' : `apps/${scenario.base.projectName}-api`
    const webPath = scenario.base.isMonorepo ? 'apps/web' : `apps/${scenario.base.projectName}-web`

    if (scenario.addModules.email) {
      console.log(`Installing email module...`)
      const { installEmailModule } = await import(join(CLI_PATH, 'dist', 'installers', 'email.installer'))
      await installEmailModule({
        apiPath,
        isMonorepo: scenario.base.isMonorepo,
        projectName: scenario.base.projectName,
        mailersendApiKey: 'ms-test-key',
        mailersendSenderEmail: 'noreply@test.com',
        mailersendSenderName: 'Test'
      })
    }

    if (scenario.addModules.storage) {
      console.log(`Installing storage module...`)
      const { installStorageModule } = await import(join(CLI_PATH, 'dist', 'installers', 'storage.installer'))
      await installStorageModule({
        apiPath,
        webPath,
        isMonorepo: scenario.base.isMonorepo,
        projectName: scenario.base.projectName,
        s3Setup: 'docker',
        skipNpmInstall: true
      })
    }

    if (scenario.addModules.analytics) {
      console.log(`Installing analytics module...`)
      const { installAnalyticsModule } = await import(join(CLI_PATH, 'dist', 'installers', 'analytics.installer'))
      await installAnalyticsModule({ webPath })
    }
  } finally {
    process.chdir(originalCwd)
  }

  // Rebuild after module installation
  console.log(`Rebuilding after module installation...`)
  if (scenario.base.isMonorepo) {
    // Reinstall to get new deps (e.g., @aws-sdk/client-s3)
    run('npm install --ignore-scripts', projectDir, 'npm install (post-update)')
    run('npx prisma generate', join(projectDir, 'apps', 'api'), 'prisma generate (post-update)')
    run('npx turbo run build --force', projectDir, 'turbo run build --force')
  } else {
    const apiPath = join(projectDir, 'apps', `${scenario.base.projectName}-api`)
    const webPath = join(projectDir, 'apps', `${scenario.base.projectName}-web`)
    run('npm install --ignore-scripts', apiPath, 'npm install (API post-update)')
    run('npx prisma generate', apiPath, 'prisma generate (post-update)')
    run('npx nest build', apiPath, 'nest build (post-update)')
    run('npm install --ignore-scripts', webPath, 'npm install (Web post-update)')
    run('npx tsc -b', webPath, 'tsc -b (Web post-update)')
    run('npx vite build', webPath, 'vite build (post-update)')
  }

  // Assertions
  const results: AssertionResult[] = []

  if (scenario.base.isMonorepo) {
    results.push(...assertMonorepoBuildOutput(projectDir))
    results.push(...assertMonorepoSharedPackages(projectDir, scenario.base.projectName))
    results.push(...assertMonorepoUiPrimitives(projectDir, scenario.base.projectName))
    if (scenario.addModules.storage) results.push(...assertMonorepoStorageSharedConfig(projectDir, scenario.base.projectName))
    if (scenario.addModules.email) results.push(...assertMonorepoEmailSharedTypes(projectDir, scenario.base.projectName))
  } else {
    const apiPath = join(projectDir, 'apps', `${scenario.base.projectName}-api`)
    results.push(...assertApiBuildOutput(apiPath))
    results.push(...assertWebBuildOutput(join(projectDir, 'apps', `${scenario.base.projectName}-web`)))
    results.push(...assertMultirepoUiPrimitivesUntouched(join(projectDir, 'apps', `${scenario.base.projectName}-web`)))
    if (scenario.addModules.storage) results.push(...assertMultirepoStorageInlined(apiPath))
    if (scenario.addModules.email) results.push(...assertMultirepoEmailInlined(apiPath))
  }

  results.push(scanForUnreplacedPlaceholders(projectDir))

  return reportResults(scenario.name, results)
}

async function runAIScenario(scenario: AIScenario): Promise<boolean> {
  console.log(`\nGenerating project for AI checks: ${scenario.projectName}`)

  // Generate a minimal project (no build needed)
  const genConfig: GenerationScenario = {
    type: 'generation',
    name: scenario.name,
    projectName: scenario.projectName,
    isMonorepo: scenario.isMonorepo,
    dbSetup: 'manual',
    s3Setup: 'manual',
    emailService: 'none',
    includeAnalytics: false
  }

  const projectDir = await generateProject(genConfig)

  // For workflow checks, also install workflow skill
  if (scenario.checks.includes('workflow')) {
    const originalCwd = process.cwd()
    process.chdir(projectDir)
    try {
      const { installWorkflowSkill } = await import(join(CLI_PATH, 'dist', 'installers', 'workflow-skill.installer'))
      const targetPath = scenario.isMonorepo ? '.' : `apps/${scenario.projectName}-api`
      await installWorkflowSkill({
        targetPath,
        workflow: {
          tool: 'github-projects',
          projectUrl: 'https://github.com/test/test-project/projects/1',
          workingBranch: 'develop',
          prTargetBranch: 'develop',
          statuses: [
            { name: 'Backlog', color: 'GRAY' },
            { name: 'Ready', color: 'YELLOW' },
            { name: 'In Progress', color: 'BLUE' },
            { name: 'Done', color: 'GREEN' }
          ],
          branchNaming: { feature: 'feature/{ticket}-{description}', fix: 'fix/{ticket}-{description}' },
          template: 'saasfoundry-ai'
        },
        projectUrl: 'https://github.com/test/test-project/projects/1'
      })
    } finally {
      process.chdir(originalCwd)
    }
  }

  const results: AssertionResult[] = []

  // Skills checks
  if (scenario.checks.includes('skills')) {
    if (scenario.isMonorepo) {
      results.push(...assertMonorepoSkills(projectDir))
    } else {
      const apiPath = join(projectDir, 'apps', `${scenario.projectName}-api`)
      const webPath = join(projectDir, 'apps', `${scenario.projectName}-web`)
      results.push(...assertMultirepoSkills(apiPath, webPath))
    }
  }

  // CLAUDE.md checks
  if (scenario.checks.includes('claude-md')) {
    if (scenario.isMonorepo) {
      results.push(...assertClaudeMdConfigured(join(projectDir, 'CLAUDE.md'), scenario.projectName))
    } else {
      const apiPath = join(projectDir, 'apps', `${scenario.projectName}-api`)
      const webPath = join(projectDir, 'apps', `${scenario.projectName}-web`)
      results.push(...assertClaudeMdConfigured(join(apiPath, 'CLAUDE.md'), scenario.projectName))
      results.push(...assertClaudeMdConfigured(join(webPath, 'CLAUDE.md'), scenario.projectName))
    }
  }

  // Workflow checks
  if (scenario.checks.includes('workflow')) {
    if (scenario.isMonorepo) {
      results.push(...assertWorkflowSkill(join(projectDir, '.claude', 'skills', 'sf-workflow')))
    } else {
      results.push(...assertWorkflowSkill(join(projectDir, 'apps', `${scenario.projectName}-api`, '.claude', 'skills', 'sf-workflow')))
    }

    // Verify CLAUDE.md has workflow section
    const wfClaudeMdPath = scenario.isMonorepo ? join(projectDir, 'CLAUDE.md') : join(projectDir, 'apps', `${scenario.projectName}-api`, 'CLAUDE.md')
    results.push(...assertClaudeMdConfigured(wfClaudeMdPath, scenario.projectName))
  }

  // Placeholder scan (no build dirs to worry about)
  results.push(scanForUnreplacedPlaceholders(projectDir))

  return reportResults(scenario.name, results)
}

async function runMigrationScenario(scenario: MigrationScenario): Promise<boolean> {
  console.log(`\nGenerating project for migration check: ${scenario.projectName}`)

  // Reuse generateProject's minimal generation; we don't need a build for this scenario.
  const projectDir = await generateProject({
    projectName: scenario.projectName,
    isMonorepo: scenario.isMonorepo,
    dbSetup: 'manual',
    s3Setup: 'manual',
    emailService: 'none',
    includeAnalytics: false
  })

  // Overwrite the manifest with a v0-shape (legacy) version: no $schema, no
  // manifestVersion. This simulates a project scaffolded before Epic #310
  // shipped, which is the input the migration framework must rescue.
  const manifestPath = join(projectDir, '.saasfoundry.json')
  const legacyManifest = {
    version: '0.9.0',
    generatedAt: '2026-01-15T00:00:00.000Z',
    structure: scenario.isMonorepo ? 'monorepo' : 'multirepo',
    projectName: scenario.projectName,
    modules: {
      emailService: 'none',
      s3Setup: 'manual',
      dbSetup: 'manual',
      includeAnalytics: false,
      advancedSkills: []
    }
  }
  writeFileSync(manifestPath, JSON.stringify(legacyManifest, null, 2))

  // Invoke the update command programmatically against the legacy manifest.
  // Non-interactive + no module additions so the run hits the migration
  // step then early-returns at the "no modules to install" branch — this is
  // exactly the path that previously dropped the $schema stamp on the floor.
  const originalCwd = process.cwd()
  process.chdir(projectDir)
  try {
    const { updateCommand } = await import(join(CLI_PATH, 'dist', 'commands', 'update'))
    // addModules='' → parseAddModules returns [] → prefill.selectedModules = []
    // (an empty CSV is the contract for "non-interactive run that adds nothing")
    await updateCommand({ nonInteractive: true, acceptTemplateUpdates: false, addModules: '' })
  } finally {
    process.chdir(originalCwd)
  }

  // Read back the manifest and check the dispatcher did its job.
  const after = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>

  const expectedSchema = 'https://raw.githubusercontent.com/DiamondForgeFr/SaasFoundryAI/master/schemas/saasfoundry-manifest.schema.json'

  const schemaOk = after.$schema === expectedSchema
  const versionOk = typeof after.manifestVersion === 'number' && after.manifestVersion >= 1
  const fieldsOk = after.projectName === scenario.projectName && after.version === '0.9.0'
  const firstKeyOk = Object.keys(after)[0] === '$schema'

  // Migration 002 must have lifted the legacy flat `emailService` enum into
  // the nested `email.{provider, version}` object — this catches a chain
  // that stops mid-way (e.g. registry not appended-to when adding migrations).
  const modules = (after.modules ?? {}) as Record<string, unknown>
  const emailShape = (modules.email ?? null) as { provider?: unknown; version?: unknown } | null
  const emailMigrated = emailShape !== null && emailShape.provider === 'none' && typeof emailShape.version === 'number' && !('emailService' in modules)

  const results: AssertionResult[] = [
    {
      passed: schemaOk,
      message: schemaOk ? `OK: $schema stamped (${expectedSchema})` : `FAIL: expected $schema=${expectedSchema}, got ${String(after.$schema)}`
    },
    {
      passed: versionOk,
      message: versionOk ? `OK: manifestVersion=${after.manifestVersion} (>= 1)` : `FAIL: expected manifestVersion >= 1, got ${String(after.manifestVersion)}`
    },
    {
      passed: fieldsOk,
      message: fieldsOk ? `OK: original fields preserved (projectName + version)` : `FAIL: projectName=${String(after.projectName)} version=${String(after.version)}`
    },
    {
      passed: firstKeyOk,
      message: firstKeyOk ? `OK: $schema is first key (sf new parity)` : `FAIL: first key=${Object.keys(after)[0]}`
    },
    {
      passed: emailMigrated,
      message: emailMigrated
        ? `OK: modules.email migrated to {provider, version} and legacy emailService dropped`
        : `FAIL: expected modules.email={provider,version} and no emailService, got ${JSON.stringify(modules)}`
    }
  ]

  return reportResults(scenario.name, results)
}

// ── CLI Scenario (runs the real binary as a subprocess) ────────

/**
 * The only scenario type that executes `bin/sf.js`.
 *
 * Everything else reaches past it: the generation scenarios call the builders and create
 * the project directory themselves, and the migration one imports `updateCommand`. So the
 * bin entrypoint, Commander, the non-interactive flag validation, and everything `sf new`
 * does before delegating were covered by nothing — which is why a criterion as plain as
 * "the project folder is created alongside, not inside" (#537) had to be checked by hand.
 *
 * The workspace is seeded with pre-existing content on purpose. `alongside` only means
 * something when there is something to be alongside of, and it is the cheapest way to
 * catch a command that scaffolds over a user's files.
 */
async function runCliScenario(scenario: CliScenario): Promise<boolean> {
  const workspace = join(WORKSPACE, `cli-${scenario.name}`)
  mkdirSync(join(workspace, 'existing-src'), { recursive: true })
  writeFileSync(join(workspace, 'PREEXISTING.md'), 'this file existed before sf new ran\n')
  writeFileSync(join(workspace, 'existing-src', 'poc.js'), 'console.log("poc")\n')

  // The harness profile deposits onto an existing repository, so give it one.
  run('git init -q && git add -A && git -c user.email=t@t -c user.name=t commit -qm seed', workspace, 'seed a repository')

  console.log(`\nRunning the CLI for real: sf new --profile ${scenario.profile}`)

  const bin = join(CLI_PATH, 'bin', 'sf.js')
  const flags = [
    'new',
    '--non-interactive',
    `--project-name ${scenario.projectName}`,
    `--project-description "docker cli scenario: ${scenario.name}"`,
    `--structure ${scenario.isMonorepo ? 'monorepo' : 'multirepo'}`,
    '--main-branch main',
    '--setup-repo local',
    `--profile ${scenario.profile}`,
    '--db-setup manual',
    '--email-service none',
    '--s3-setup manual',
    '--start-apps none',
    '--no-analytics'
  ].join(' ')

  run(`node ${bin} ${flags}`, workspace, `sf new --profile ${scenario.profile}`)

  const projectDir = join(workspace, scenario.projectName)
  const results: AssertionResult[] = []

  if (scenario.profile === 'harness') {
    // The damaging failure mode: harness must scaffold nothing. Getting this wrong lays a
    // full stack over a repository the user intends to keep (#510).
    results.push({
      passed: !existsSync(projectDir),
      message: !existsSync(projectDir) ? 'OK: harness created no project directory' : `FAIL: harness created ${scenario.projectName}/ — it must deposit into the cwd and scaffold nothing`
    })
    results.push(assertFileExists(join(workspace, '.saasfoundry.json')))
    results.push(assertFileContains(join(workspace, '.saasfoundry.json'), '"structure": "cli"'))
    results.push(assertDirExists(join(workspace, '.claude')))
    results.push(assertFileExists(join(workspace, 'CLAUDE.md')))

    // Exercise multi-agent setup in this existing quick Linux scenario rather than adding
    // another scaffold/build to the matrix. The generated harness has no workflow in
    // non-interactive mode, so install the same bounded fixture used by ai-workflow-config
    // before asking the real CLI to project it into the shared agent directory.
    const { installWorkflowSkill } = await import(join(CLI_PATH, 'dist', 'installers', 'workflow-skill.installer'))
    await installWorkflowSkill({
      targetPath: workspace,
      workflow: {
        tool: 'github-projects',
        projectUrl: 'https://github.com/test/test-project/projects/1',
        workingBranch: 'develop',
        prTargetBranch: 'develop',
        statuses: [
          { name: 'Backlog', color: 'GRAY' },
          { name: 'Ready', color: 'YELLOW' },
          { name: 'In Progress', color: 'BLUE' },
          { name: 'Done', color: 'GREEN' }
        ],
        branchNaming: { feature: 'feature/{ticket}-{description}', fix: 'fix/{ticket}-{description}' },
        template: 'saasfoundry-ai'
      },
      projectUrl: 'https://github.com/test/test-project/projects/1'
    })

    const agentHome = join(WORKSPACE, `.home-${scenario.name}`)
    const agentTmp = join(WORKSPACE, `.tmp-${scenario.name}`)
    mkdirSync(agentHome, { recursive: true })
    mkdirSync(agentTmp, { recursive: true })
    writeFileSync(join(agentHome, '.gitconfig'), '')
    const agentEnv: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
      HOME: agentHome,
      TMPDIR: agentTmp,
      TEMP: agentTmp,
      TMP: agentTmp,
      LANG: process.env.LANG ?? 'C.UTF-8',
      CI: 'true',
      HUSKY: '0',
      SF_SKILL_NO_WARN: '1',
      GIT_CONFIG_GLOBAL: join(agentHome, '.gitconfig'),
      GIT_CONFIG_NOSYSTEM: '1'
    }
    const agentsJson = (...args: string[]) =>
      JSON.parse(
        execFileSync(process.execPath, [bin, 'agents', ...args, '--json'], {
          cwd: workspace,
          encoding: 'utf8',
          timeout: 30_000,
          maxBuffer: 1024 * 1024,
          env: agentEnv
        })
      ) as { configuredAgents: string[]; sharedAgents: string[]; localAgents: string[] }

    const shared = agentsJson('enable', 'codex', 'gemini-cli', '--scope', 'shared')
    results.push({
      passed: ['claude-code', 'codex', 'gemini-cli'].every((agent) => shared.sharedAgents.includes(agent)),
      message: `Shared agent coexistence: ${shared.sharedAgents.join(', ')}`
    })

    const sharedWorkflow = join(workspace, '.agents', 'skills', 'sf-workflow')
    const sharedCli = join(sharedWorkflow, 'workflow-cli.sh')
    const sharedSkill = join(sharedWorkflow, 'SKILL.md')
    for (const path of [join(workspace, 'CLAUDE.md'), join(workspace, 'AGENTS.md'), join(workspace, 'GEMINI.md'), sharedCli, sharedSkill]) {
      const regular = existsSync(path) && lstatSync(path).isFile()
      results.push({ passed: regular, message: regular ? `OK: ${path} is a regular file` : `FAIL: ${path} is missing, linked, or not a regular file` })
    }
    const guardExecutable = existsSync(sharedCli) && (lstatSync(sharedCli).mode & 0o111) !== 0
    results.push({ passed: guardExecutable, message: guardExecutable ? `OK: ${sharedCli} is executable` : `FAIL: ${sharedCli} is not executable` })
    if (existsSync(sharedCli) && existsSync(sharedSkill)) {
      const sharedSkillContent = readFileSync(sharedSkill, 'utf8')
      results.push({
        passed:
          readFileSync(sharedCli).equals(readFileSync(join(workspace, '.claude', 'skills', 'sf-workflow', 'workflow-cli.sh'))) &&
          /workflow/i.test(sharedSkillContent) &&
          sharedSkillContent.includes('../../../.claude/docs/manifest-schema.md'),
        message: 'Shared workflow CLI is copied exactly and SKILL.md has its shared-directory documentation links'
      })
    }

    // These negative assertions only add signal on Docker's case-sensitive Linux
    // filesystem. They catch adapters that happen to work on a default macOS checkout.
    for (const wrongCase of ['agents.md', 'gemini.md', '.Agents', '.agents/Skills']) {
      const absent = !existsSync(join(workspace, wrongCase))
      results.push({ passed: absent, message: absent ? `OK: wrong-case path ${wrongCase} is absent` : `FAIL: wrong-case path ${wrongCase} exists` })
    }

    execFileSync('git', ['add', '-A'], { cwd: workspace, env: agentEnv, timeout: 30_000, maxBuffer: 1024 * 1024 })
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'shared agent support'], {
      cwd: workspace,
      env: agentEnv,
      timeout: 30_000,
      maxBuffer: 1024 * 1024
    })
    const sharedManifest = readFileSync(join(workspace, '.saasfoundry.json'))
    const local = agentsJson('enable', 'kimi', '--scope', 'local')
    const inventory = agentsJson('list')
    const cleanAfterLocal = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: workspace, encoding: 'utf8', env: agentEnv, timeout: 30_000, maxBuffer: 1024 * 1024 }) === ''
    results.push({ passed: local.localAgents.includes('kimi'), message: `Local agents after enable: ${local.localAgents.join(', ') || '(none)'}` })
    results.push({
      passed: inventory.localAgents.includes('kimi') && ['claude-code', 'codex', 'gemini-cli'].every((agent) => inventory.sharedAgents.includes(agent)),
      message: `Isolated inventory — shared: ${inventory.sharedAgents.join(', ')}; local: ${inventory.localAgents.join(', ') || '(none)'}`
    })
    results.push({
      passed: readFileSync(join(workspace, '.saasfoundry.json')).equals(sharedManifest) && cleanAfterLocal,
      message: cleanAfterLocal ? 'Local enable preserved the shared manifest and tracked tree' : 'FAIL: local enable changed the tracked tree'
    })

    const guardBefore = [readFileSync(sharedCli), readFileSync(sharedSkill), readFileSync(join(workspace, '.saasfoundry.json'))]
    const guard = spawnSync(sharedCli, ['help'], { cwd: workspace, encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024, env: agentEnv })
    const guardAfter = [readFileSync(sharedCli), readFileSync(sharedSkill), readFileSync(join(workspace, '.saasfoundry.json'))]
    const guardReadOnly =
      guardBefore.every((content, index) => content.equals(guardAfter[index])) &&
      execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: workspace, encoding: 'utf8', env: agentEnv, timeout: 30_000, maxBuffer: 1024 * 1024 }) === ''
    const guardPassed = guard.status === 0 && /workflow/i.test(guard.stdout) && guardReadOnly
    const guardFailure = guard.error ? 'spawn-error' : guard.status === null ? 'terminated' : guard.status !== 0 ? 'nonzero-exit' : !guardReadOnly ? 'fixture-changed' : 'unexpected-output'
    results.push({
      passed: guardPassed,
      message: guardPassed
        ? 'Shared guarded workflow CLI help executed read-only'
        : `FAIL: shared guarded workflow CLI help category=${guardFailure} exit=${String(guard.status)} signal=${guard.signal ?? 'none'}`
    })
  } else {
    // The placement criterion #537 could not lean on any test for.
    results.push(assertDirExists(projectDir))
    results.push(assertFileExists(join(projectDir, '.saasfoundry.json')))
    results.push({
      passed: !existsSync(join(workspace, '.saasfoundry.json')),
      message: !existsSync(join(workspace, '.saasfoundry.json'))
        ? 'OK: the manifest is inside the project, not in the working directory'
        : 'FAIL: a manifest was written into the working directory — the full profile must scaffold into its own directory'
    })
    results.push({
      passed: !existsSync(join(workspace, 'existing-src', scenario.projectName)),
      message: !existsSync(join(workspace, 'existing-src', scenario.projectName))
        ? 'OK: the project was not created inside pre-existing content'
        : 'FAIL: the project landed inside existing-src/ — it must be a sibling'
    })
  }

  // True of both profiles: the command may add, never trample.
  results.push(assertFileContains(join(workspace, 'PREEXISTING.md'), 'this file existed before sf new ran'))
  results.push(assertFileContains(join(workspace, 'existing-src', 'poc.js'), 'console.log("poc")'))

  return reportResults(scenario.name, results)
}

// ── Boot Scenario ──────────────────────────────────────────────

/**
 * A step whose failure says which step it was.
 *
 * "scenario failed" after eight minutes is not usable. Every stage of this scenario runs
 * through here so the report names install, database setup, boot, audit or the unit suite.
 */
async function runStep<T>(label: string, fn: () => Promise<T> | T): Promise<T> {
  console.log(`  > ${label}`)
  try {
    const value = await fn()
    console.log(`    Done`)
    return value
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    throw new Error(`step "${label}" failed: ${detail}`)
  }
}

/** Starts the cluster baked into the image and creates the role and database the project expects. */
function startPostgres(): void {
  const pg = (cmd: string) => execSync(`su postgres -c ${JSON.stringify(cmd)}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

  try {
    pg(`pg_ctl -D ${process.env.PGDATA} status`)
  } catch {
    pg(`pg_ctl -D ${process.env.PGDATA} -o "-c listen_addresses=localhost" -l /tmp/pg.log start -w -t 30`)
  }

  if (pg(`psql -tAc "SELECT 1 FROM pg_roles WHERE rolname = 'dev'"`).trim() !== '1') pg('createuser -s dev')
  if (pg(`psql -tAc "SELECT 1 FROM pg_database WHERE datname = 'devdb'"`).trim() !== '1') pg('createdb -O dev devdb')
}

interface Server {
  label: string
  stop: () => void
}

/**
 * Starts a long-running command and hands back a way to stop it.
 *
 * `detached` so the whole process group can be signalled: `npm run dev` is a shell that
 * spawns nest or vite, and killing only the shell leaves the server holding its port —
 * which would then look like a port conflict to whatever runs next.
 */
function startServer(label: string, cmd: string, cwd: string, logPath: string): Server {
  const log = openSync(logPath, 'a')
  const child = spawn(cmd, {
    cwd,
    shell: true,
    detached: true,
    stdio: ['ignore', log, log],
    env: { ...process.env, HUSKY: '0', CI: 'true', NODE_ENV: 'development' }
  })
  child.unref()

  return {
    label,
    stop: () => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGTERM')
      } catch {
        // Already gone — the scenario failing is what matters, not the teardown.
      }
    }
  }
}

/**
 * Polls a URL until it answers 200, or gives up and says what it saw.
 *
 * A bounded wait, never a sleep: the point of the scenario is that the server answers,
 * and a fixed sleep would turn "slow" and "dead" into the same result.
 */
async function waitForHttp(url: string, timeoutSeconds: number, logPath: string): Promise<void> {
  const deadline = Date.now() + timeoutSeconds * 1000
  let lastError = 'no attempt completed'

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5_000) })
      if (response.ok) return
      lastError = `HTTP ${response.status}`
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }

  // The server's own output is the only thing that explains a boot failure, so it travels
  // with the error rather than staying in a file nobody reads.
  const tail = existsSync(logPath) ? readFileSync(logPath, 'utf8').slice(-2000) : '(no output captured)'
  throw new Error(`${url} did not answer 200 within ${timeoutSeconds}s (last: ${lastError})\n--- server output ---\n${tail}`)
}

/**
 * The scenario that starts the project.
 *
 * `--db-setup credentials` against the local cluster is not a shortcut around the docker
 * path: `initAndStartDb` runs `db:setup:dev` for `credentials` exactly as it does for
 * `docker`, skipping only `docker compose up` — which has no meaning inside a container
 * that already has its database. Prisma generate, `prisma db push` and the SQL under
 * `prisma/sql/` all run for real.
 */
async function runBootScenario(scenario: BootScenario): Promise<boolean> {
  const workspace = join(WORKSPACE, `boot-${scenario.name}`)
  mkdirSync(workspace, { recursive: true })

  const projectDir = join(workspace, scenario.projectName)
  const apiDir = join(projectDir, 'apps', `${scenario.projectName}-api`)
  const webDir = join(projectDir, 'apps', `${scenario.projectName}-web`)
  const apiLog = join(workspace, 'api-dev.log')
  const webLog = join(workspace, 'web-dev.log')

  const servers: Server[] = []
  const results: AssertionResult[] = []

  try {
    await runStep('start postgres', () => startPostgres())

    await runStep('sf new --start-services', () => {
      const bin = join(CLI_PATH, 'bin', 'sf.js')
      const flags = [
        'new',
        '--non-interactive',
        `--project-name ${scenario.projectName}`,
        `--project-description "docker boot scenario"`,
        '--structure multirepo',
        '--main-branch main',
        '--setup-repo local',
        '--profile stack',
        '--db-setup credentials',
        '--db-host localhost',
        '--db-port 5432',
        '--db-user dev',
        '--db-password dev',
        '--db-name devdb',
        '--email-service none',
        '--s3-setup manual',
        '--no-analytics',
        '--no-workflow',
        '--no-srs-enable',
        '--start-services',
        '--start-apps none'
      ].join(' ')
      // A real npm install on two apps plus a prisma generate outruns the default 5 minutes.
      run(`node ${bin} ${flags}`, workspace, 'sf new (real install, db setup, prisma generate)', 900_000)
    })

    // The ports the project chose. Anything else would be assuming what #584 made variable.
    const manifest = JSON.parse(readFileSync(join(projectDir, '.saasfoundry.json'), 'utf8'))
    const ports = manifest.ports || { api: 3500, web: 5173 }
    console.log(`  · the project resolved api=${ports.api} web=${ports.web}`)

    await runStep(`api boot — GET /api/health on ${ports.api}`, async () => {
      servers.push(startServer('api', 'npm run dev', apiDir, apiLog))
      await waitForHttp(`http://localhost:${ports.api}/api/health`, scenario.bootTimeoutSeconds, apiLog)
    })
    results.push({ passed: true, message: `OK: the API answered /api/health on ${ports.api}` })

    await runStep(`web boot — GET / on ${ports.web}`, async () => {
      servers.push(startServer('web', 'npm run dev', webDir, webLog))
      await waitForHttp(`http://localhost:${ports.web}/`, scenario.bootTimeoutSeconds, webLog)
    })
    results.push({ passed: true, message: `OK: the web app answered / on ${ports.web}` })

    await runStep('npm audit (critical)', () => {
      results.push(...auditCriticalWorkspaces(projectDir))
    })

    await runStep('api npm run test:unit', () => {
      try {
        execSync('npm run test:unit', { cwd: apiDir, stdio: 'pipe', timeout: 600_000 })
        results.push({ passed: true, message: 'OK: the api unit suite the project ships passes' })
      } catch (err) {
        const error = err as { stdout?: Buffer; stderr?: Buffer }
        const output = `${error.stdout?.toString().slice(-2000) || ''}${error.stderr?.toString().slice(-2000) || ''}`
        results.push({ passed: false, message: `FAIL: the api unit suite is red\n${output}` })
      }
    })
  } catch (err) {
    results.push({ passed: false, message: `FAIL: ${err instanceof Error ? err.message : String(err)}` })
  } finally {
    for (const server of servers) server.stop()
  }

  return reportResults(scenario.name, results)
}

// ── Scenario Dispatcher ────────────────────────────────────────

async function runScenario(scenario: TestScenario): Promise<boolean> {
  switch (scenario.type) {
    case 'generation':
      return runGenerationScenario(scenario)
    case 'update':
      return runUpdateScenario(scenario)
    case 'migration':
      return runMigrationScenario(scenario)
    case 'ai':
      return runAIScenario(scenario)
    case 'cli':
      return runCliScenario(scenario)
    case 'boot':
      return runBootScenario(scenario)
  }
}

// ── Main ───────────────────────────────────────────────────────

async function main() {
  console.log('SaaSFoundryAI Docker Build Tests')
  console.log('==============================')

  // Ensure workspace exists
  mkdirSync(WORKSPACE, { recursive: true })

  // Determine which scenarios to run
  // TEST_SCENARIO supports: "all", a number (top N by priority), or scenario name(s)
  let scenarios: TestScenario[]
  const countEnv = process.env.TEST_COUNT

  if (SCENARIO_ENV === 'all' && !countEnv) {
    scenarios = ALL_SCENARIOS
  } else if (/^\d+$/.test(SCENARIO_ENV)) {
    scenarios = getTopScenarios(parseInt(SCENARIO_ENV, 10))
  } else if (countEnv && /^\d+$/.test(countEnv)) {
    scenarios = getTopScenarios(parseInt(countEnv, 10))
  } else {
    // Single scenario or comma-separated list
    scenarios = SCENARIO_ENV.split(',')
      .map((s) => s.trim())
      .map(getScenario)
  }

  console.log(`\nRunning ${scenarios.length} scenario(s): ${scenarios.map((s) => s.name).join(', ')}`)

  const results: { name: string; passed: boolean }[] = []

  for (const [index, scenario] of scenarios.entries()) {
    // [sf-progress] markers are the greppable progress contract for agent
    // harnesses streaming this run (tail -f | grep) — see workflow SKILL.md
    // "ANNOUNCE + STREAM LONG COMMANDS" (#436). Keep the format stable.
    console.log(`[sf-progress] scenario ${index + 1}/${scenarios.length} ${scenario.name} — started`)
    try {
      const passed = await runScenario(scenario)
      results.push({ name: scenario.name, passed })
      console.log(`[sf-progress] scenario ${index + 1}/${scenarios.length} ${scenario.name} — ${passed ? 'passed' : 'failed'}`)
    } catch (error) {
      console.error(`\nScenario "${scenario.name}" crashed:`, error instanceof Error ? error.message : error)
      results.push({ name: scenario.name, passed: false })
      console.log(`[sf-progress] scenario ${index + 1}/${scenarios.length} ${scenario.name} — crashed`)
    }
  }

  // Final report
  console.log(`\n${'='.repeat(60)}`)
  console.log('FINAL RESULTS')
  console.log(`${'='.repeat(60)}`)

  const passed = results.filter((r) => r.passed).length
  const failed = results.filter((r) => !r.passed).length

  for (const result of results) {
    console.log(`  ${result.passed ? 'PASS' : 'FAIL'} ${result.name}`)
  }

  console.log(`\n${passed} passed, ${failed} failed out of ${results.length} scenarios`)

  if (failed > 0) {
    process.exit(1)
  }
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
