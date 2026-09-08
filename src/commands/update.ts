import chalk from 'chalk'
import { copy } from 'fs-extra'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import ora from 'ora'

import shelljs from 'shelljs'

import { installAnalyticsModule } from '../installers/analytics.installer'
import { installEmailModule } from '../installers/email.installer'
import { installOptionalSkills } from '../installers/optional-skills.installer'
import { installSkills } from '../installers/skills.installer'
import { computeHarnessFileHashes, harnessInstallerMeta, installHarness, isHarnessTrackedPath, mergeHarnessUserFiles } from '../installers/harness.installer'
import { installSrsSkill } from '../installers/srs-skill.installer'
import { installStorageModule } from '../installers/storage.installer'
import { DEFAULT_PORTS } from '../ports'
import { createApiApp } from '../builders/api.builder'
import { createDevServicesCompose } from '../builders/dev-services.builder'
import { createMonorepoRoot } from '../builders/monorepo.builder'
import { createWebApp } from '../builders/web.builder'
import { inquirerRenderer } from '../config-engine/renderers/inquirer.renderer'
import { runConfigSession } from '../config-engine/session'
import { skillsStep } from '../config-engine/steps/skills.step'
import { workflowStep } from '../config-engine/steps/workflow.step'
import { getAvailableModules, getEmailModuleCredentials, getModuleSelections, getStorageModuleConfig, getSkillCredentials } from '../prompts/update.prompts'
import { promptWithPrefill } from '../prompts/helpers'
import { ensureLanguageBlock } from '../language'
import { AdvancedSkillCredentials } from '../prompts/skills.prompts'
import { promptSrsConfiguration } from '../prompts/srs.prompts'
import { bootstrapSrs } from '../runners/srs.runner'
import { NotionSrsAdapter } from '../tools/notion/srs.adapter'
import { runManifestMigrations } from '../migrations/manifest/registry'
import { runModuleMigrations } from '../migrations/module/registry'
import { Answers, SaaSFoundryManifest, SrsToolConfig, isScaffoldManifest } from '../types'
import { upsertEnvKey } from '../utils/env-file'
import { ensureGitignorePatterns } from '../utils/gitignore'
import { checkNodeVersion, computeFileHashes, fileExists, getNvmPrefix, hashFileContent } from '../utils'
import { version as cliVersion } from '../../package.json'
import { buildUpdatePrefillFromOptions, ConflictStrategy, parseConflictStrategy, UpdateCommandOptions, UpdateDryRunReport } from './update.options'
import { runRequired } from '../run'
import { getSharedAgentEntrypoints } from '../harness/agent-registry'
import { CODEX_SOURCE_CLAUDE_BRIDGE } from '../harness/agent-instructions'

// Shared agent deposits have their own conflict-aware baselines. Generic
// scaffold refreshes must neither delete them nor adopt user edits/private skills.
const SHARED_AGENT_ENTRYPOINTS = new Set(getSharedAgentEntrypoints())
function isSharedAgentPath(path: string, protectClaude = false): boolean {
  const normalized = path.replaceAll('\\', '/')
  return (protectClaude && normalized === 'CLAUDE.md') || SHARED_AGENT_ENTRYPOINTS.has(normalized) || normalized.startsWith('.agents/')
}

function withoutSharedAgentHashes(hashes: Record<string, string>, protectClaude = false): Record<string, string> {
  return Object.fromEntries(Object.entries(hashes).filter(([path]) => !isSharedAgentPath(path, protectClaude)))
}

async function refreshProjectHashes(manifest: SaaSFoundryManifest): Promise<Record<string, string>> {
  const protectClaude = manifest.fileHashes?.['CLAUDE.md'] === hashFileContent(CODEX_SOURCE_CLAUDE_BRIDGE)
  const sharedBaselines = Object.fromEntries(Object.entries(manifest.fileHashes ?? {}).filter(([path]) => isSharedAgentPath(path, protectClaude)))
  return { ...withoutSharedAgentHashes(await computeFileHashes('.'), protectClaude), ...sharedBaselines }
}

export interface FileUpdate {
  path: string
  action: 'update' | 'add' | 'conflict' | 'remove'
}

/**
 * Re-generate the project in a temporary directory using the current CLI version
 * with the same options from the manifest. All side effects (npm install, git init) are skipped.
 *
 * Returns the temp dir path and the file hashes of the regenerated project.
 */
