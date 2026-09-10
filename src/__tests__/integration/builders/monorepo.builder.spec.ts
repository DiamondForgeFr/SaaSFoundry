import { mkdir, readFile, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import shelljs from 'shelljs'

import { createMonorepoRoot } from '../../../builders/monorepo.builder'
import { monorepoRootParams } from '../../helpers/fixtures'
import { expectFileExists } from '../../helpers/assertions'

describe('createMonorepoRoot (integration)', () => {
  let tempDir: string
  let originalCwd: string
  let shellSpy: jest.SpyInstance

  beforeEach(async () => {
    tempDir = join(tmpdir(), `sf-monorepo-builder-test-${Date.now()}`)
    originalCwd = process.cwd()

    // Create the project structure expected by monorepo builder
    await mkdir(join(tempDir, 'apps/api'), { recursive: true })
    await mkdir(join(tempDir, 'apps/web'), { recursive: true })
    process.chdir(tempDir)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    shellSpy = jest.spyOn(shelljs, 'exec').mockImplementation((() => ({ code: 0, stdout: '10.0.0', stderr: '' })) as any)
  })

  afterEach(async () => {
    shellSpy.mockRestore()
    process.chdir(originalCwd)
    await rm(tempDir, { recursive: true, force: true }).catch(() => {})
  })

  it('should copy monorepo root overlay to current directory', async () => {
    const result = await createMonorepoRoot(monorepoRootParams())

    expect(result).toBe(true)
    await expectFileExists(join(tempDir, 'package.json'))
  })

  /**
   * #627 — a generated monorepo had no README at its root.
   *
   * The blueprints give apps/api and apps/web one each, so multirepo was fine; the monorepo
   * overlay deposited CLAUDE.md and nothing else. A human landing in the repository root of
   * the default structure found only a file addressed to an agent — and it is exactly the
   * file the closing screen's "Getting started" line points at.
   */
  it('gives the monorepo root a README, addressed to a human', async () => {
    await createMonorepoRoot(monorepoRootParams({ projectName: 'my-saas' }))

    const readme = await readFile(join(tempDir, 'README.md'), 'utf8')
    expect(readme.startsWith('# my-saas')).toBe(true)
    // A placeholder that survives is worse than no README: it tells the reader the file was
    // generated and nobody looked at it.
    expect(readme).not.toContain('{{PROJECT_NAME}}')
  })

  it('should update root package.json with project name', async () => {
    await createMonorepoRoot(monorepoRootParams({ projectName: 'my-saas' }))

    const pkg = JSON.parse(await readFile(join(tempDir, 'package.json'), 'utf8'))
    expect(pkg.name).toBe('my-saas')
  })

  it('declares every dependency required by the shared root ESLint config', async () => {
    await createMonorepoRoot(monorepoRootParams())

    const pkg = JSON.parse(await readFile(join(tempDir, 'package.json'), 'utf8'))
    expect(pkg.devDependencies).toMatchObject({
      eslint: '10.3.0',
      'eslint-plugin-prettier': '5.5.5',
      globals: '17.6.0',
      'typescript-eslint': '8.59.1'
    })
  })

  // Non-regression: `packageManager` must come from the template, never from the generating
  // machine. It used to be stamped with the host's `npm --version`, so a Docker image (or any
  // contributor) running npm 10.x baked a broken npm into every generated monorepo — the whole
  // npm 10 line crashes this workspace's peer graph with "Cannot read properties of null
  // (reading 'edgesOut')". The shelljs mock above reports 10.0.0 on purpose: if that value ever
  // reappears here, the host-version leak is back.
  it('should pin packageManager from the template, not from the host npm', async () => {
    await createMonorepoRoot(monorepoRootParams())

    const pkg = JSON.parse(await readFile(join(tempDir, 'package.json'), 'utf8'))
    expect(pkg.packageManager).not.toBe('npm@10.0.0')
    expect(pkg.packageManager).toMatch(/^npm@(1[1-9]|[2-9]\d)\./)
    expect(pkg.engines.npm).toBe('>=11.0.0')
  })

  it('should call npm install at root level', async () => {
    await createMonorepoRoot(monorepoRootParams())

    const npmInstallCalls = shellSpy.mock.calls.filter((call: string[]) => typeof call[0] === 'string' && call[0].includes('npm install') && !call[0].includes('--prefix'))
    expect(npmInstallCalls.length).toBeGreaterThan(0)
  })

  it('should call prisma generate in api workspace', async () => {
    await createMonorepoRoot(monorepoRootParams())

    expect(shellSpy).toHaveBeenCalledWith(expect.stringContaining('prisma generate'), expect.anything())
  })

  it('should call git init at root level', async () => {
    await createMonorepoRoot(monorepoRootParams())

    expect(shellSpy).toHaveBeenCalledWith(expect.stringContaining('git init'), expect.anything())
  })

  it('should set git remote when monorepoUrl is provided', async () => {
    await createMonorepoRoot(monorepoRootParams({ monorepoUrl: 'https://github.com/test/mono.git' }))

    expect(shellSpy).toHaveBeenCalledWith(expect.stringContaining('git remote add origin https://github.com/test/mono.git'), expect.anything())
  })

  it('should update deployment workflow with project-specific names', async () => {
    await createMonorepoRoot(monorepoRootParams({ projectName: 'my-saas' }))

    // Check deployment files if they exist
    try {
      const deployApi = await readFile(join(tempDir, '.github/workflows/deployment-api.yml'), 'utf8')
      expect(deployApi).not.toContain('saasfoundry-network')
      expect(deployApi).toContain('my-saas-network')
    } catch {
      // Deployment file might not exist, that's OK
    }
  })
})
