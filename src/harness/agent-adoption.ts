import { createHash } from 'crypto'
import { lstat, readFile, readdir } from 'fs/promises'
import { join, resolve } from 'path'

import { inspectInstructionSource, AgentInstructionPlan } from './agent-instructions'
import { enableAgents, AgentSupportResult } from './agent-support'
import { getAgentIds, isHarnessAgent } from './agent-registry'
import type { HarnessAgent } from '../types'

export interface AgentAdoptionPlan {
  version: 1
  planId: string
  scope: 'local' | 'shared'
  requestedAgents: HarnessAgent[]
  source: string
  inventory: { path: string; kind: string }[]
  files: { path: string; action: 'create' | 'reuse' | 'update' | 'conflict' }[]
  conflicts: string[]
  warnings: string[]
  prerequisites: string[]
  canApply: boolean
}
interface AdoptionParams {
  targetPath: string
  agents: string[]
  scope?: string
}
const digest = (value: Buffer | string) => createHash('sha256').update(value).digest('hex')
const knownPaths = [
  '.saasfoundry.json',
  'CLAUDE.md',
  'AGENTS.md',
  'GEMINI.md',
  '.claude/skills',
  '.agents/skills',
  '.codex/skills',
  '.gemini/skills',
  '.qwen/skills',
  '.claude/settings.json',
  '.claude/settings.local.json',
  '.codex/config.toml',
  '.gemini/settings.json',
  '.claude/hooks',
  '.codex/hooks',
  '.gemini/hooks'
]

/** Inspect metadata only; never follow a link into a credentials/config directory. */
async function kind(root: string, path: string): Promise<string> {
  let current = root
  for (const part of path.split('/')) {
    current = join(current, part)
    try {
      const stat = await lstat(current)
      if (stat.isSymbolicLink()) return 'symbolic-link'
      if (current !== join(root, path) && !stat.isDirectory()) return 'invalid-ancestor'
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
      throw error
    }
  }
  const stat = await lstat(current)
  return stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : 'other'
}

/** The public preview contains paths/actions only, never source/configuration contents. */
async function buildAdoptionPlan(params: AdoptionParams, capture?: (plan: AgentInstructionPlan) => void): Promise<AgentAdoptionPlan> {
  const root = resolve(params.targetPath)
  const rootStat = await lstat(root)
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error('Adoption requires a regular project directory.')
  if (!params.agents.length || params.agents.some((agent) => !isHarnessAgent(agent))) throw new Error(`Choose coding agents from the registered tool profiles: ${getAgentIds().join(', ')}.`)
  if (params.scope !== undefined && !['local', 'shared'].includes(params.scope)) throw new Error('Agent scope must be local (default) or shared.')
  const requestedAgents = getAgentIds().filter((agent) => params.agents.includes(agent))
  const scope = params.scope === 'shared' ? 'shared' : 'local'
  const plan: AgentAdoptionPlan = {
    version: 1,
    planId: '',
    scope,
    requestedAgents,
    source: 'missing',
    inventory: [],
    files: [],
    conflicts: [],
    warnings: [
      'Existing instructions, custom skills, hooks and settings remain user-owned. No credentials are copied or printed.',
      'Native hooks, permissions, MCP configuration and runtime discovery are not transferred or verified. Read existing skills explicitly when native discovery is unavailable.',
      'Adoption never removes another adapter. Removal is a separate explicit operation.'
    ],
    prerequisites: [],
    canApply: false
  }
  for (const path of knownPaths) {
    const entryKind = await kind(root, path)
    if (entryKind === 'missing') continue
    plan.inventory.push({ path, kind: entryKind })
    if (path.endsWith('/skills') && entryKind === 'directory') {
      for (const entry of (await readdir(join(root, path), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.name.startsWith('.')) continue
        plan.inventory.push({ path: `${path}/${entry.name}`, kind: entry.isSymbolicLink() ? 'symbolic-link' : entry.isDirectory() ? 'directory' : 'file' })
      }
    }
  }
  const evidence: unknown[] = []
  try {
    const source = await inspectInstructionSource(root)
    plan.source = source.source
    if (source.source === 'mixed') plan.conflicts.push('AGENTS.md')
    if (source.source === 'missing') plan.prerequisites.push('Add project instructions in CLAUDE.md or AGENTS.md before adoption.')
    if (!((await kind(root, '.saasfoundry.json')) === 'file')) {
      plan.prerequisites.push('A valid existing .saasfoundry.json is required to apply. Configure the project with sf workflow first; adoption does not invent workflow or SRS settings.')
    } else if (source.source !== 'missing') {
      const preview = await enableAgents({ targetPath: root, agents: requestedAgents, scope, preview: true, adoption: true })
      plan.conflicts.push(...preview.report.conflicts)
      plan.warnings.push(...preview.report.warnings)
      evidence.push(preview.fingerprint)
      if (preview.previewPlan) capture?.(preview.previewPlan)
      for (const path of [...new Set([...preview.report.written, ...preview.report.unchanged, ...preview.report.conflicts])].sort()) {
        const entryKind = await kind(root, path)
        const action = preview.report.conflicts.includes(path) ? 'conflict' : preview.report.unchanged.includes(path) ? 'reuse' : entryKind === 'missing' ? 'create' : 'update'
        plan.files.push({ path, action })
        if (entryKind === 'file') evidence.push([path, digest(await readFile(join(root, path))), (await lstat(join(root, path))).mode])
        else evidence.push([path, entryKind])
      }
    }
  } catch (error) {
    plan.prerequisites.push(error instanceof Error ? error.message : 'Unable to inspect adoption prerequisites.')
  }
  for (const path of ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md', '.saasfoundry.json']) {
    if ((await kind(root, path)) === 'file') evidence.push([path, digest(await readFile(join(root, path))), (await lstat(join(root, path))).mode])
  }
  plan.conflicts = [...new Set(plan.conflicts)]
  if (plan.source === 'mixed')
    plan.warnings.push('CLAUDE.md and AGENTS.md contain distinct customized sources. Reconcile their rules and reference direction explicitly before adoption; neither source will be overwritten.')
  plan.canApply = !plan.conflicts.length && !plan.prerequisites.length
  plan.planId = digest(JSON.stringify({ root, plan, evidence }))
  return plan
}

export async function planAgentAdoption(params: AdoptionParams): Promise<AgentAdoptionPlan> {
  return buildAdoptionPlan(params)
}

export async function applyAgentAdoption(params: AdoptionParams & { planId: string }): Promise<AgentSupportResult> {
  if (!/^[a-f0-9]{64}$/.test(params.planId)) throw new Error('Adoption requires the plan identifier from a fresh preview (--apply --plan <id>).')
  const verify = async () => {
    let captured: AgentInstructionPlan | undefined
    const current = await buildAdoptionPlan(params, (plan) => {
      captured = plan
    })
    if (current.planId !== params.planId) throw new Error('Adoption plan is stale. No new setup was applied; preview the current project and retry with its plan identifier.')
    if (!current.canApply || !captured) throw new Error('Adoption plan has conflicts or missing prerequisites. Reconcile them and generate a fresh preview before applying.')
    return captured
  }
  await verify()
  return enableAgents({ targetPath: params.targetPath, agents: params.agents, scope: params.scope, adoption: true, verify })
}
