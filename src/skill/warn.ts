import chalk from 'chalk'

import { SKILL_NAME } from './paths'
import { checkSkillStatus } from './update'

/**
 * Emit a soft warning to stderr when the user-scope skill install is stale
 * relative to the CLI bundle. This is called at the start of every `sf *`
 * invocation — it must never throw, never block, and never perform I/O that
 * noticeably slows down the CLI.
 *
 * Opt-out: set `SF_SKILL_NO_WARN=1` in the environment.
 * Skipped: when the user has no install at all (fresh users are not nagged)
 *          and when the subcommand is the skill manager itself (install/update/uninstall),
 *          since the warning would duplicate that command's own output.
 *          Agent diagnostics also skip this unrelated user-scope inspection.
 */
export async function maybeEmitStaleSkillWarning(argv: string[], bundledVersion: string): Promise<void> {
  if (process.env.SF_SKILL_NO_WARN === '1' || process.env.SF_SKILL_NO_WARN === 'true') return
  if (argv[2] === 'agents' && argv[3] === 'doctor') return
  if (isSkillLifecycleInvocation(argv)) return

  try {
    const status = await checkSkillStatus('user', bundledVersion)
    if (!status.installed || !status.stale) return
    process.stderr.write(chalk.yellow(`⚠  ${SKILL_NAME} skill is out of date (${status.installedVersion} → ${bundledVersion}). Run: sf skill update\n`))
  } catch {
    // never block on a best-effort advisory
  }
}

function isSkillLifecycleInvocation(argv: string[]): boolean {
  const command = argv[2]
  if (command === 'skill') return true
  if (command === 'uninstall') return true
  return false
}
