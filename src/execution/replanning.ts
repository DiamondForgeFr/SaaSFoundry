import { assertExactCostEvidence } from './exact-cost'
import { stableFingerprint } from './overrides'
import { selectMinimumCostExecutionPlan } from './planner'
import { assertExecutionPlanDecision, assertExecutionPlanProposal, type ExecutionOutcomeCode, type ExecutionPlanDecision, type ExecutionPlanProposal, type ExecutionPlanSelectionPolicy } from './plans'
import type { ExactCostEvidence } from './plans'
import type { ExecutionRequirementSet } from './requirements'
import type { ExecutionCandidateCatalogueSnapshot } from './types'

const SAFE_ID = /^[a-z0-9][a-z0-9._:/-]{0,127}$/i
const SECRET_LIKE = /(?:\bBearer\s+|\b(?:sk|gh[pousr]|github_pat|xox[baprs])[_-]|\beyJ[a-zA-Z0-9_-]{8,}\.)/i
const FINGERPRINT = /^[a-f0-9]{64}$/
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const MAX_HISTORY = 32
const MAX_EVIDENCE_REFS = 64

export type ExecutionReplanTrigger =
  | 'execution-failed'
  | 'validation-failed'
  | 'candidate-unavailable'
  | 'stale-evidence'
  | 'policy-changed'
  | 'scope-changed'
  | 'dispatch-permit-expired'
  | 'outcome-unknown'

export type ExecutionObservedOutcome = ExecutionOutcomeCode | 'outcome-unknown'
export type ExecutionLineageTerminalState = 'active' | 'completed' | 'aborted' | 'blocked'
export type ExecutionAttemptStatus = 'planned' | 'running' | 'completed' | 'failed' | 'aborted'

export interface ExecutionAttemptRecord {
  schemaVersion: 1
  id: string
  sequence: number
  trigger: 'initial' | ExecutionReplanTrigger
  status: ExecutionAttemptStatus
  replanRequestId?: string
  decisionId: string
  planDecisionId: string
  proposalFingerprint: string
  requirementsId: string
  catalogueFingerprint: string
  policyFingerprint: string
  planningAt: string
  scopeRevision: string
  parentAttemptId?: string
  nodeId?: string
  outcomeCode?: ExecutionObservedOutcome
  /** Budget-owned evidence; this module never derives or compares it. */
  reservedInvocationP95?: ExactCostEvidence
  /** Every still-undispatched permit superseded by this fresh plan revision. */
  invalidatedPermitIds: string[]
  evidenceRefs: string[]
}

export interface ExecutionLineage {
  schemaVersion: 1
  id: string
  runId: string
  revision: number
  historyHead: string
  requirementsId: string
  taskFingerprint: string
  maxAttempts: number
  maxReplans: number
  scopeRevision: string
  terminalState: ExecutionLineageTerminalState
  currentAttemptId: string
  currentPlanDecisionId: string
  attempts: ExecutionAttemptRecord[]
}

export interface ExecutionReplanRequest {
  schemaVersion: 1
  id: string
  parentPlanDecisionId: string
  parentAttemptId: string
  trigger: ExecutionReplanTrigger
  scopeRevision: string
  nodeId?: string
  outcomeCode?: ExecutionObservedOutcome
  invalidatedPermitIds: string[]
  evidenceRefs: string[]
}

export interface ExecutionReplanResult {
  lineage: ExecutionLineage
  decision: ExecutionPlanDecision
  request: ExecutionReplanRequest
}

export interface ExecutionReplanHostAuthority {
  verifyLineage(lineage: Readonly<ExecutionLineage>, request: Readonly<ExecutionReplanRequest>): boolean
  verifyScopeRevision(request: Readonly<ExecutionReplanRequest>, requirements: Readonly<ExecutionRequirementSet>): boolean
}

export class ExecutionReplanContractError extends Error {
  readonly issues: string[]

  constructor(issues: string[]) {
    super(`Invalid execution replan contract: ${issues.join('; ')}`)
    this.name = 'ExecutionReplanContractError'
    this.issues = [...issues]
  }
}