async function regenerateInTempDir(manifest: SaaSFoundryManifest): Promise<{ tempDir: string; hashes: Record<string, string> }> {
  // Template regeneration only applies to projects scaffolded by `sf new`.
  // The scaffold marker is `modules.email` — a harness-only manifest also
  // carries a `modules` block (just `harness`) but has no stack to regenerate.
  if (!isScaffoldManifest(manifest)) {
    throw new Error('regenerateInTempDir requires a scaffolded manifest (modules.email present)')
  }
  const tempDir = join(tmpdir(), `saasfoundry-update-${Date.now()}`)
  const projectDir = join(tempDir, manifest.projectName)
  await mkdir(`${projectDir}/apps`, { recursive: true })

  // Save original CWD and exec, then suppress side effects
  const originalCwd = process.cwd()
  const originalExec = shelljs.exec

  // Monkey-patch shelljs.exec to no-op (skip npm install, git init, prisma generate)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(shelljs as any).exec = () => ({ code: 0, stdout: '10.0.0', stderr: '' })

  try {
    process.chdir(projectDir)

    /**
     * The ports the user's project actually runs on, not the template's defaults.
     *
     * This regeneration is diffed against the real project to decide what `sf update`
     * offers. Rebuilding it on 3500/5173 while the project runs on 3501/5174 would make
     * every port-bearing file look changed — and the "template update" on offer would be
     * a revert of the user's own ports. Absent on manifests written before #584, where
     * the defaults are exactly what those projects run.
     */
    const ports = manifest.ports ?? DEFAULT_PORTS

    // Re-run API builder with dummy credentials
    await createApiApp({
      isMonorepo: manifest.structure === 'monorepo',
      projectName: manifest.projectName,
      projectDescription: '',
      backendRepoUrl: '',
      dbCredentials: { host: 'localhost', port: String(ports.db), user: 'user', password: 'pass', database: 'db', dbType: 'postgresql' },
      mainBranch: manifest.mainBranch ?? 'main', // pre-mainBranch manifests: backfill deferred (#424 step 6)
      emailService: manifest.modules.email.provider,
      mailersendApiKey: manifest.modules.email.provider === 'mailersend' ? 'dummy-key' : undefined,
      mailersendSenderEmail: manifest.modules.email.provider === 'mailersend' ? 'noreply@example.com' : undefined,
      mailersendSenderName: manifest.modules.email.provider === 'mailersend' ? 'App' : undefined,
      s3Setup: manifest.modules.s3Setup,
      s3Credentials: manifest.modules.s3Setup === 'credentials' ? { endpoint: '', accessKey: '', secretKey: '', bucket: '', region: '' } : undefined,
      advancedSkills: manifest.modules.advancedSkills || [],
      workflow: manifest.workflow,
      aiRules: manifest.aiRules,
      ports
    })

    // Re-run dev services builder if needed
    const hasDevServices = manifest.modules.dbSetup === 'docker' || manifest.modules.s3Setup === 'docker'
    if (hasDevServices) {
      const apiPath = manifest.structure === 'monorepo' ? 'apps/api' : `apps/${manifest.projectName}-api`
      await createDevServicesCompose({
        apiPath,
        projectName: manifest.projectName,
        dbSetup: manifest.modules.dbSetup,
        // The builder's own template defaults, so the regenerated compose matches what a
        // fresh scaffold writes — only the port carries real information here.
        dbCredentials: { host: 'localhost', port: String(ports.db), user: 'db_dev_user', password: 'db_dev_password', database: 'db_dev', dbType: 'postgresql' },
        s3Setup: manifest.modules.s3Setup
      })
    }

    // Re-run web builder
    await createWebApp({
      isMonorepo: manifest.structure === 'monorepo',
      projectName: manifest.projectName,
      projectDescription: '',
      frontendRepoUrl: '',
      mainBranch: manifest.mainBranch ?? 'main',
      s3Setup: manifest.modules.s3Setup,
      includeAnalytics: manifest.modules.includeAnalytics,
      includePwa: manifest.modules.pwa !== undefined,
      advancedSkills: manifest.modules.advancedSkills || [],
      workflow: manifest.workflow,
      aiRules: manifest.aiRules,
      ports
    })

    // Re-run monorepo root builder if applicable
    if (manifest.structure === 'monorepo') {
      await createMonorepoRoot({
        projectName: manifest.projectName,
        projectDescription: '',
        mainBranch: manifest.mainBranch ?? 'main',
        workflow: manifest.workflow,
        aiRules: manifest.aiRules,
        ports
      })
    }

    // Re-run skills installer
    const apiPath = manifest.structure === 'monorepo' ? 'apps/api' : `apps/${manifest.projectName}-api`
    const webPath = manifest.structure === 'monorepo' ? 'apps/web' : `apps/${manifest.projectName}-web`
    await installSkills({
      isMonorepo: manifest.structure === 'monorepo',
      apiPath,
      webPath,
      projectName: manifest.projectName,
      version: cliVersion,
      mainBranch: manifest.mainBranch,
      advancedSkills: manifest.modules.advancedSkills || []
    })

    // Compute hashes of the regenerated project
    const hashes = await computeFileHashes('.')

    return { tempDir, hashes }
  } finally {
    process.chdir(originalCwd)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(shelljs as any).exec = originalExec
  }
}

/**
 * Compare three versions of file hashes to determine what needs updating.
 *
 * Three-way comparison:
 * - base: hash from manifest (what was originally generated)
 * - current: hash of user's current file
 * - target: hash from regenerated project (what new CLI version produces)
 */
export function computeFileUpdates(baseHashes: Record<string, string>, currentHashes: Record<string, string>, targetHashes: Record<string, string>): FileUpdate[] {
  const updates: FileUpdate[] = []
  const allPaths = new Set([...Object.keys(baseHashes), ...Object.keys(targetHashes)])

  for (const filePath of allPaths) {
    const base = baseHashes[filePath]
    const current = currentHashes[filePath]
    const target = targetHashes[filePath]

    // New file in updated CLI (not in original generation)
    if (!base && target) {
      if (!current) {
        updates.push({ path: filePath, action: 'add' })
      }
      // If current exists (user created a file with the same name), skip
      continue
    }

    // File removed in updated CLI
    if (base && !target) {
      if (current && current === base) {
        // User didn't modify it, safe to flag for removal
        updates.push({ path: filePath, action: 'remove' })
      }
      continue
    }

    // File exists in both versions
    if (base && target) {
      if (base === target) continue // Template didn't change, nothing to do

      // Template changed
      if (!current || current === base) {
        // User didn't modify the file (or file was deleted) → safe to auto-update
        updates.push({ path: filePath, action: 'update' })
      } else if (current === target) {
        // User already has the new version (unlikely but possible)
        continue
      } else {
        // Both user AND template changed → conflict
        updates.push({ path: filePath, action: 'conflict' })
      }
    }
  }

  return updates
}

/**
 * Apply file updates from the regenerated project to the user's project.
 *
 * The `strategy` controls how three-way conflicts are resolved:
 * - `save-new` (default): writes the template version to `<path>.saasfoundry.new`
 *   so the user can merge manually. This preserves the pre-#59 behavior.
 * - `keep`: leaves the user's file untouched and writes no sidecar.
 * - `replace`: overwrites the user's file with the template version (destructive).
 */
export async function applyFileUpdates(
  updates: FileUpdate[],
  tempProjectDir: string,
  spinner: ReturnType<typeof ora>,
  strategy: ConflictStrategy
): Promise<{ applied: FileUpdate[]; conflicts: FileUpdate[]; added: FileUpdate[]; removed: FileUpdate[] }> {
  const applied: FileUpdate[] = []
  const conflicts: FileUpdate[] = []
  const added: FileUpdate[] = []
  const removed: FileUpdate[] = []

  for (const update of updates) {
    const sourcePath = join(tempProjectDir, update.path)
    const destPath = update.path

    switch (update.action) {
      case 'update': {
        spinner.text = `Updating ${update.path}...`
        const content = await readFile(sourcePath, 'utf8')
        // The user may have deleted the containing directory — recreate it
        // rather than crashing the whole update midway.
        await mkdir(dirname(destPath), { recursive: true })
        await writeFile(destPath, content)
        applied.push(update)
        break
      }
      case 'add': {
        spinner.text = `Adding ${update.path}...`
        await copy(sourcePath, destPath)
        added.push(update)
        break
      }
      case 'conflict': {
        if (strategy === 'keep') {
          conflicts.push(update)
        } else if (strategy === 'replace') {
          spinner.text = `Overwriting ${update.path}...`
          const newContent = await readFile(sourcePath, 'utf8')
          await writeFile(destPath, newContent)
          conflicts.push(update)
        } else {
          // save-new: write the template version alongside the original.
          const newContent = await readFile(sourcePath, 'utf8')
          await writeFile(`${destPath}.saasfoundry.new`, newContent)
          conflicts.push(update)
        }
        break
      }
      case 'remove': {
        // Don't auto-delete, just warn
        removed.push(update)
        break
      }
    }
  }

  return { applied, conflicts, added, removed }
}

