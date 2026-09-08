import { mkdir, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import inquirer from 'inquirer'

import { SaaSFoundryManifest, manifestSchemaUrl } from '../../../types'
import { hashFileContent } from '../../../utils'
import { version as cliVersion } from '../../../../package.json'

jest.mock('inquirer')

jest.mock('../../../utils', () => ({
  ...jest.requireActual('../../../utils'),
  checkNodeVersion: jest.fn()
}))

jest.mock('../../../prompts/update.prompts', () => ({
  ...jest.requireActual('../../../prompts/update.prompts'),
  getModuleSelections: jest.fn().mockResolvedValue([]),
  getEmailModuleCredentials: jest.fn(),
  getStorageModuleConfig: jest.fn(),
  getSkillCredentials: jest.fn()
}))

jest.mock('ora', () => () => {
  const spinner: Record<string, unknown> = { text: '', succeed: jest.fn(), fail: jest.fn(), stop: jest.fn() }
  spinner.start = jest.fn(() => spinner)
  return spinner
})

import { updateCommand } from '../../../commands/update'
import { installHarness } from '../../../installers/harness.installer'

const mockedPrompt = inquirer.prompt as unknown as jest.Mock

const FRESH_VERSION = '0.9.0-test'

// FLOW 1b (#451): harness-only manifests refresh their deposits through the
// same three-way merge as scaffold templates — in-place when untouched,
// sidecar when user-edited, user files outside the sf- scope never touched.
describe('updateCommand — harness deposits refresh (FLOW 1b)', () => {
  let projectDir: string
  let originalCwd: string
  let logSpy: jest.SpyInstance

  const manifestPath = () => join(projectDir, '.saasfoundry.json')

  const writeManifest = async (overrides: Partial<SaaSFoundryManifest>) => {
    const manifest: SaaSFoundryManifest = {
      $schema: manifestSchemaUrl,
      manifestVersion: 2,
      version: FRESH_VERSION,
      generatedAt: new Date().toISOString(),
      structure: 'cli',
      projectName: 'acme',
      mainBranch: 'main',
      ...overrides
    }
    await writeFile(manifestPath(), JSON.stringify(manifest, null, 2))
    return manifest
  }

  const readManifest = async () => JSON.parse(await readFile(manifestPath(), 'utf8'))

  /** Real harness install + hash baseline, as `sf new --profile harness` leaves it. */
  const installTrackedHarness = async () => {
    await installHarness({ targetPath: projectDir, projectName: 'acme', version: FRESH_VERSION })
    const { computeHarnessFileHashes } = jest.requireActual<typeof import('../../../installers/harness.installer')>('../../../installers/harness.installer')
    return computeHarnessFileHashes(projectDir)
  }

  beforeEach(async () => {
    projectDir = join(tmpdir(), `sf-harness-refresh-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    originalCwd = process.cwd()
    await mkdir(projectDir, { recursive: true })
    process.chdir(projectDir)

    jest.clearAllMocks()
    mockedPrompt.mockImplementation(((_q: unknown, answers: Record<string, unknown>) => Promise.resolve({ adoptHarness: true, ...(answers ?? {}) })) as never)
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(async () => {
    logSpy.mockRestore()
    process.chdir(originalCwd)
    await rm(projectDir, { recursive: true, force: true }).catch(() => {})
  })

  it('updates an untouched deposit in place and bumps version + baseline', async () => {
    const hashes = await installTrackedHarness()

    // Simulate an outdated deposit: the file on disk AND the baseline carry
    // the old template content; the current CLI templates differ.
    const stalePath = '.claude/skills/sf-integration-rules/SKILL.md'
    await writeFile(join(projectDir, stalePath), 'old template content\n')
    hashes[stalePath] = hashFileContent('old template content\n')
    await writeManifest({ modules: { harness: { version: 1 } }, fileHashes: hashes })

    await updateCommand({ nonInteractive: true })

    const refreshed = await readFile(join(projectDir, stalePath), 'utf8')
    expect(refreshed).not.toBe('old template content\n')

    const manifest = await readManifest()
    expect(manifest.version).toBe(cliVersion)
    expect(manifest.modules.harness.version).toBe(1)
    expect(manifest.fileHashes[stalePath]).toBe(hashFileContent(refreshed))
  })

  it('preserves enabled agents and shared baselines without adopting customized shared files', async () => {
    const hashes = await installTrackedHarness()
    const sharedPath = '.agents/skills/sf-example/SKILL.md'
    await mkdir(join(projectDir, '.agents/skills/sf-example'), { recursive: true })
    await writeFile(join(projectDir, sharedPath), 'custom shared instructions\n')
    await writeFile(join(projectDir, 'AGENTS.md'), 'custom agent entry point\n')
    const baseline = hashFileContent('original shared instructions\n')
    const entryBaseline = hashFileContent('original entry point\n')
    const harness = { version: 1, agents: ['claude-code', 'codex', 'kimi'] as ('claude-code' | 'codex' | 'kimi')[] }
    await writeManifest({ modules: { harness, advancedSkills: ['context7'] }, fileHashes: { ...hashes, [sharedPath]: baseline, 'AGENTS.md': entryBaseline } })

    await updateCommand({ nonInteractive: true })

    const manifest = await readManifest()
    expect(manifest.modules.harness).toEqual(harness)
    expect(manifest.modules.advancedSkills).toEqual(['context7'])
    expect(manifest.fileHashes[sharedPath]).toBe(baseline)
    expect(manifest.fileHashes['AGENTS.md']).toBe(entryBaseline)
    expect(await readFile(join(projectDir, sharedPath), 'utf8')).toBe('custom shared instructions\n')
    expect(await readFile(join(projectDir, 'AGENTS.md'), 'utf8')).toBe('custom agent entry point\n')
  })

  it('writes a sidecar for a user-edited deposit, never overwriting it', async () => {
    const hashes = await installTrackedHarness()

    // Baseline = an old template; disk = the user's own edit; target = current
    // template. All three differ → conflict → sidecar (save-new default).
    const editedPath = '.claude/skills/sf-integration-rules/SKILL.md'
    hashes[editedPath] = hashFileContent('old template content\n')
    await writeFile(join(projectDir, editedPath), 'my precious user edit\n')
    await writeManifest({ modules: { harness: { version: 1 } }, fileHashes: hashes })

    await updateCommand({ nonInteractive: true })

    expect(await readFile(join(projectDir, editedPath), 'utf8')).toBe('my precious user edit\n')
    const sidecar = await readFile(join(projectDir, `${editedPath}.saasfoundry.new`), 'utf8')
    expect(sidecar).not.toBe('my precious user edit\n')
  })

  it('never touches nor tracks user-authored skills outside the sf- scope', async () => {
    const hashes = await installTrackedHarness()
    const userSkillPath = '.claude/skills/my-custom-skill/SKILL.md'
    await mkdir(join(projectDir, '.claude/skills/my-custom-skill'), { recursive: true })
    await writeFile(join(projectDir, userSkillPath), 'user skill\n')
    await writeManifest({ modules: { harness: { version: 1 } }, fileHashes: hashes })

    await updateCommand({ nonInteractive: true })

    expect(await readFile(join(projectDir, userSkillPath), 'utf8')).toBe('user skill\n')
    const manifest = await readManifest()
    expect(manifest.fileHashes[userSkillPath]).toBeUndefined()
  })

  it('adopts pre-tracking deposits on confirmation — every change lands as a sidecar', async () => {
    await installTrackedHarness()
    const stalePath = '.claude/skills/sf-integration-rules/SKILL.md'
    await writeFile(join(projectDir, stalePath), 'pre-451 deposit content\n')
    // Pre-#451 install: no modules.harness, no fileHashes
    await writeManifest({})

    await updateCommand({})

    // Disk untouched, sidecar written, tracking adopted
    expect(await readFile(join(projectDir, stalePath), 'utf8')).toBe('pre-451 deposit content\n')
    expect(await readFile(join(projectDir, `${stalePath}.saasfoundry.new`), 'utf8')).toBeTruthy()
    const manifest = await readManifest()
    expect(manifest.modules.harness.version).toBe(1)
    expect(manifest.version).toBe(cliVersion)
  })

  it('skips adoption in non-interactive mode with a hint', async () => {
    await installTrackedHarness()
    await writeManifest({})

    await updateCommand({ nonInteractive: true })

    const manifest = await readManifest()
    expect(manifest.modules?.harness).toBeUndefined()
    expect(manifest.version).toBe(FRESH_VERSION)
  })

  it('no-ops when the harness is already at the current CLI version', async () => {
    const hashes = await installTrackedHarness()
    await writeManifest({ version: cliVersion, modules: { harness: { version: 1 } }, fileHashes: hashes })

    await updateCommand({ nonInteractive: true })

    const manifest = await readManifest()
    expect(manifest.version).toBe(cliVersion)
  })

  // Regression: the backfill first sat inside the refresh branch, so a project
  // already on the current CLI version — the overwhelmingly common case — never
  // reached it and was never offered the setting at all. It belongs with the
  // migration chains, which run on every invocation.
  it('materialises the language block even when the harness needs no refresh', async () => {
    const hashes = await installTrackedHarness()
    await writeManifest({ version: cliVersion, modules: { harness: { version: 1 } }, fileHashes: hashes })

    await updateCommand({ nonInteractive: true })

    expect((await readManifest()).language).toEqual({ srs: 'en', tickets: 'en', codeComments: 'en' })
  })

  it('fills only the missing surfaces, leaving an opt-out intact', async () => {
    const hashes = await installTrackedHarness()
    await writeManifest({ version: cliVersion, modules: { harness: { version: 1 } }, fileHashes: hashes, language: { tickets: 'fr' } })

    await updateCommand({ nonInteractive: true })

    expect((await readManifest()).language).toEqual({ srs: 'en', tickets: 'fr', codeComments: 'en' })
  })

  it('does not write the language block on a dry run', async () => {
    const hashes = await installTrackedHarness()
    await writeManifest({ version: cliVersion, modules: { harness: { version: 1 } }, fileHashes: hashes })

    const stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true)
    await updateCommand({ nonInteractive: true, dryRun: true })
    stdoutSpy.mockRestore()

    expect((await readManifest()).language).toBeUndefined()
  })

  it('dry-run reports the refresh without mutating anything', async () => {
    const hashes = await installTrackedHarness()
    const stalePath = '.claude/skills/sf-integration-rules/SKILL.md'
    await writeFile(join(projectDir, stalePath), 'old template content\n')
    hashes[stalePath] = hashFileContent('old template content\n')
    await writeManifest({ modules: { harness: { version: 1 } }, fileHashes: hashes })

    const stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true)
    await updateCommand({ nonInteractive: true, dryRun: true })
    stdoutSpy.mockRestore()

    expect(await readFile(join(projectDir, stalePath), 'utf8')).toBe('old template content\n')
    const manifest = await readManifest()
    expect(manifest.version).toBe(FRESH_VERSION)
  })
})

// Regression for the examine Critical finding: after a conflicted refresh,
// the baseline must be the deposit TARGET — never the disk content —
// otherwise the next refresh classifies the user edit as 'update' and
// silently overwrites it in place.
describe('updateCommand — baseline integrity across refresh cycles', () => {
  let projectDir: string
  let originalCwd: string
  let logSpy: jest.SpyInstance

  beforeEach(async () => {
    projectDir = join(tmpdir(), `sf-harness-cycle-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    originalCwd = process.cwd()
    await mkdir(projectDir, { recursive: true })
    process.chdir(projectDir)
    jest.clearAllMocks()
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(async () => {
    logSpy.mockRestore()
    process.chdir(originalCwd)
    await rm(projectDir, { recursive: true, force: true }).catch(() => {})
  })

  it('a user edit conflicted at cycle N is still intact after cycle N+1', async () => {
    await installHarness({ targetPath: projectDir, projectName: 'acme', version: FRESH_VERSION })
    const { computeHarnessFileHashes } = jest.requireActual<typeof import('../../../installers/harness.installer')>('../../../installers/harness.installer')
    const hashes = await computeHarnessFileHashes(projectDir)

    // Cycle N: baseline = old template, disk = user edit, target = current
    const editedPath = '.claude/skills/sf-integration-rules/SKILL.md'
    hashes[editedPath] = hashFileContent('old template content\n')
    await writeFile(join(projectDir, editedPath), 'my precious user edit\n')
    await writeFile(
      join(projectDir, '.saasfoundry.json'),
      JSON.stringify(
        {
          $schema: manifestSchemaUrl,
          manifestVersion: 2,
          version: FRESH_VERSION,
          generatedAt: 'x',
          structure: 'cli',
          projectName: 'acme',
          mainBranch: 'main',
          modules: { harness: { version: 1 } },
          fileHashes: hashes
        },
        null,
        2
      )
    )
    await updateCommand({ nonInteractive: true })
    expect(await readFile(join(projectDir, editedPath), 'utf8')).toBe('my precious user edit\n')

    // Cycle N+1: force another version mismatch and re-run
    const afterCycle1 = JSON.parse(await readFile(join(projectDir, '.saasfoundry.json'), 'utf8'))
    afterCycle1.version = FRESH_VERSION
    await writeFile(join(projectDir, '.saasfoundry.json'), JSON.stringify(afterCycle1, null, 2))
    await updateCommand({ nonInteractive: true })

    // The edit must survive — the poisoned-baseline bug overwrote it here
    expect(await readFile(join(projectDir, editedPath), 'utf8')).toBe('my precious user edit\n')
  })
})