export function createExecutionReplanRequest(value: Omit<ExecutionReplanRequest, 'id'>): ExecutionReplanRequest {
  const payload = { ...value, invalidatedPermitIds: [...value.invalidatedPermitIds].sort(), evidenceRefs: [...value.evidenceRefs].sort() }
  const request = { ...payload, id: stableFingerprint(payload) } as ExecutionReplanRequest
  assertExecutionReplanRequest(request)
  return freeze(request)
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function safeId(value: unknown): value is string {
  return typeof value === 'string' && SAFE_ID.test(value) && !SECRET_LIKE.test(value)
}

function fingerprint(value: unknown): value is string {
  return typeof value === 'string' && FINGERPRINT.test(value)
}

function timestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !TIMESTAMP.test(value)) return false
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value
}

function rejectUnknown(value: Record<string, unknown>, fields: readonly string[], label: string, issues: string[]): void {
  const unknown = Object.keys(value).filter((field) => !fields.includes(field))
  if (unknown.length) issues.push(`${label} contains unsupported fields: ${unknown.sort().join(', ')}`)
}

function refs(value: unknown, label: string, issues: string[]): value is string[] {
  if (!Array.isArray(value) || value.length > MAX_EVIDENCE_REFS || value.some((entry) => !safeId(entry))) {
    issues.push(`${label} must contain at most ${MAX_EVIDENCE_REFS} safe public identifiers`)
    return false
  }
  if (new Set(value).size !== value.length) issues.push(`${label} must not contain duplicates`)
  return true
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const entry of Object.values(value as Record<string, unknown>)) freeze(entry)
    Object.freeze(value)
  }
  return value
}

function finalize<T extends object>(value: T): T & { id: string } {
  return freeze({ ...value, id: stableFingerprint(value) })
}

function withoutId<T extends { id: string }>(value: T): Omit<T, 'id'> {
  const payload = { ...value }
  delete (payload as Partial<T>).id
  return payload
}

function semanticProposalFingerprint(proposal: ExecutionPlanProposal): string {
  return stableFingerprint({
    ...proposal,
    nodes: proposal.nodes
      .map((node) => ({
        ...node,
        tools: [...node.tools].sort(),
        checks: [...node.checks].sort(),
        outcomes: [...node.outcomes].sort((left, right) =>
          `${left.code}/${left.nextNodeId ?? ''}/${left.evidenceRef}/${left.conditionalProbability}`.localeCompare(
            `${right.code}/${right.nextNodeId ?? ''}/${right.evidenceRef}/${right.conditionalProbability}`
          )
        )
      }))
      .sort((left, right) => left.id.localeCompare(right.id))
  })
}

const TRIGGERS: ExecutionReplanTrigger[] = [
  'execution-failed',
  'validation-failed',
  'candidate-unavailable',
  'stale-evidence',
  'policy-changed',
  'scope-changed',
  'dispatch-permit-expired',
  'outcome-unknown'
]

