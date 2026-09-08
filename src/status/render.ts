import chalk from 'chalk'

import { isAllDefaultLanguages, resolveOutputLanguages } from '../language'
import type { StatusReport } from './collect'
import type { Precondition, PreconditionStatus } from './preconditions'

export interface RenderPayload {
  report: StatusReport
  preconditions: Precondition[]
}

const STATUS_ICON: Record<PreconditionStatus, string> = { ok: '✓', warn: '⚠', fail: '✗', skip: '·' }

function colorize(status: PreconditionStatus, text: string): string {
  switch (status) {
    case 'ok':
      return chalk.green(text)
    case 'warn':
      return chalk.yellow(text)
    case 'fail':
      return chalk.red(text)
    case 'skip':
      return chalk.gray(text)
  }
}

export function renderHuman(payload: RenderPayload): string {
  const { report, preconditions } = payload
  const lines: string[] = []

  lines.push(chalk.bold('SaaSFoundryAI — Project Status'))
  lines.push('')
  if (report.manifest) {
    lines.push(`${chalk.gray('Project:')} ${report.manifest.projectName} (${report.manifest.structure}) — v${report.manifest.version}`)
  } else {
    lines.push(chalk.red('Not a SaaSFoundryAI project (no .saasfoundry.json)'))
  }
  if (report.git.available) {
    const dirty = report.git.isClean === false ? chalk.yellow(' (dirty)') : ''
    const tracking = report.git.upstream ? chalk.gray(` → ${report.git.upstream} [ahead ${report.git.ahead ?? '?'}, behind ${report.git.behind ?? '?'}]`) : ''
    lines.push(`${chalk.gray('Git:')} ${report.git.branch ?? 'detached'}${dirty}${tracking}`)
  }
  if (report.installedSkills.length > 0) {
    lines.push(`${chalk.gray('Skills:')} ${report.installedSkills.join(', ')}`)
  }
  if (report.manifest) {
    const languages = resolveOutputLanguages(report.manifest)
    // Stay quiet in the all-English case: restating the default on every run
    // trains people to skim past the block that matters when it is not.
    if (!isAllDefaultLanguages(languages)) {
      lines.push(`${chalk.gray('AI writes in:')} srs ${languages.srs}, tickets ${languages.tickets}, code comments ${languages.codeComments}`)
    }
  }
  lines.push('')
  lines.push(chalk.bold('Preconditions'))
  for (const p of preconditions) {
    const icon = colorize(p.status, STATUS_ICON[p.status])
    const header = `${icon} ${p.description}`
    const details = p.details ? chalk.gray(` — ${p.details}`) : ''
    lines.push(`  ${header}${details}`)
    if (p.remediation && (p.status === 'fail' || p.status === 'warn')) {
      lines.push(`      ${chalk.gray('→')} ${p.remediation}`)
    }
  }
  lines.push('')
  return lines.join('\n')
}

export function renderJson(payload: RenderPayload): string {
  const { report, preconditions } = payload
  const out = {
    projectRoot: report.projectRoot,
    manifest: report.manifest
      ? {
          version: report.manifest.version,
          projectName: report.manifest.projectName,
          structure: report.manifest.structure,
          workflow: report.manifest.workflow?.tool ?? null,
          tools: report.manifest.tools ?? null,
          // Always resolved, never echoed raw: a consumer must not have to
          // re-implement the "absent means English" rule.
          language: resolveOutputLanguages(report.manifest)
        }
      : null,
    git: report.git,
    installedSkills: report.installedSkills,
    preconditions: preconditions.map((p) => ({
      name: p.name,
      description: p.description,
      status: p.status,
      details: p.details ?? null,
      remediation: p.remediation ?? null
    }))
  }
  return JSON.stringify(out, null, 2)
}

export function renderAgentFriendly(payload: RenderPayload): string {
  const { report, preconditions } = payload
  const lines: string[] = []
  lines.push('# SaaSFoundryAI project status')
  lines.push('')
  if (report.manifest) {
    lines.push(`- project: ${report.manifest.projectName} (${report.manifest.structure}, v${report.manifest.version})`)
    lines.push(`- workflow: ${report.manifest.workflow?.tool ?? 'none'}`)
    const srs = report.manifest.tools?.srs
    lines.push(`- srs: ${srs?.enabled ? `${srs.backend} — ${srs.rootPage?.name ?? 'no root page'}` : 'not installed'}`)
  } else {
    lines.push('- project: NOT a SaaSFoundryAI project (no .saasfoundry.json)')
  }
  if (report.git.available) {
    const state = report.git.isClean === false ? 'dirty' : 'clean'
    lines.push(`- git: ${report.git.branch ?? 'detached'} (${state})`)
  }
  if (report.installedSkills.length > 0) {
    lines.push(`- skills: ${report.installedSkills.join(', ')}`)
  }
  if (report.manifest) {
    const languages = resolveOutputLanguages(report.manifest)
    lines.push(`- output language: srs ${languages.srs}, tickets ${languages.tickets}, code comments ${languages.codeComments}`)
  }
  lines.push('')
  lines.push('## Preconditions')
  for (const p of preconditions) {
    lines.push(`- [${p.status}] ${p.description}${p.details ? ` — ${p.details}` : ''}`)
    if (p.remediation && (p.status === 'fail' || p.status === 'warn')) {
      lines.push(`  - remediation: ${p.remediation}`)
    }
  }
  lines.push('')
  lines.push('## How to use this output')
  lines.push('- Any `fail` precondition means you MUST resolve it before taking project actions; read the remediation.')
  lines.push('- `warn` preconditions may block specific flows (e.g. workflow transitions, SRS drafters); treat the remediation as required for that flow.')
  lines.push('- `skip` means the check was not applicable or not requested; do not act on it.')
  lines.push(
    '- Write every artefact in the `output language` above — SRS pages, tickets and their comments, code comments, commit messages. The language of the conversation is NOT the signal: a session held in French still produces English artefacts when the project says `en`.'
  )
  lines.push('')
  return lines.join('\n')
}

/** Compatible export for existing integrations and SessionStart hooks. */
export const renderClaudeFriendly = renderAgentFriendly