/**
 * Deposit the current CLI's harness artefacts into a temp dir — the `target`
 * side of the FLOW 1b three-way merge. CLAUDE.md / settings.json land in the
 * temp dir too but are outside the tracked scope (merge-managed, never swept).
 */
async function depositHarnessInTempDir(
  manifest: SaaSFoundryManifest,
  overrides?: { workflow?: SaaSFoundryManifest['workflow']; advancedSkills?: string[] }
): Promise<{ tempDir: string; hashes: Record<string, string> }> {
  // mkdtemp: unpredictable name, fails on collision — never reuse a
  // pre-existing (possibly attacker-created) directory on shared /tmp.
  const tempDir = await mkdtemp(join(tmpdir(), 'saasfoundry-harness-refresh-'))

  try {
    await installHarness({
      targetPath: tempDir,
      projectName: manifest.projectName,
      version: cliVersion,
      mainBranch: manifest.mainBranch,
      workflow: overrides?.workflow ?? manifest.workflow,
      advancedSkills: overrides?.advancedSkills ?? manifest.modules?.advancedSkills ?? []
    })
    if (manifest.tools?.srs?.enabled) {
      await installSrsSkill({ targetPath: tempDir })
    }
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {})
    throw error
  }

  return { tempDir, hashes: await computeHarnessFileHashes(tempDir) }
}

interface RefreshHarnessOptions {
  dryRun: boolean
  nonInteractive: boolean
  conflictStrategy: ConflictStrategy
  dryRunReport: UpdateDryRunReport | null
}

/**
 * FLOW 1b — refresh the harness deposits of a non-scaffold project.
 *
 * Same three-way merge as the FLOW 1 template update (base = tracked hashes,
 * current = disk, target = fresh deposit), scoped to the harness paths:
 * unchanged files update in place, user-edited files follow the conflict
 * strategy (sidecar by default), `remove` actions are never auto-applied
 * (deposit removals ship as explicit module migrations).
 *
 * Adoption path: a project whose deposits predate version tracking (no
 * `modules.harness` stamp) is adopted on explicit confirmation — its current
 * files become the baseline and every change lands as a conflict (sidecar),
 * because nothing can distinguish old templates from user edits.
 */
async function refreshHarnessDeposits(manifest: SaaSFoundryManifest, manifestPath: string, { dryRun, nonInteractive, conflictStrategy, dryRunReport }: RefreshHarnessOptions): Promise<void> {
  const currentHashes = await computeHarnessFileHashes('.')
  const hasDeposits = Object.keys(currentHashes).length > 0
  const tracked = (manifest.modules?.harness?.version ?? 0) > 0

  if (!hasDeposits && !tracked) return

  const adoption = !tracked && hasDeposits
  if (!adoption && manifest.version === cliVersion) {
    console.log(chalk.green('  Your AI harness is up to date with the current CLI version.\n'))
    return
  }

  if (adoption) {
    console.log(chalk.yellow('  Harness deposits found without version tracking (installed by an older CLI).'))
    if (nonInteractive) {
      console.log(chalk.yellow('  Run `sf update` without --non-interactive once to confirm their adoption. Skipping.\n'))
      if (dryRunReport) dryRunReport.harnessRefresh = { status: 'adoption-needed' }
      return
    }
    if (!dryRun) {
      const { adoptHarness } = await promptWithPrefill<{ adoptHarness: boolean }>(
        [{ type: 'confirm', name: 'adoptHarness', message: 'Adopt these deposits (changed files will land as .saasfoundry.new sidecars, nothing overwritten)?', default: true }],
        { nonInteractive }
      )
      if (!adoptHarness) {
        console.log(chalk.gray('  Harness adoption skipped.\n'))
        return
      }
    }
  }

  console.log(chalk.yellow(`  Harness refresh: v${manifest.version} → v${cliVersion}`))
  const spinner = ora('Comparing harness deposits with the current CLI...').start()
  let tempDir: string | null = null

  try {
    const baseHashes = adoption ? currentHashes : Object.fromEntries(Object.entries(manifest.fileHashes ?? {}).filter(([p]) => isHarnessTrackedPath(p)))

    const deposit = await depositHarnessInTempDir(manifest)
    tempDir = deposit.tempDir

    let updates = computeFileUpdates(baseHashes, currentHashes, deposit.hashes).filter((u) => u.action !== 'remove')
    if (adoption) {
      // Nothing distinguishes old templates from user edits — be conservative.
      updates = updates.map((u) => (u.action === 'update' ? { ...u, action: 'conflict' as const } : u))
    }
    // The adoption prompt promises "nothing overwritten" — honour it whatever
    // the global strategy says.
    const effectiveStrategy: ConflictStrategy = adoption ? 'save-new' : conflictStrategy

    if (updates.length === 0) {
      spinner.succeed(chalk.green('Harness deposits already match the current CLI.'))
    } else if (dryRun) {
      spinner.succeed('Harness refresh analysis complete (dry run).')
      if (dryRunReport) {
        dryRunReport.harnessRefresh = {
          status: 'would-apply',
          update: updates.filter((u) => u.action === 'update').map((u) => u.path),
          add: updates.filter((u) => u.action === 'add').map((u) => u.path),
          conflict: updates.filter((u) => u.action === 'conflict').map((u) => u.path)
        }
      }
    } else {
      spinner.start('Refreshing harness deposits...')
      const { applied, conflicts, added } = await applyFileUpdates(updates, tempDir, spinner, effectiveStrategy)
      spinner.succeed(chalk.green('Harness refresh complete.'))

      if (applied.length > 0) console.log(chalk.green(`  ${applied.length} file(s) updated in place`))
      if (added.length > 0) console.log(chalk.green(`  ${added.length} new file(s) added`))
      if (conflicts.length > 0) {
        console.log(chalk.red(`  ${conflicts.length} file(s) you edited — handled with strategy '${effectiveStrategy}':`))
        for (const f of conflicts) {
          console.log(chalk.red(`    ! ${f.path}${effectiveStrategy === 'save-new' ? ` → review ${f.path}.saasfoundry.new` : ''}`))
        }
      }
    }

    if (!dryRun) {
      // Baseline = the deposit TARGET hashes, never a disk re-sweep: a
      // conflicted (sidecar'd) user edit must stay different from the
      // baseline so the next refresh re-conflicts instead of silently
      // overwriting it in place. This also keeps user-authored files out of
      // the tracking entirely.
      const untracked = Object.fromEntries(Object.entries(manifest.fileHashes ?? {}).filter(([p]) => !isHarnessTrackedPath(p)))
      manifest.fileHashes = { ...untracked, ...deposit.hashes }
      manifest.modules = { ...(manifest.modules ?? {}), harness: { ...manifest.modules?.harness, version: harnessInstallerMeta.currentVersion } }
      manifest.version = cliVersion
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2))
    }
  } catch (error) {
    spinner.fail(chalk.red('Failed to refresh the harness deposits'))
    console.error(error)
    // Surface the failure to scripts/CI without aborting FLOW 2; the version
    // was not bumped, so the next run retries the refresh.
    process.exitCode = 1
  } finally {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {})
    }
  }

  console.log()
}