export function assertExecutionReplanRequest(value: unknown): asserts value is ExecutionReplanRequest {
  const issues: string[] = []
  if (!object(value)) throw new ExecutionReplanContractError(['request must be an object'])
  rejectUnknown(
    value,
    ['schemaVersion', 'id', 'parentPlanDecisionId', 'parentAttemptId', 'trigger', 'scopeRevision', 'nodeId', 'outcomeCode', 'invalidatedPermitIds', 'evidenceRefs'],
    'request',
    issues
  )
  if (value.schemaVersion !== 1) issues.push('request.schemaVersion must equal 1')
  if (!fingerprint(value.id)) issues.push('request.id must be a SHA-256 fingerprint')
  if (!fingerprint(value.parentPlanDecisionId)) issues.push('request.parentPlanDecisionId must be a SHA-256 fingerprint')
  if (!fingerprint(value.parentAttemptId)) issues.push('request.parentAttemptId must be a SHA-256 fingerprint')
  if (!TRIGGERS.includes(value.trigger as ExecutionReplanTrigger)) issues.push('request.trigger is unsupported')
  if (!safeId(value.scopeRevision)) issues.push('request.scopeRevision must be a safe public identifier')
  if (value.nodeId !== undefined && !safeId(value.nodeId)) issues.push('request.nodeId must be a safe public identifier')
  if (
    value.outcomeCode !== undefined &&
    !(['success', 'execution-failed', 'validation-failed', 'candidate-unavailable', 'outcome-unknown'] as ExecutionObservedOutcome[]).includes(value.outcomeCode as ExecutionObservedOutcome)
  )
    issues.push('request.outcomeCode is unsupported')
  refs(value.evidenceRefs, 'request.evidenceRefs', issues)
  refs(value.invalidatedPermitIds, 'request.invalidatedPermitIds', issues)
  if (value.trigger === 'execution-failed' || value.trigger === 'validation-failed' || value.trigger === 'candidate-unavailable') {
    if (!safeId(value.nodeId)) issues.push('failure replans require request.nodeId')
    if (value.outcomeCode === undefined) issues.push('failure replans require request.outcomeCode')
    if (value.trigger === 'execution-failed' && value.outcomeCode !== 'execution-failed') issues.push('execution-failed trigger must match its failure outcome')
    if (value.trigger === 'validation-failed' && value.outcomeCode !== 'validation-failed') issues.push('validation-failed trigger must match its failure outcome')
    if (value.trigger === 'candidate-unavailable' && value.outcomeCode !== 'candidate-unavailable') issues.push('candidate-unavailable trigger must match its failure outcome')
  }
  if (value.outcomeCode === 'success') issues.push('successful outcomes cannot trigger a replan')
  if (value.outcomeCode === 'outcome-unknown' && value.trigger !== 'outcome-unknown') issues.push('outcome-unknown requires the outcome-unknown trigger')
  if (value.trigger === 'dispatch-permit-expired' && Array.isArray(value.invalidatedPermitIds) && value.invalidatedPermitIds.length === 0)
    issues.push('dispatch-permit-expired requires an invalidated permit')
  if (issues.length) throw new ExecutionReplanContractError(issues)
  if (value.id !== stableFingerprint({ ...value, id: undefined })) throw new ExecutionReplanContractError(['request.id does not match its canonical payload'])
}

export function assertExecutionLineage(value: unknown): asserts value is ExecutionLineage {
  const issues: string[] = []
  if (!object(value)) throw new ExecutionReplanContractError(['lineage must be an object'])
  rejectUnknown(
    value,
    [
      'schemaVersion',
      'id',
      'runId',
      'revision',
      'historyHead',
      'requirementsId',
      'taskFingerprint',
      'maxAttempts',
      'maxReplans',
      'scopeRevision',
      'terminalState',
      'currentAttemptId',
      'currentPlanDecisionId',
      'attempts'
    ],
    'lineage',
    issues
  )
  if (value.schemaVersion !== 1) issues.push('lineage.schemaVersion must equal 1')
  if (!fingerprint(value.id)) issues.push('lineage.id must be a SHA-256 fingerprint')
  if (!safeId(value.runId)) issues.push('lineage.runId must be a safe public identifier')
  if (!Number.isSafeInteger(value.revision) || Number(value.revision) < 0) issues.push('lineage.revision must be a non-negative safe integer')
  if (!fingerprint(value.historyHead)) issues.push('lineage.historyHead must be a SHA-256 fingerprint')
  if (!fingerprint(value.requirementsId) || !fingerprint(value.taskFingerprint)) issues.push('lineage requirements and task fingerprints must be SHA-256 fingerprints')
  if (!Number.isSafeInteger(value.maxAttempts) || Number(value.maxAttempts) < 1 || Number(value.maxAttempts) > MAX_HISTORY) issues.push(`lineage.maxAttempts must be between 1 and ${MAX_HISTORY}`)
  if (!Number.isSafeInteger(value.maxReplans) || Number(value.maxReplans) < 0 || Number(value.maxReplans) >= Number(value.maxAttempts)) issues.push('lineage.maxReplans must be less than maxAttempts')
  if (!safeId(value.scopeRevision)) issues.push('lineage.scopeRevision must be a safe public identifier')
  if (!['active', 'completed', 'aborted', 'blocked'].includes(value.terminalState as string)) issues.push('lineage.terminalState is unsupported')
  if (!fingerprint(value.currentAttemptId)) issues.push('lineage.currentAttemptId must be a SHA-256 fingerprint')
  if (!fingerprint(value.currentPlanDecisionId)) issues.push('lineage.currentPlanDecisionId must be a SHA-256 fingerprint')
  if (!Array.isArray(value.attempts) || value.attempts.length === 0 || value.attempts.length > MAX_HISTORY) issues.push(`lineage.attempts must contain between 1 and ${MAX_HISTORY} entries`)
  else {
    const attempts = value.attempts
    const ids = new Set<string>()
    attempts.forEach((attempt, index) => {
      if (!object(attempt)) {
        issues.push(`lineage.attempts[${index}] must be an object`)
        return
      }
      rejectUnknown(
        attempt,
        [
          'schemaVersion',
          'id',
          'sequence',
          'trigger',
          'status',
          'replanRequestId',
          'decisionId',
          'planDecisionId',
          'proposalFingerprint',
          'requirementsId',
          'catalogueFingerprint',
          'policyFingerprint',
          'planningAt',
          'scopeRevision',
          'parentAttemptId',
          'nodeId',
          'outcomeCode',
          'reservedInvocationP95',
          'invalidatedPermitIds',
          'evidenceRefs'
        ],
        `lineage.attempts[${index}]`,
        issues
      )
      if (attempt.schemaVersion !== 1) issues.push(`lineage.attempts[${index}].schemaVersion must equal 1`)
      if (!fingerprint(attempt.id) || ids.has(attempt.id as string)) issues.push(`lineage.attempts[${index}].id must be unique fingerprints`)
      else ids.add(attempt.id as string)
      if (!Number.isSafeInteger(attempt.sequence) || attempt.sequence !== index) issues.push(`lineage.attempts[${index}].sequence must be contiguous`)
      if (!['initial', ...TRIGGERS].includes(attempt.trigger as string)) issues.push(`lineage.attempts[${index}].trigger is unsupported`)
      if (!['planned', 'running', 'completed', 'failed', 'aborted'].includes(attempt.status as string)) issues.push(`lineage.attempts[${index}].status is unsupported`)
      if (attempt.replanRequestId !== undefined && !fingerprint(attempt.replanRequestId)) issues.push(`lineage.attempts[${index}].replanRequestId must be a SHA-256 fingerprint`)
      if (!fingerprint(attempt.decisionId)) issues.push(`lineage.attempts[${index}].decisionId must be a SHA-256 fingerprint`)
      for (const field of ['planDecisionId', 'proposalFingerprint', 'requirementsId', 'catalogueFingerprint', 'policyFingerprint'] as const)
        if (!fingerprint(attempt[field])) issues.push(`lineage.attempts[${index}].${field} must be a SHA-256 fingerprint`)
      if (!timestamp(attempt.planningAt) || !safeId(attempt.scopeRevision)) issues.push(`lineage.attempts[${index}] has invalid planning or scope evidence`)
      if (attempt.parentAttemptId !== undefined && !fingerprint(attempt.parentAttemptId)) issues.push(`lineage.attempts[${index}].parentAttemptId must be a fingerprint`)
      if (attempt.nodeId !== undefined && !safeId(attempt.nodeId)) issues.push(`lineage.attempts[${index}].nodeId must be safe`)
      refs(attempt.evidenceRefs, `lineage.attempts[${index}].evidenceRefs`, issues)
      refs(attempt.invalidatedPermitIds, `lineage.attempts[${index}].invalidatedPermitIds`, issues)
      if (attempt.reservedInvocationP95 !== undefined) {
        try {
          assertExactCostEvidence(attempt.reservedInvocationP95, `lineage.attempts[${index}].reservedInvocationP95`)
        } catch (error) {
          issues.push(error instanceof Error ? error.message : `lineage.attempts[${index}].reservedInvocationP95 is invalid`)
        }
      }
      const attemptPayload = { ...attempt }
      delete attemptPayload.id
      if (fingerprint(attempt.id) && attempt.id !== stableFingerprint(attemptPayload)) issues.push(`lineage.attempts[${index}].id does not match its canonical payload`)
      if (index === 0 && attempt.parentAttemptId !== undefined) issues.push('lineage initial attempt must not have a parent')
      if (index > 0 && attempt.parentAttemptId !== (attempts[index - 1] as Record<string, unknown>).id) issues.push(`lineage.attempts[${index}] must link to the previous attempt`)
    })
    const current = attempts[attempts.length - 1] as Record<string, unknown>
    if (current && (value.currentAttemptId !== current.id || value.currentPlanDecisionId !== current.planDecisionId || value.historyHead !== current.id))
      issues.push('lineage current pointers must reference the last attempt')
    if (value.terminalState === 'blocked' && current?.outcomeCode !== 'outcome-unknown') issues.push('blocked lineage must end with an outcome-unknown record')
  }
  const maxAttempts = typeof value.maxAttempts === 'number' ? value.maxAttempts : -1
  const maxReplans = typeof value.maxReplans === 'number' ? value.maxReplans : -1
  if (Array.isArray(value.attempts) && Number.isSafeInteger(maxAttempts) && value.attempts.length > maxAttempts) issues.push('lineage attempts exceed maxAttempts')
  if (Array.isArray(value.attempts) && Number.isSafeInteger(maxReplans) && value.attempts.filter((attempt) => object(attempt) && attempt.trigger !== 'initial').length > maxReplans)
    issues.push('lineage replans exceed maxReplans')
  if (issues.length) throw new ExecutionReplanContractError(issues)
  const payload = { ...value }
  delete (payload as Partial<ExecutionLineage>).id
  if (value.id !== stableFingerprint(payload)) throw new ExecutionReplanContractError(['lineage.id does not match its canonical payload'])
}