/**
 * Update command — Update templates and add modules to an existing SaaSFoundryAI project.
 *
 * This command handles two flows:
 * 1. Template updates: When CLI version differs from project version, regenerate templates
 *    and apply changes to files the user hasn't modified (three-way merge).
 * 2. Module addition: Detect available but uninstalled modules and let users add them.
 */
/**
 * Decides what `selectedModules` the module prompt starts from.
 *
 * A scripted run that names no module is asking for nothing, not asking wrongly.
 * Without a materialised default, `--non-interactive` with no `--add` threw
 * "Missing required values" and took the whole command down — so `sf update`
 * could not be used unattended to pick up migrations or refresh the harness,
 * which is the main reason to run it that way.
 *
 * `srsEnable` and `includePwa` already materialise a default for the same reason:
 * a prompt the caller never had to answer must not block a scripted run.
 * Interactively the field stays absent, so the checkbox is shown as before.
 */
export function moduleSelectionPrefill(requested: string[] | undefined, nonInteractive: boolean): { selectedModules?: string[] } {
  if (requested !== undefined) return { selectedModules: requested }
  return nonInteractive ? { selectedModules: [] } : {}
}

export async function updateCommand(opts: UpdateCommandOptions = {}) {
  checkNodeVersion()

  // Parse + validate CLI flags up-front so bad values fail before any work.
  const conflictStrategy: ConflictStrategy = parseConflictStrategy(opts.conflictStrategy)
  const prefill = buildUpdatePrefillFromOptions(opts)
  const nonInteractive = opts.nonInteractive === true
  const dryRun = opts.dryRun === true
  const acceptTemplateUpdates = opts.acceptTemplateUpdates === true

  // Read manifest
  const manifestPath = '.saasfoundry.json'
  if (!(await fileExists(manifestPath))) {
    console.error(chalk.red('No .saasfoundry.json found in the current directory.'))
    console.error(chalk.red('This command must be run from the root of a SaaSFoundryAI project.'))
    console.error(chalk.yellow('If this project was generated before manifest support, you can create one manually.'))
    process.exit(1)
  }

  let manifest: SaaSFoundryManifest = JSON.parse(await readFile(manifestPath, 'utf8'))

  // Run the manifest migration chain. Idempotent at the chain level — a
  // manifest already at the target version returns unchanged with an empty
  // appliedMigrations list. Persisted immediately so any subsequent early-
  // return path (skill install, dry-run aside) sees the upgraded shape.
  const migrationResult = runManifestMigrations(manifest)
  if (migrationResult.appliedMigrations.length > 0) {
    manifest = migrationResult.manifest
    console.log(chalk.gray(`  Manifest migrated: v${migrationResult.fromVersion} → v${migrationResult.toVersion}`))
    for (const m of migrationResult.appliedMigrations) {
      console.log(chalk.gray(`    • ${String(m.from).padStart(3, '0')} → ${String(m.to).padStart(3, '0')}  ${m.name}`))
    }
    if (!dryRun) {
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2))
    }
  }

  // Per-module migration chain — runs after the manifest chain so each
  // migration sees the upgraded shape, and before any template regeneration so
  // the regenerated project uses the post-migration module versions. Mutations
  // to user files go through `writeMigratedFile`, which falls back to a
  // `.saasfoundry.new` sidecar when the user has hand-edited the target.
  const moduleMigrationResult = await runModuleMigrations(manifest, '.')
  if (moduleMigrationResult.applied.length > 0) {
    manifest = moduleMigrationResult.manifest
    for (const a of moduleMigrationResult.applied) {
      const chain = a.migrations.map((name, i) => `${String(a.fromVersion + i).padStart(3, '0')}→${String(a.fromVersion + i + 1).padStart(3, '0')} ${name}`).join(', ')
      console.log(chalk.gray(`  Migrated module '${a.module}' v${a.fromVersion} → v${a.toVersion} via [${chain}]`))
    }
    if (!dryRun) {
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2))
    }
  }

  // Materialise the language block on projects that predate it, so the knob is
  // visible rather than merely defaulted. It belongs here with the migration
  // chains rather than inside either refresh flow: a project already on the
  // current CLI version skips the harness/template refresh entirely, and would
  // otherwise never be offered the setting at all.
  if (ensureLanguageBlock(manifest) && !dryRun) {
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2))
  }

  // Initialise the dry-run report. We populate it as we walk the two flows and
  // emit it on stdout at the end of the command when `--dry-run` is set.
  const dryRunReport: UpdateDryRunReport | null = dryRun
    ? {
        cliVersion,
        projectVersion: manifest.version,
        conflictStrategy,
        templateUpdate: { status: 'up-to-date' },
        moduleAddition: { available: [], selected: [], skills: [], wouldRunNpmInstall: false }
      }
    : null

  // Display project info
  console.log(chalk.blue('\n  SaaSFoundryAI Project Update'))
  console.log(chalk.blue('  ' + '─'.repeat(40)))
  console.log(chalk.white(`  Project:         ${manifest.projectName}`))
  console.log(chalk.white(`  Structure:       ${manifest.structure}`))
  console.log(chalk.white(`  Project version: ${manifest.version}`))
  console.log(chalk.white(`  CLI version:     ${cliVersion}`))
  if (dryRun) console.log(chalk.gray('  (dry-run — no files will be written)'))
  console.log()

  // ─── FLOW 1: Template updates (version differs) ───
  // Only meaningful for projects scaffolded by `sf new` — the marker is
  // `modules.email` (isScaffoldManifest), NOT the modules block itself:
  // harness-only manifests carry `modules.harness` (and may carry fileHashes
  // for their deposits) but have no generated app to regenerate.
  if (manifest.version !== cliVersion && isScaffoldManifest(manifest)) {
    if (!manifest.fileHashes) {
      console.log(chalk.yellow(`  Your project was generated with SaaSFoundryAI v${manifest.version} (before hash tracking).`))
      console.log(chalk.yellow('  Template updates require file hashes. Skipping template update.\n'))
      console.log(chalk.yellow('  To enable template updates, regenerate your project or manually add fileHashes to .saasfoundry.json.\n'))
      if (dryRunReport) dryRunReport.templateUpdate = { status: 'skipped-no-hashes' }
    } else {
      console.log(chalk.yellow(`  Version change detected: v${manifest.version} → v${cliVersion}`))
      console.log(chalk.blue('  Analyzing template changes...\n'))

      const spinner = ora('Regenerating project templates...').start()
      let tempDir: string | undefined

      try {
        // Regenerate project in temp dir with current CLI
        const result = await regenerateInTempDir(manifest)
        tempDir = result.tempDir
        const targetHashes = result.hashes
        const tempProjectDir = join(tempDir, manifest.projectName)

        // Compute current file hashes
        spinner.text = 'Computing current file hashes...'
        const currentHashes = await computeFileHashes('.')

        // Three-way comparison
        spinner.text = 'Comparing files...'
        const protectClaude = manifest.fileHashes?.['CLAUDE.md'] === hashFileContent(CODEX_SOURCE_CLAUDE_BRIDGE)
        const updates = computeFileUpdates(
          withoutSharedAgentHashes(manifest.fileHashes, protectClaude),
          withoutSharedAgentHashes(currentHashes, protectClaude),
          withoutSharedAgentHashes(targetHashes, protectClaude)
        )

        if (updates.length === 0) {
          spinner.succeed(chalk.green('No template changes to apply.'))
          if (dryRunReport) dryRunReport.templateUpdate = { status: 'no-changes' }
        } else {
          // Preview counts so the user can make an informed decision.
          const updateCount = updates.filter((u) => u.action === 'update').length
          const addCount = updates.filter((u) => u.action === 'add').length
          const conflictCount = updates.filter((u) => u.action === 'conflict').length
          const removeCount = updates.filter((u) => u.action === 'remove').length

          spinner.stop()
          console.log(chalk.blue(`  ${updates.length} template change(s) detected:`))
          if (updateCount) console.log(chalk.green(`    ${updateCount} file(s) to auto-update`))
          if (addCount) console.log(chalk.green(`    ${addCount} new file(s) to add`))
          if (conflictCount) console.log(chalk.yellow(`    ${conflictCount} conflict(s) — strategy: ${conflictStrategy}`))
          if (removeCount) console.log(chalk.yellow(`    ${removeCount} file(s) removed in new CLI`))
          console.log()

          if (dryRunReport) {
            dryRunReport.templateUpdate = {
              status: 'would-apply',
              update: updates.filter((u) => u.action === 'update').map((u) => u.path),
              add: updates.filter((u) => u.action === 'add').map((u) => u.path),
              conflict: updates.filter((u) => u.action === 'conflict').map((u) => u.path),
              remove: updates.filter((u) => u.action === 'remove').map((u) => u.path)
            }
          }

          // Confirmation gate — bypassed by --accept-template-updates, --non-interactive, or --dry-run.
          const autoAccept = acceptTemplateUpdates || nonInteractive || dryRun
          let proceed = autoAccept
          if (!autoAccept) {
            const { confirm } = await promptWithPrefill<{ confirm: boolean }>([{ type: 'confirm', name: 'confirm', message: 'Apply these template updates now?', default: true }])
            proceed = confirm
          }

          if (!proceed) {
            console.log(chalk.yellow('  Template update skipped. You can re-run `sf update` when ready.\n'))
          } else if (dryRun) {
            // In dry-run we report but never mutate.
          } else {
            spinner.start('Applying updates...')
            const { applied, conflicts, added, removed } = await applyFileUpdates(updates, tempProjectDir, spinner, conflictStrategy)

            spinner.succeed(chalk.green('Template update complete.'))

            // Summary
            if (applied.length > 0) {
              console.log(chalk.green(`\n  ${applied.length} file(s) auto-updated:`))
              for (const f of applied) console.log(chalk.green(`    ✓ ${f.path}`))
            }

            if (added.length > 0) {
              console.log(chalk.green(`\n  ${added.length} new file(s) added:`))
              for (const f of added) console.log(chalk.green(`    + ${f.path}`))
            }

            if (removed.length > 0) {
              console.log(chalk.yellow(`\n  ${removed.length} file(s) removed in new version (not auto-deleted):`))
              for (const f of removed) console.log(chalk.yellow(`    - ${f.path}`))
            }

            if (conflicts.length > 0) {
              const header = `  ${conflicts.length} conflict(s) — both you and SaaSFoundryAI modified these files:`
              console.log(chalk.red(`\n${header}`))
              for (const f of conflicts) {
                console.log(chalk.red(`    ! ${f.path}`))
                if (conflictStrategy === 'save-new') {
                  console.log(chalk.yellow(`      → Review ${f.path}.saasfoundry.new and merge manually`))
                } else if (conflictStrategy === 'replace') {
                  console.log(chalk.yellow(`      → Overwritten with template version (strategy: replace)`))
                } else {
                  console.log(chalk.yellow(`      → Kept your version (strategy: keep)`))
                }
              }
            }
          }
        }

        if (!dryRun) {
          // Update manifest version and recompute hashes
          manifest.version = cliVersion
          manifest.fileHashes = await refreshProjectHashes(manifest)
          await writeFile(manifestPath, JSON.stringify(manifest, null, 2))
        }
      } catch (error) {
        spinner.fail(chalk.red('Failed to update templates'))
        console.error(error)
      } finally {
        // Clean up temp dir
        if (tempDir) {
          await rm(tempDir, { recursive: true, force: true }).catch(() => {})
        }
      }

      console.log()
    }
  } else if (!isScaffoldManifest(manifest)) {
    // ─── FLOW 1b: Harness-only refresh ───
    // Non-scaffold projects (harness profile, pre-#451 manual installs) have
    // no templates to regenerate, but their harness deposits (.claude/skills/
    // sf-*, .claude/docs) follow the CLI version through the same three-way
    // merge as FLOW 1, scoped to the deposit paths.
    await refreshHarnessDeposits(manifest, manifestPath, { dryRun, nonInteractive, conflictStrategy, dryRunReport })
  } else {
    console.log(chalk.green('  Your project is up to date with the current CLI version.\n'))
  }

  // ─── FLOW 2: Module addition ───
  const availableModules = getAvailableModules(manifest)
  if (dryRunReport) dryRunReport.moduleAddition.available = availableModules.map((m) => m.value)

  // Guard against --add-modules re-requesting an already-installed module.
  // Without this, the prefill ('srs', for instance) bypasses the
  // availability filter and triggers a duplicate bootstrap downstream.
  const availableValues = new Set(availableModules.map((m) => m.value))
  let effectivePrefill = prefill.selectedModules
  if (effectivePrefill !== undefined) {
    const alreadyInstalled = effectivePrefill.filter((m) => !availableValues.has(m))
    const installable = effectivePrefill.filter((m) => availableValues.has(m))
    for (const mod of alreadyInstalled) {
      console.log(chalk.yellow(`  ⊘ '${mod}' is already installed (see .saasfoundry.json) — skipping`))
    }
    effectivePrefill = installable
    if (alreadyInstalled.length > 0 && installable.length === 0) {
      console.log(chalk.green('  All requested modules are already installed. Nothing to do.'))
      if (dryRunReport) emitDryRunReport(dryRunReport)
      return
    }
  }

  if (availableModules.length === 0) {
    if (manifest.version === cliVersion) {
      console.log(chalk.green('  All available modules are already installed. Nothing to update.'))
    }
    if (dryRunReport) emitDryRunReport(dryRunReport)
    return
  }

  console.log(chalk.blue(`  ${availableModules.length} module(s) available to add:\n`))

  const selectedModules = await getModuleSelections(availableModules, {
    prefill: moduleSelectionPrefill(effectivePrefill, nonInteractive),
    nonInteractive
  })

  if (selectedModules.length === 0) {
    console.log(chalk.yellow('\nNo modules selected. Nothing to do.'))
    if (dryRunReport) emitDryRunReport(dryRunReport)
    return
  }

  // Resolve app paths
  const isMonorepo = manifest.structure === 'monorepo'
  const apiPath = isMonorepo ? 'apps/api' : `apps/${manifest.projectName}-api`
  const webPath = isMonorepo ? 'apps/web' : `apps/${manifest.projectName}-web`

  // Collect credentials for selected modules
  let emailCredentials: { mailersendApiKey: string; mailersendSenderEmail: string; mailersendSenderName: string } | null = null
  let storageConfig: { s3Setup: 'docker' | 'credentials'; s3Credentials?: { endpoint: string; accessKey: string; secretKey: string; bucket: string; region: string } } | null = null
  let srsBootstrap: { backend: 'notion'; notionApiToken: string; notionApiVersion?: string; parentInput: string } | null = null
  const skillsToAdd: string[] = []
  const skillsCredentials: AdvancedSkillCredentials = {}

  if (selectedModules.includes('email')) {
    emailCredentials = await getEmailModuleCredentials(manifest.projectName, { prefill: prefill.email, nonInteractive })
    if (!emailCredentials) {
      selectedModules.splice(selectedModules.indexOf('email'), 1)
    }
  }

  if (selectedModules.includes('storage')) {
    storageConfig = await getStorageModuleConfig(manifest.projectName, { prefill: prefill.storage, nonInteractive })
  }

  // Collect credentials for selected skills
  for (const module of selectedModules) {
    if (module.startsWith('sf-skill-')) {
      const skillName = module.replace('sf-skill-', '')
      skillsToAdd.push(skillName)
      const credentials = await getSkillCredentials(skillName, { prefill: prefill.skills as unknown as Record<string, unknown>, nonInteractive })
      Object.assign(skillsCredentials, credentials)
    }
  }

  // Harness addition: collect the workflow + skills decisions through the
  // config-engine session (same steps as `sf new`), before any spinner runs.
  let harnessConfig: Answers | null = null
  if (selectedModules.includes('harness') && !dryRun) {
    // Not in dry-run: the workflow step may create a GitHub Project during
    // collection (legacy side effect, cleanup owned by FR-CONFIG-ENGINE-04).
    const { config } = await runConfigSession({
      renderer: inquirerRenderer,
      steps: [workflowStep, skillsStep],
      prefill: { projectName: manifest.projectName, mainBranch: manifest.mainBranch as Answers['mainBranch'] },
      nonInteractive
    })
    harnessConfig = config
    if (nonInteractive && !harnessConfig.workflow) {
      console.log(chalk.yellow('  Harness: workflow configuration needs an interactive run (skills/docs/hooks will still be installed).'))
    }
  }

  if (selectedModules.includes('srs')) {
    const srsPrefill = (prefill.srs as { srsBackend?: 'notion'; srsParentPageInput?: string; notionApiToken?: string; notionApiVersion?: string } | undefined) ?? {}
    const srsAnswers = await promptSrsConfiguration(
      { notionApiToken: srsPrefill.notionApiToken, notionApiVersion: srsPrefill.notionApiVersion },
      {
        prefill: { srsEnable: true, ...srsPrefill },
        nonInteractive
      }
    )
    if (!srsAnswers.srsEnable) {
      selectedModules.splice(selectedModules.indexOf('srs'), 1)
    } else if (srsAnswers.srsBackend === 'notion' && srsAnswers.notionApiToken && srsAnswers.srsParentPageInput) {
      srsBootstrap = {
        backend: 'notion',
        notionApiToken: srsAnswers.notionApiToken,
        notionApiVersion: srsAnswers.notionApiVersion ?? srsPrefill.notionApiVersion,
        parentInput: srsAnswers.srsParentPageInput
      }
    } else {
      const missing: string[] = []
      if (srsAnswers.srsBackend !== 'notion') missing.push('srsBackend (--srs-backend notion)')
      if (!srsAnswers.notionApiToken) missing.push('notionApiToken (--notion-api-token)')
      if (!srsAnswers.srsParentPageInput) missing.push('srsParentPageInput (--srs-parent-page-input)')
      throw new Error(`Cannot add "srs": required values missing — ${missing.join(', ')}.`)
    }
  }

  if (selectedModules.length === 0) {
    console.log(chalk.yellow('\nNo modules to install. Nothing to do.'))
    if (dryRunReport) emitDryRunReport(dryRunReport)
    return
  }

  if (dryRunReport) {
    dryRunReport.moduleAddition.selected = [...selectedModules]
    if (selectedModules.includes('email')) {
      dryRunReport.moduleAddition.email = { configured: emailCredentials !== null }
    }
    if (selectedModules.includes('storage') && storageConfig) {
      dryRunReport.moduleAddition.storage = {
        s3Setup: storageConfig.s3Setup,
        credentialsProvided: storageConfig.s3Credentials !== undefined
      }
    }
    if (selectedModules.includes('harness')) {
      dryRunReport.moduleAddition.harness = { workflowConfigured: harnessConfig?.workflow !== undefined, skills: harnessConfig?.advancedSkills ?? [] }
    }
    dryRunReport.moduleAddition.skills = [...skillsToAdd]
    dryRunReport.moduleAddition.wouldRunNpmInstall = selectedModules.includes('storage') || selectedModules.includes('email')
    emitDryRunReport(dryRunReport)
    return
  }

  // Install modules
  const moduleSpinner = ora('Installing modules...').start()

  try {
    // email/storage/analytics/skills modules require a scaffolded app
    // (modules.email marker). `isModuleAvailable` already filters them out
    // for non-scaffold manifests; this narrows the type. `srs` and `harness`
    // are structure-agnostic.
    if (selectedModules.some((m) => m !== 'srs' && m !== 'harness' && !m.startsWith('sf-skill-')) && !isScaffoldManifest(manifest)) {
      throw new Error('Stack modules require a scaffolded SaaS project (generated by sf new)')
    }

    let harnessTargetHashes: Record<string, string> | null = null
    if (selectedModules.includes('harness') && harnessConfig) {
      moduleSpinner.text = 'Installing the AI harness...'
      const preExisting = await computeHarnessFileHashes('.')

      if (Object.keys(preExisting).length === 0) {
        // No prior deposits — plain install.
        await installHarness({
          targetPath: '.',
          projectName: manifest.projectName,
          version: cliVersion,
          mainBranch: manifest.mainBranch,
          workflow: harnessConfig.workflow,
          advancedSkills: harnessConfig.advancedSkills
        })
        harnessTargetHashes = await computeHarnessFileHashes('.')
        manifest.fileHashes = { ...(manifest.fileHashes ?? {}), ...harnessTargetHashes }
      } else {
        // Deposits already exist (stack scaffolds ship core skills; earlier
        // manual installs): a blind copy would clobber user edits. Run the
        // same three-way machinery as FLOW 1b — tracked baseline when
        // available, conservative current-disk baseline otherwise.
        const deposit = await depositHarnessInTempDir(manifest, { workflow: harnessConfig.workflow, advancedSkills: harnessConfig.advancedSkills })
        try {
          const tracked = Object.fromEntries(Object.entries(manifest.fileHashes ?? {}).filter(([p]) => isHarnessTrackedPath(p)))
          const conservative = Object.keys(tracked).length === 0
          let updates = computeFileUpdates(conservative ? preExisting : tracked, preExisting, deposit.hashes).filter((u) => u.action !== 'remove')
          if (conservative) {
            updates = updates.map((u) => (u.action === 'update' ? { ...u, action: 'conflict' as const } : u))
          }
          await applyFileUpdates(updates, deposit.tempDir, moduleSpinner, conservative ? 'save-new' : conflictStrategy)
          await mergeHarnessUserFiles({
            targetPath: '.',
            projectName: manifest.projectName,
            version: cliVersion,
            mainBranch: manifest.mainBranch,
            workflow: harnessConfig.workflow
          })
          const untracked = Object.fromEntries(Object.entries(manifest.fileHashes ?? {}).filter(([p]) => !isHarnessTrackedPath(p)))
          harnessTargetHashes = deposit.hashes
          manifest.fileHashes = { ...untracked, ...deposit.hashes }
        } finally {
          await rm(deposit.tempDir, { recursive: true, force: true }).catch(() => {})
        }
      }

      manifest.workflow = harnessConfig.workflow ?? manifest.workflow
      manifest.aiRules = harnessConfig.aiRules ?? manifest.aiRules
      manifest.modules = {
        ...(manifest.modules ?? {}),
        harness: { ...manifest.modules?.harness, version: harnessInstallerMeta.currentVersion },
        advancedSkills: [...new Set([...(manifest.modules?.advancedSkills ?? []), ...(harnessConfig.advancedSkills ?? [])])]
      }
    }

    if (selectedModules.includes('email') && emailCredentials) {
      moduleSpinner.text = 'Installing MailerSend email module...'
      await installEmailModule({
        apiPath,
        isMonorepo,
        projectName: manifest.projectName,
        mailersendApiKey: emailCredentials.mailersendApiKey,
        mailersendSenderEmail: emailCredentials.mailersendSenderEmail,
        mailersendSenderName: emailCredentials.mailersendSenderName
      })
      manifest.modules!.email = { provider: 'mailersend', version: 1 }
    }

    if (selectedModules.includes('storage') && storageConfig) {
      moduleSpinner.text = 'Installing S3 storage module...'
      await installStorageModule({
        apiPath,
        webPath,
        isMonorepo,
        projectName: manifest.projectName,
        s3Setup: storageConfig.s3Setup,
        s3Credentials: storageConfig.s3Credentials,
        skipNpmInstall: true
      })

      if (storageConfig.s3Setup === 'docker') {
        await createDevServicesCompose({
          apiPath,
          projectName: manifest.projectName,
          dbSetup: manifest.modules?.dbSetup ?? 'manual',
          s3Setup: storageConfig.s3Setup,
          s3Credentials: storageConfig.s3Credentials
        })
      }

      manifest.modules!.s3Setup = storageConfig.s3Setup
    }

    if (selectedModules.includes('analytics')) {
      moduleSpinner.text = 'Installing Umami analytics module...'
      await installAnalyticsModule({ webPath })
      manifest.modules!.includeAnalytics = true
    }

    if (selectedModules.includes('srs') && srsBootstrap) {
      moduleSpinner.text = 'Bootstrapping SRS workspace...'
      await installSrsSkill({ targetPath: '.' })
      const adapter = new NotionSrsAdapter({
        apiToken: srsBootstrap.notionApiToken,
        notionVersion: srsBootstrap.notionApiVersion
      })
      const result = await bootstrapSrs({
        projectName: manifest.projectName,
        parentInput: srsBootstrap.parentInput,
        adapter
      })
      const srsTools: SrsToolConfig = {
        enabled: true,
        backend: srsBootstrap.backend,
        rootPage: result.rootPage
      }
      manifest.tools = { ...(manifest.tools ?? {}), srs: srsTools }

      const envPath = join('.', '.env')
      upsertEnvKey(envPath, 'NOTION_API_TOKEN', srsBootstrap.notionApiToken)
      if (srsBootstrap.notionApiVersion) {
        upsertEnvKey(envPath, 'NOTION_API_VERSION', srsBootstrap.notionApiVersion)
      }
      ensureGitignorePatterns(join('.', '.gitignore'), ['.env', '.env.local', '.env*.local'])
    }

    // Install selected advanced skills
    if (skillsToAdd.length > 0) {
      moduleSpinner.text = 'Installing advanced skills...'
      const mergedSkills = [...new Set([...(manifest.modules?.advancedSkills ?? []), ...skillsToAdd])]
      if (isScaffoldManifest(manifest)) {
        await installSkills({
          isMonorepo,
          apiPath,
          webPath,
          projectName: manifest.projectName,
          version: cliVersion,
          mainBranch: manifest.mainBranch,
          advancedSkills: mergedSkills,
          ...skillsCredentials
        })
      } else {
        // Harness/cli manifests have no apps/* layout — deposit at the repo
        // root and keep the harness hash tracking in sync.
        await installOptionalSkills({ targetPath: '.', selectedSkills: skillsToAdd })
        manifest.fileHashes = { ...(manifest.fileHashes ?? {}), ...(await computeHarnessFileHashes('.')) }
      }
      manifest.modules = { ...(manifest.modules ?? {}), advancedSkills: mergedSkills }
    }

    // Run npm install if new dependencies were added
    if (selectedModules.includes('storage') || selectedModules.includes('email')) {
      moduleSpinner.text = 'Installing dependencies...'
      const nvm = getNvmPrefix(isMonorepo ? process.cwd() : apiPath)
      if (isMonorepo) {
        runRequired('npm install (monorepo root)', `${nvm}npm install`)
      } else {
        runRequired('npm install (api)', `${nvm}npm install --prefix ${apiPath}`)
      }
    }

    // Recompute file hashes after module installation and update manifest.
    // A full sweep of fileHashes only makes sense for scaffolded SaaS
    // projects (template-drift tracking). Harness-only manifests track just
    // their deposited files — sweeping the whole user repo would treat the
    // user's own code as SaaSFoundryAI templates.
    moduleSpinner.text = 'Updating project manifest...'
    if (isScaffoldManifest(manifest)) {
      manifest.fileHashes = await refreshProjectHashes(manifest)
      if (harnessTargetHashes) {
        // Harness deposits keep their TARGET baseline — the disk sweep would
        // re-absorb a conflicted (sidecar'd) user edit and silently overwrite
        // it on the next refresh.
        for (const [p, h] of Object.entries(harnessTargetHashes)) manifest.fileHashes[p] = h
      }
    }
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2))

    moduleSpinner.succeed(chalk.green('Modules installed successfully'))
  } catch (error) {
    moduleSpinner.fail(chalk.red('Failed to install modules'))
    console.error(error)
    process.exit(1)
  }

  // Display summary
  console.log(chalk.green('\n  ' + '═'.repeat(60)))
  console.log(chalk.green.bold('  Modules installed:'))
  if (selectedModules.includes('email')) console.log(chalk.green('    ✓ MailerSend Email Service'))
  if (selectedModules.includes('storage')) console.log(chalk.green('    ✓ S3 Object Storage'))
  if (selectedModules.includes('analytics')) console.log(chalk.green('    ✓ Umami Analytics'))
  for (const skill of skillsToAdd) {
    console.log(chalk.green(`    ✓ Advanced Skill: ${skill.charAt(0).toUpperCase() + skill.slice(1)}`))
  }
  console.log(chalk.green('  ' + '═'.repeat(60)))
  console.log()

  if (selectedModules.includes('analytics')) {
    console.log(chalk.blue('  Note: To configure Umami analytics, set VITE_ANALYTICS_URL and'))
    console.log(chalk.blue('  VITE_ANALYTICS_WEBSITE_ID in your web app .env file.'))
    console.log()
  }

  if (selectedModules.includes('storage') && storageConfig?.s3Setup === 'docker') {
    console.log(chalk.blue('  To start MinIO, run:'))
    console.log(chalk.blue(`    docker compose -f ${apiPath}/docker-compose.dev-services.yml up -d s3-dev s3-init`))
    console.log(chalk.blue(`  MinIO Console: http://localhost:${manifest.ports?.s3Console ?? 9001}`))
    console.log()
  }
}

/**
 * Emit the dry-run report as pretty-printed JSON on stdout. Prefixed with a
 * marker so callers parsing the output can locate the report regardless of
 * surrounding status log lines.
 */
function emitDryRunReport(report: UpdateDryRunReport): void {
  console.log('\n<sf-update-dry-run-report>')
  console.log(JSON.stringify(report, null, 2))
  console.log('</sf-update-dry-run-report>')
}