function selectedProposal(decision: ExecutionPlanDecision, proposalValue: unknown): ExecutionPlanProposal {
  if (decision.status !== 'selected' || !decision.selected) throw new ExecutionReplanContractError(['parent plan must be selected'])
  const proposal = proposalValue
  if (proposal === undefined) throw new ExecutionReplanContractError(['parent proposal is required independently from fresh proposals'])
  assertExecutionPlanProposal(proposal)
  if (semanticProposalFingerprint(proposal) !== decision.selected.proposalFingerprint) throw new ExecutionReplanContractError(['parent proposal fingerprint does not match the selected plan'])
  return proposal
}

export function createExecutionLineage(
  decisionValue: unknown,
  scopeRevision: string,
  evidenceRefs: readonly string[] = [],
  options: { runId?: string; maxAttempts?: number; maxReplans?: number; taskFingerprint?: string } = {}
): ExecutionLineage {
  assertExecutionPlanDecision(decisionValue)
  const decision = decisionValue
  if (decision.status !== 'selected' || !decision.selected) throw new ExecutionReplanContractError(['lineage requires a selected plan'])
  if (!safeId(scopeRevision)) throw new ExecutionReplanContractError(['scopeRevision must be a safe public identifier'])
  const runId = options.runId ?? `run/${decision.id.slice(0, 16)}`
  const maxAttempts = options.maxAttempts ?? MAX_HISTORY
  const maxReplans = options.maxReplans ?? maxAttempts - 1
  if (!safeId(runId) || !Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > MAX_HISTORY || !Number.isSafeInteger(maxReplans) || maxReplans < 0 || maxReplans >= maxAttempts)
    throw new ExecutionReplanContractError(['invalid lineage bounds or runId'])
  const taskFingerprint = options.taskFingerprint ?? decision.requirementsId
  if (!fingerprint(taskFingerprint)) throw new ExecutionReplanContractError(['taskFingerprint must be a SHA-256 fingerprint'])
  const attempt = finalize({
    schemaVersion: 1 as const,
    sequence: 0,
    trigger: 'initial' as const,
    status: 'planned' as const,
    decisionId: decision.id,
    planDecisionId: decision.id,
    proposalFingerprint: decision.selected.proposalFingerprint,
    requirementsId: decision.requirementsId,
    catalogueFingerprint: decision.catalogueFingerprint,
    policyFingerprint: decision.policyFingerprint,
    planningAt: decision.planningAt,
    scopeRevision,
    invalidatedPermitIds: [],
    evidenceRefs: [...evidenceRefs].sort()
  }) as ExecutionAttemptRecord
  if (attempt.evidenceRefs.length > MAX_EVIDENCE_REFS || attempt.evidenceRefs.some((ref) => !safeId(ref))) throw new ExecutionReplanContractError(['evidenceRefs must contain safe public identifiers'])
  return finalize({
    schemaVersion: 1 as const,
    runId,
    revision: 1,
    historyHead: attempt.id,
    requirementsId: decision.requirementsId,
    taskFingerprint,
    maxAttempts,
    maxReplans,
    scopeRevision,
    terminalState: 'active' as const,
    currentAttemptId: attempt.id,
    currentPlanDecisionId: decision.id,
    attempts: [attempt]
  })
}

/** Records an ambiguous provider result as a blocked lineage until the host reconciles it. */
export function blockExecutionLineage(lineageValue: unknown, requestValue: unknown): ExecutionLineage {
  assertExecutionLineage(lineageValue)
  assertExecutionReplanRequest(requestValue)
  const lineage = lineageValue
  const request = requestValue
  if (request.trigger !== 'outcome-unknown' || request.outcomeCode !== 'outcome-unknown') throw new ExecutionReplanContractError(['only outcome-unknown requests can block a lineage'])
  if (lineage.terminalState !== 'active' || request.parentAttemptId !== lineage.currentAttemptId || request.parentPlanDecisionId !== lineage.currentPlanDecisionId)
    throw new ExecutionReplanContractError(['blocked lineage request does not match the active lineage head'])
  if (lineage.attempts.length >= lineage.maxAttempts) throw new ExecutionReplanContractError(['lineage attempt limit has been reached'])
  const previous = lineage.attempts[lineage.attempts.length - 1]
  const blockedAttempt = finalize({
    ...withoutId(previous),
    sequence: lineage.attempts.length,
    trigger: 'outcome-unknown' as const,
    status: 'aborted' as const,
    replanRequestId: request.id,
    parentAttemptId: previous.id,
    ...(request.nodeId ? { nodeId: request.nodeId } : {}),
    outcomeCode: 'outcome-unknown' as const,
    invalidatedPermitIds: [...request.invalidatedPermitIds].sort(),
    evidenceRefs: [...request.evidenceRefs].sort()
  }) as ExecutionAttemptRecord
  return finalize({
    ...withoutId(lineage),
    revision: lineage.revision + 1,
    historyHead: blockedAttempt.id,
    terminalState: 'blocked' as const,
    currentAttemptId: blockedAttempt.id,
    attempts: [...lineage.attempts, blockedAttempt]
  })
}

/** Plans a fresh immutable attempt while retaining the prior decision as lineage history. */
export function replanExecution(
  lineageValue: unknown,
  requestValue: unknown,
  parentDecisionValue: unknown,
  requirements: ExecutionRequirementSet,
  proposals: readonly unknown[],
  catalogue: ExecutionCandidateCatalogueSnapshot,
  policy: ExecutionPlanSelectionPolicy,
  parentProposalValue?: unknown,
  authority?: ExecutionReplanHostAuthority
): ExecutionReplanResult {
  assertExecutionLineage(lineageValue)
  assertExecutionReplanRequest(requestValue)
  assertExecutionPlanDecision(parentDecisionValue)
  const lineage = lineageValue
  const request = requestValue
  const parent = parentDecisionValue
  if (!authority || typeof authority.verifyLineage !== 'function' || typeof authority.verifyScopeRevision !== 'function')
    throw new ExecutionReplanContractError(['host authority must authenticate lineage and scope revision'])
  let lineageVerified = false
  try {
    lineageVerified = authority.verifyLineage(lineage, request) === true && authority.verifyScopeRevision(request, requirements) === true
  } catch {
    lineageVerified = false
  }
  if (!lineageVerified) throw new ExecutionReplanContractError(['host did not authenticate lineage and scope revision'])
  if (lineage.terminalState !== 'active') throw new ExecutionReplanContractError(['terminal lineage cannot be replanned'])
  if (request.parentAttemptId !== lineage.currentAttemptId || request.parentPlanDecisionId !== lineage.currentPlanDecisionId)
    throw new ExecutionReplanContractError(['replan parent does not match current lineage'])
  if (request.scopeRevision !== lineage.scopeRevision && request.trigger !== 'scope-changed') throw new ExecutionReplanContractError(['scope revision changed without a scope-changed trigger'])
  if (request.scopeRevision === lineage.scopeRevision && request.trigger === 'scope-changed') throw new ExecutionReplanContractError(['scope-changed requires a new scope revision'])
  if (request.trigger === 'scope-changed' && requirements.taskFingerprint === lineage.taskFingerprint) throw new ExecutionReplanContractError(['scope-changed requires a new task fingerprint'])
  if (request.trigger !== 'scope-changed' && (requirements.id !== lineage.requirementsId || requirements.taskFingerprint !== lineage.taskFingerprint))
    throw new ExecutionReplanContractError(['non-scope replans must preserve the frozen requirement set'])
  if (parent.id !== lineage.currentPlanDecisionId) throw new ExecutionReplanContractError(['parent decision does not match current lineage'])
  if (request.outcomeCode === 'outcome-unknown') throw new ExecutionReplanContractError(['ambiguous outcome blocks automatic replanning until reconciliation'])
  const proposal = selectedProposal(parent, parentProposalValue)
  if (request.nodeId !== undefined) {
    const node = proposal.nodes.find((entry) => entry.id === request.nodeId)
    if (!node) throw new ExecutionReplanContractError(['replan node does not belong to parent proposal'])
    if (request.outcomeCode !== undefined && !node.outcomes.some((outcome) => outcome.code === request.outcomeCode))
      throw new ExecutionReplanContractError(['replan outcome does not belong to parent node'])
  }
  const decision = selectMinimumCostExecutionPlan(proposals, requirements, catalogue, policy)
  if (lineage.attempts.length >= MAX_HISTORY) throw new ExecutionReplanContractError([`lineage cannot exceed ${MAX_HISTORY} attempts`])
  if (lineage.attempts.length >= lineage.maxAttempts || lineage.attempts.filter((attempt) => attempt.trigger !== 'initial').length >= lineage.maxReplans)
    throw new ExecutionReplanContractError(['lineage replan limit has been reached'])
  if (decision.status !== 'selected' || !decision.selected) throw new ExecutionReplanContractError(['replan produced no qualified plan'])
  const previous = lineage.attempts[lineage.attempts.length - 1]
  const attempt = finalize({
    schemaVersion: 1 as const,
    sequence: lineage.attempts.length,
    trigger: request.trigger,
    status: 'planned' as const,
    replanRequestId: request.id,
    decisionId: decision.id,
    planDecisionId: decision.id,
    proposalFingerprint: decision.selected.proposalFingerprint,
    requirementsId: decision.requirementsId,
    catalogueFingerprint: decision.catalogueFingerprint,
    policyFingerprint: decision.policyFingerprint,
    planningAt: decision.planningAt,
    scopeRevision: request.scopeRevision,
    parentAttemptId: previous.id,
    ...(request.nodeId ? { nodeId: request.nodeId } : {}),
    ...(request.outcomeCode ? { outcomeCode: request.outcomeCode } : {}),
    invalidatedPermitIds: [...request.invalidatedPermitIds].sort(),
    evidenceRefs: [...request.evidenceRefs].sort()
  }) as ExecutionAttemptRecord
  const nextLineage = finalize({
    ...withoutId(lineage),
    revision: lineage.revision + 1,
    historyHead: attempt.id,
    requirementsId: decision.requirementsId,
    taskFingerprint: requirements.taskFingerprint,
    scopeRevision: request.scopeRevision,
    currentAttemptId: attempt.id,
    currentPlanDecisionId: decision.id,
    attempts: [...lineage.attempts, attempt]
  })
  return { lineage: nextLineage, decision, request }
}

export const planExecutionReplan = replanExecution
