import { ExactRational } from './exact-cost'
import { stableFingerprint } from './overrides'
import { assertExecutionPlanProposal, type BillableUsageP95, type ExecutionPlanProposal } from './plans'
import type { ExecutionObservedOutcome } from './replanning'
import type { NormalizedEffort, PriceDimensionKind, PrivacyBoundary, RuntimeKind } from './types'

const SAFE_ID = /^[a-z0-9][a-z0-9._:/-]{0,127}$/i
const SECRET_LIKE =
  /(?:\bBearer\s+|\b(?:sk|gh[pousr]|github_pat|xox[baprs])[_-]|\beyJ[a-zA-Z0-9_-]{8,}\.|(?:api[_-]?key|authorization|client[_-]?secret|cookie|credentials?|password|private[_-]?key|refresh[_-]?token|session[_-]?id|access[_-]?token|token)\s*[:=])/i
const FINGERPRINT = /^[a-f0-9]{64}$/
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d+)?$/
const DIMENSIONS: PriceDimensionKind[] = ['input-token', 'output-token', 'cached-input-token', 'request', 'second', 'minute', 'tool-call']
const DISCRETE_DIMENSIONS = new Set<PriceDimensionKind>(['input-token', 'output-token', 'cached-input-token', 'request', 'tool-call'])
const CHECKS = ['self-review', 'type-check', 'automated-tests', 'integration-tests', 'independent-review', 'security-tests'] as const
const OUTCOMES: ExecutionActualOutcomeCode[] = ['success', 'execution-failed', 'validation-failed', 'candidate-unavailable', 'outcome-unknown', 'cancelled']
const MAX_OUTCOMES = 1024
const MAX_EVIDENCE_REFS = 32
const MAX_DECIMAL_LENGTH = 128
const MAX_LATENCY_MS = 7 * 24 * 60 * 60 * 1000

export type ExecutionActualOutcomeCode = ExecutionObservedOutcome | 'cancelled'
export type ExecutionValidationResult = 'passed' | 'failed' | 'not-run' | 'unknown'
export type ExecutionFallbackReason = 'retry' | 'fallback' | 'replan'
export type ExecutionOutcomeSourceKind = 'provider-settlement' | 'runtime-meter' | 'host-dispatch'
export type ExecutionMeteringStatus = 'complete' | 'partial' | 'unknown'

export interface ExecutionCalibrationCohort {
  candidateId: string
  effort: NormalizedEffort
  runtimeKind: RuntimeKind
  workloadClass: string
  privacyBoundary: PrivacyBoundary
  /** Opaque isolation boundary. Restricted tenant evidence cannot enter a shared cohort. */
  tenantBoundaryId: string
}

export interface ExecutionDispatchBinding {
  runId: string
  lineageId: string
  lineageRevision: number
  historyHead: string
  attemptId: string
  dispatchPermitId: string
  planDecisionId: string
  proposalFingerprint: string
  nodeId: string
  candidateId: string
  retryOrdinal: number
  cohort: ExecutionCalibrationCohort
}

export interface ExecutionOutcomeEvidenceInput {
  schemaVersion: 1
  /** Unique opaque host/provider event key used for idempotency. */
  eventId: string
  binding: ExecutionDispatchBinding
  occurredAt: string
  receivedAt: string
  outcome: ExecutionActualOutcomeCode
  actualUsage: BillableUsageP95
  metering: ExecutionMeteringStatus
  latencyMs: number | null
  validation: { result: ExecutionValidationResult; checks: string[] }
  fallbackReason?: ExecutionFallbackReason
  sourceKind: ExecutionOutcomeSourceKind
  evidenceRefs: string[]
}

export interface ExecutionOutcomeEvidence extends ExecutionOutcomeEvidenceInput {
  id: string
}

export type ExecutionOutcomeAppendResult = { status: 'accepted' | 'replayed'; outcomeId: string } | { status: 'rejected' }

export interface ExecutionOutcomeHostAuthority {
  verifyOutcomeEvidence(evidence: Readonly<ExecutionOutcomeEvidenceInput>, expectedBinding: Readonly<ExecutionDispatchBinding>): boolean
  appendOutcome(evidence: Readonly<ExecutionOutcomeEvidence>): ExecutionOutcomeAppendResult
}

export interface ExecutionCalibrationPolicy {
  schemaVersion: 1
  estimatorVersion: string
  cutoffAt: string
  generatedAt: string
  validUntil: string
  minimumSamples: number
  maximumSamples: number
  /** Integer quantile in basis points; 9500 means nearest-rank p95. */
  quantileBps: number
  /** Required cap for each calibrated dimension, limiting one observation's influence. */
  usageCaps: BillableUsageP95
  latencyCapMs: number
  evidenceRef: string
}

export interface ExecutionCalibrationOutcomeRate {
  outcome: Exclude<ExecutionActualOutcomeCode, 'outcome-unknown' | 'cancelled'>
  numerator: string
  denominator: string
}

export interface ExecutionCalibrationSnapshot {
  schemaVersion: 1
  id: string
  cohort: ExecutionCalibrationCohort
  estimatorVersion: string
  cutoffAt: string
  generatedAt: string
  validUntil: string
  quantileBps: number
  sampleCount: number
  censoredCount: number
  sourceOutcomeIds: string[]
  sourceHistoryFingerprint: string
  usageP95: BillableUsageP95
  latencyP95Ms: number | null
  outcomeRates: ExecutionCalibrationOutcomeRate[]
  evidenceRef: string
}

export interface ExecutionCalibrationHostAuthority {
  verifyRecordedOutcome(evidence: Readonly<ExecutionOutcomeEvidence>): boolean
}

export class ExecutionCalibrationContractError extends Error {
  readonly issues: string[]

  constructor(issues: string[]) {
    super(`Invalid execution calibration contract: ${issues.join('; ')}`)
    this.name = 'ExecutionCalibrationContractError'
    this.issues = [...issues]
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function timestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !TIMESTAMP.test(value)) return false
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value
}

function safeId(value: unknown): value is string {
  return typeof value === 'string' && SAFE_ID.test(value) && !SECRET_LIKE.test(value)
}

function fingerprint(value: unknown): value is string {
  return typeof value === 'string' && FINGERPRINT.test(value)
}

function rejectUnknown(value: Record<string, unknown>, fields: readonly string[], label: string, issues: string[]): void {
  const unknown = Object.keys(value).filter((field) => !fields.includes(field))
  if (unknown.length) issues.push(`${label} contains unsupported fields: ${unknown.sort().join(', ')}`)
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const entry of Object.values(value as Record<string, unknown>)) freeze(entry)
    Object.freeze(value)
  }
  return value
}

function withoutId<T extends { id: string }>(value: T): Omit<T, 'id'> {
  const payload: Partial<T> = { ...value }
  delete payload.id
  return payload as Omit<T, 'id'>
}

function canonicalDecimal(value: unknown, discrete: boolean, label: string, issues: string[]): string | undefined {
  if (typeof value !== 'string' || value.length > MAX_DECIMAL_LENGTH || !DECIMAL.test(value) || (discrete && value.includes('.'))) {
    issues.push(`${label} must be a bounded non-negative${discrete ? ' integer' : ' decimal'} string`)
    return undefined
  }
  try {
    const rational = ExactRational.decimal(value)
    if (rational.denominator === 1n) return rational.numerator.toString()
    const [, fraction = ''] = value.split('.')
    const normalized = `${value.split('.')[0]}.${fraction.replace(/0+$/, '')}`
    return normalized.endsWith('.') ? normalized.slice(0, -1) : normalized
  } catch {
    issues.push(`${label} must be a bounded non-negative decimal string`)
    return undefined
  }
}

function normalizeUsage(value: unknown, label: string, issues: string[], allowEmpty: boolean): BillableUsageP95 {
  if (!object(value)) {
    issues.push(`${label} must be an object`)
    return {}
  }
  const unknown = Object.keys(value).filter((field) => !DIMENSIONS.includes(field as PriceDimensionKind))
  if (unknown.length) issues.push(`${label} contains unsupported dimensions`)
  const result: BillableUsageP95 = {}
  for (const kind of DIMENSIONS) {
    if (!Object.prototype.hasOwnProperty.call(value, kind)) continue
    const normalized = canonicalDecimal(value[kind], DISCRETE_DIMENSIONS.has(kind), `${label}.${kind}`, issues)
    if (normalized !== undefined) result[kind] = normalized
  }
  if (!allowEmpty && Object.keys(result).length === 0) issues.push(`${label} must contain at least one dimension`)
  return result
}

function normalizeStringList(value: unknown, allowed: readonly string[] | null, label: string, issues: string[]): string[] {
  if (!Array.isArray(value) || value.length > MAX_EVIDENCE_REFS || !value.every(safeId)) {
    issues.push(`${label} must contain bounded unique safe identifiers`)
    return []
  }
  const result = [...new Set(value)].sort()
  if (result.length !== value.length || (allowed && result.some((entry) => !allowed.includes(entry)))) issues.push(`${label} contains duplicate or unsupported identifiers`)
  return result
}

function normalizeCohort(value: unknown, label: string, issues: string[]): ExecutionCalibrationCohort {
  const fields = ['candidateId', 'effort', 'runtimeKind', 'workloadClass', 'privacyBoundary', 'tenantBoundaryId']
  if (!object(value)) {
    issues.push(`${label} must be an object`)
    return { candidateId: 'invalid', effort: 'custom', runtimeKind: 'cloud', workloadClass: 'invalid', privacyBoundary: 'unknown', tenantBoundaryId: 'invalid' }
  }
  rejectUnknown(value, fields, label, issues)
  if (![value.candidateId, value.workloadClass, value.tenantBoundaryId].every(safeId)) issues.push(`${label} identifiers must be safe and non-secret`)
  if (!['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'custom'].includes(String(value.effort))) issues.push(`${label}.effort is unsupported`)
  if (!['cloud', 'local', 'hybrid'].includes(String(value.runtimeKind))) issues.push(`${label}.runtimeKind is unsupported`)
  if (!['local-device', 'customer-controlled', 'provider-managed', 'unknown'].includes(String(value.privacyBoundary))) issues.push(`${label}.privacyBoundary is unsupported`)
  return {
    candidateId: safeId(value.candidateId) ? value.candidateId : 'invalid',
    effort: value.effort as NormalizedEffort,
    runtimeKind: value.runtimeKind as RuntimeKind,
    workloadClass: safeId(value.workloadClass) ? value.workloadClass : 'invalid',
    privacyBoundary: value.privacyBoundary as PrivacyBoundary,
    tenantBoundaryId: safeId(value.tenantBoundaryId) ? value.tenantBoundaryId : 'invalid'
  }
}

function normalizeBinding(value: unknown, label: string, issues: string[]): ExecutionDispatchBinding {
  const fields = ['runId', 'lineageId', 'lineageRevision', 'historyHead', 'attemptId', 'dispatchPermitId', 'planDecisionId', 'proposalFingerprint', 'nodeId', 'candidateId', 'retryOrdinal', 'cohort']
  if (!object(value)) {
    issues.push(`${label} must be an object`)
    value = {}
  }
  const record = value as Record<string, unknown>
  rejectUnknown(record, fields, label, issues)
  if (!safeId(record.runId) || !safeId(record.dispatchPermitId) || !safeId(record.nodeId) || !safeId(record.candidateId)) issues.push(`${label} contains unsafe public identifiers`)
  for (const field of ['lineageId', 'historyHead', 'attemptId', 'planDecisionId', 'proposalFingerprint'])
    if (!fingerprint(record[field])) issues.push(`${label}.${field} must be a SHA-256 fingerprint`)
  if (!Number.isSafeInteger(record.lineageRevision) || Number(record.lineageRevision) < 1) issues.push(`${label}.lineageRevision must be a positive safe integer`)
  if (!Number.isSafeInteger(record.retryOrdinal) || Number(record.retryOrdinal) < 0 || Number(record.retryOrdinal) > 31) issues.push(`${label}.retryOrdinal must be a safe integer from 0 to 31`)
  const cohort = normalizeCohort(record.cohort, `${label}.cohort`, issues)
  if (safeId(record.candidateId) && cohort.candidateId !== record.candidateId) issues.push(`${label}.cohort candidate must match the dispatched candidate`)
  return {
    runId: safeId(record.runId) ? record.runId : 'invalid',
    lineageId: fingerprint(record.lineageId) ? record.lineageId : '0'.repeat(64),
    lineageRevision: Number(record.lineageRevision),
    historyHead: fingerprint(record.historyHead) ? record.historyHead : '0'.repeat(64),
    attemptId: fingerprint(record.attemptId) ? record.attemptId : '0'.repeat(64),
    dispatchPermitId: safeId(record.dispatchPermitId) ? record.dispatchPermitId : 'invalid',
    planDecisionId: fingerprint(record.planDecisionId) ? record.planDecisionId : '0'.repeat(64),
    proposalFingerprint: fingerprint(record.proposalFingerprint) ? record.proposalFingerprint : '0'.repeat(64),
    nodeId: safeId(record.nodeId) ? record.nodeId : 'invalid',
    candidateId: safeId(record.candidateId) ? record.candidateId : 'invalid',
    retryOrdinal: Number(record.retryOrdinal),
    cohort
  }
}

function normalizeOutcomeInput(value: unknown): ExecutionOutcomeEvidenceInput {
  const issues: string[] = []
  const fields = ['schemaVersion', 'eventId', 'binding', 'occurredAt', 'receivedAt', 'outcome', 'actualUsage', 'metering', 'latencyMs', 'validation', 'fallbackReason', 'sourceKind', 'evidenceRefs']
  if (!object(value)) throw new ExecutionCalibrationContractError(['outcome evidence must be an object'])
  rejectUnknown(value, fields, 'outcome evidence', issues)
  if (value.schemaVersion !== 1) issues.push('outcome evidence.schemaVersion must equal 1')
  if (!safeId(value.eventId)) issues.push('outcome evidence.eventId must be an opaque safe identifier')
  const binding = normalizeBinding(value.binding, 'outcome evidence.binding', issues)
  if (!timestamp(value.occurredAt) || !timestamp(value.receivedAt)) issues.push('outcome timestamps must be canonical UTC timestamps')
  else if (value.receivedAt < value.occurredAt) issues.push('outcome receivedAt must not precede occurredAt')
  if (!OUTCOMES.includes(value.outcome as ExecutionActualOutcomeCode)) issues.push('outcome evidence.outcome is unsupported')
  if (!['complete', 'partial', 'unknown'].includes(String(value.metering))) issues.push('outcome evidence.metering is unsupported')
  const actualUsage = normalizeUsage(value.actualUsage, 'outcome evidence.actualUsage', issues, value.metering !== 'complete')
  if (value.latencyMs !== null && (!Number.isSafeInteger(value.latencyMs) || Number(value.latencyMs) < 0 || Number(value.latencyMs) > MAX_LATENCY_MS))
    issues.push('outcome evidence.latencyMs must be null or a bounded non-negative integer')
  let validation: ExecutionOutcomeEvidenceInput['validation'] = { result: 'unknown', checks: [] }
  if (!object(value.validation)) issues.push('outcome evidence.validation must be an object')
  else {
    rejectUnknown(value.validation, ['result', 'checks'], 'outcome evidence.validation', issues)
    if (!['passed', 'failed', 'not-run', 'unknown'].includes(String(value.validation.result))) issues.push('outcome evidence.validation.result is unsupported')
    validation = { result: value.validation.result as ExecutionValidationResult, checks: normalizeStringList(value.validation.checks, CHECKS, 'outcome evidence.validation.checks', issues) }
  }
  if (value.fallbackReason !== undefined && !['retry', 'fallback', 'replan'].includes(String(value.fallbackReason))) issues.push('outcome evidence.fallbackReason is unsupported')
  if (!['provider-settlement', 'runtime-meter', 'host-dispatch'].includes(String(value.sourceKind))) issues.push('outcome evidence.sourceKind is unsupported')
  const evidenceRefs = normalizeStringList(value.evidenceRefs, null, 'outcome evidence.evidenceRefs', issues)
  if (evidenceRefs.length === 0) issues.push('outcome evidence requires at least one opaque evidence reference')
  if (issues.length) throw new ExecutionCalibrationContractError(issues)
  return {
    schemaVersion: 1,
    eventId: value.eventId as string,
    binding,
    occurredAt: value.occurredAt as string,
    receivedAt: value.receivedAt as string,
    outcome: value.outcome as ExecutionActualOutcomeCode,
    actualUsage,
    metering: value.metering as ExecutionMeteringStatus,
    latencyMs: value.latencyMs as number | null,
    validation,
    ...(value.fallbackReason ? { fallbackReason: value.fallbackReason as ExecutionFallbackReason } : {}),
    sourceKind: value.sourceKind as ExecutionOutcomeSourceKind,
    evidenceRefs
  }
}

/** Authenticates and atomically records one normalized dispatch outcome. */
export function recordExecutionOutcome(value: unknown, expectedBindingValue: unknown, host: ExecutionOutcomeHostAuthority): ExecutionOutcomeEvidence {
  const evidence = normalizeOutcomeInput(value)
  const expectedIssues: string[] = []
  const expectedBinding = normalizeBinding(expectedBindingValue, 'expected binding', expectedIssues)
  if (expectedIssues.length) throw new ExecutionCalibrationContractError(expectedIssues)
  if (stableFingerprint(evidence.binding) !== stableFingerprint(expectedBinding)) throw new ExecutionCalibrationContractError(['outcome evidence does not match the expected dispatch binding'])
  if (!host || typeof host.verifyOutcomeEvidence !== 'function' || typeof host.appendOutcome !== 'function')
    throw new ExecutionCalibrationContractError(['host authority must authenticate and append outcome evidence'])
  let verified = false
  try {
    verified = host.verifyOutcomeEvidence(evidence, expectedBinding) === true
  } catch {
    verified = false
  }
  if (!verified) throw new ExecutionCalibrationContractError(['host did not authenticate outcome evidence'])
  const record = freeze({ ...evidence, id: stableFingerprint(evidence) })
  let result: ExecutionOutcomeAppendResult
  try {
    result = host.appendOutcome(record)
  } catch {
    result = { status: 'rejected' }
  }
  if (result.status === 'rejected' || result.outcomeId !== record.id) throw new ExecutionCalibrationContractError(['host rejected or mismatched the atomic outcome append'])
  return record
}

export function assertExecutionOutcomeEvidence(value: unknown): asserts value is ExecutionOutcomeEvidence {
  if (!object(value)) throw new ExecutionCalibrationContractError(['outcome evidence record must be an object'])
  const issues: string[] = []
  rejectUnknown(
    value,
    ['id', 'schemaVersion', 'eventId', 'binding', 'occurredAt', 'receivedAt', 'outcome', 'actualUsage', 'metering', 'latencyMs', 'validation', 'fallbackReason', 'sourceKind', 'evidenceRefs'],
    'outcome evidence record',
    issues
  )
  if (issues.length) throw new ExecutionCalibrationContractError(issues)
  const payload = { ...value }
  delete payload.id
  const evidence = normalizeOutcomeInput(payload)
  if (!fingerprint(value.id) || stableFingerprint(evidence) !== value.id) throw new ExecutionCalibrationContractError(['outcome evidence record ID does not match its canonical payload'])
}

function normalizePolicy(value: unknown): ExecutionCalibrationPolicy {
  const issues: string[] = []
  const fields = ['schemaVersion', 'estimatorVersion', 'cutoffAt', 'generatedAt', 'validUntil', 'minimumSamples', 'maximumSamples', 'quantileBps', 'usageCaps', 'latencyCapMs', 'evidenceRef']
  if (!object(value)) throw new ExecutionCalibrationContractError(['calibration policy must be an object'])
  rejectUnknown(value, fields, 'calibration policy', issues)
  if (value.schemaVersion !== 1) issues.push('calibration policy.schemaVersion must equal 1')
  if (!safeId(value.estimatorVersion) || !safeId(value.evidenceRef)) issues.push('calibration policy identifiers must be safe and non-secret')
  if (![value.cutoffAt, value.generatedAt, value.validUntil].every(timestamp)) issues.push('calibration policy timestamps must be canonical UTC timestamps')
  else if (!((value.cutoffAt as string) <= (value.generatedAt as string) && (value.generatedAt as string) < (value.validUntil as string)))
    issues.push('calibration policy requires cutoffAt <= generatedAt < validUntil')
  if (!Number.isSafeInteger(value.minimumSamples) || Number(value.minimumSamples) < 2 || Number(value.minimumSamples) > MAX_OUTCOMES) issues.push('minimumSamples must be between 2 and 1024')
  if (!Number.isSafeInteger(value.maximumSamples) || Number(value.maximumSamples) < Number(value.minimumSamples) || Number(value.maximumSamples) > MAX_OUTCOMES)
    issues.push('maximumSamples must be between minimumSamples and 1024')
  if (!Number.isSafeInteger(value.quantileBps) || Number(value.quantileBps) < 5000 || Number(value.quantileBps) > 10000) issues.push('quantileBps must be a safe integer from 5000 to 10000')
  const usageCaps = normalizeUsage(value.usageCaps, 'calibration policy.usageCaps', issues, false)
  if (!Number.isSafeInteger(value.latencyCapMs) || Number(value.latencyCapMs) < 1 || Number(value.latencyCapMs) > MAX_LATENCY_MS) issues.push('latencyCapMs must be a positive bounded integer')
  if (issues.length) throw new ExecutionCalibrationContractError(issues)
  return {
    schemaVersion: 1,
    estimatorVersion: value.estimatorVersion as string,
    cutoffAt: value.cutoffAt as string,
    generatedAt: value.generatedAt as string,
    validUntil: value.validUntil as string,
    minimumSamples: Number(value.minimumSamples),
    maximumSamples: Number(value.maximumSamples),
    quantileBps: Number(value.quantileBps),
    usageCaps,
    latencyCapMs: Number(value.latencyCapMs),
    evidenceRef: value.evidenceRef as string
  }
}

function sameCohort(left: ExecutionCalibrationCohort, right: ExecutionCalibrationCohort): boolean {
  return stableFingerprint(left) === stableFingerprint(right)
}

function quantileDecimal(values: string[], quantileBps: number): string {
  const sorted = [...values].sort((left, right) => ExactRational.decimal(left).compare(ExactRational.decimal(right)))
  return sorted[Math.max(0, Math.ceil((quantileBps * sorted.length) / 10_000) - 1)]
}

function gcd(left: bigint, right: bigint): bigint {
  let a = left
  let b = right
  while (b !== 0n) [a, b] = [b, a % b]
  return a || 1n
}

/** Builds a deterministic, expiring snapshot that can influence only future estimate evidence. */
export function deriveExecutionCalibrationSnapshot(
  outcomesValue: readonly unknown[],
  cohortValue: unknown,
  policyValue: unknown,
  host: ExecutionCalibrationHostAuthority
): ExecutionCalibrationSnapshot {
  if (!Array.isArray(outcomesValue) || outcomesValue.length > MAX_OUTCOMES) throw new ExecutionCalibrationContractError([`calibration accepts at most ${MAX_OUTCOMES} outcomes`])
  const cohortIssues: string[] = []
  const cohort = normalizeCohort(cohortValue, 'calibration cohort', cohortIssues)
  if (cohortIssues.length) throw new ExecutionCalibrationContractError(cohortIssues)
  const policy = normalizePolicy(policyValue)
  if (!host || typeof host.verifyRecordedOutcome !== 'function') throw new ExecutionCalibrationContractError(['calibration host must authenticate every recorded outcome'])
  const records = outcomesValue.map((value) => {
    assertExecutionOutcomeEvidence(value)
    let verified = false
    try {
      verified = host.verifyRecordedOutcome(value) === true
    } catch {
      verified = false
    }
    if (!verified) throw new ExecutionCalibrationContractError(['calibration host did not authenticate a recorded outcome'])
    return value
  })
  const seenEvents = new Set<string>()
  for (const record of records) {
    if (seenEvents.has(record.eventId)) throw new ExecutionCalibrationContractError(['calibration outcomes contain a duplicate event ID'])
    seenEvents.add(record.eventId)
  }
  const matching = records
    .filter((record) => sameCohort(record.binding.cohort, cohort) && record.receivedAt <= policy.cutoffAt)
    .sort((left, right) => `${left.receivedAt}/${left.id}`.localeCompare(`${right.receivedAt}/${right.id}`))
    .slice(-policy.maximumSamples)
  const censored = matching.filter((record) => record.metering !== 'complete' || record.outcome === 'outcome-unknown' || record.outcome === 'cancelled')
  const eligible = matching.filter((record) => !censored.includes(record))
  if (eligible.length < policy.minimumSamples) throw new ExecutionCalibrationContractError(['calibration cohort has insufficient eligible samples'])
  const dimensions = Object.keys(eligible[0].actualUsage).sort() as PriceDimensionKind[]
  if (dimensions.length === 0 || eligible.some((record) => Object.keys(record.actualUsage).sort().join('/') !== dimensions.join('/')))
    throw new ExecutionCalibrationContractError(['eligible outcome usage dimensions must be complete and identical'])
  for (const dimension of dimensions) if (policy.usageCaps[dimension] === undefined) throw new ExecutionCalibrationContractError(['calibration policy must cap every observed usage dimension'])
  const usageP95: BillableUsageP95 = {}
  for (const dimension of dimensions) {
    const cap = policy.usageCaps[dimension]!
    const values = eligible.map((record) => {
      const observed = record.actualUsage[dimension]!
      return ExactRational.decimal(observed).compare(ExactRational.decimal(cap)) > 0 ? cap : observed
    })
    usageP95[dimension] = quantileDecimal(values, policy.quantileBps)
  }
  const latencyValues = eligible.filter((record) => record.latencyMs !== null).map((record) => Math.min(record.latencyMs!, policy.latencyCapMs))
  const latencyP95Ms =
    latencyValues.length === eligible.length ? latencyValues.sort((left, right) => left - right)[Math.max(0, Math.ceil((policy.quantileBps * latencyValues.length) / 10_000) - 1)] : null
  const outcomeRates: ExecutionCalibrationOutcomeRate[] = (['success', 'execution-failed', 'validation-failed', 'candidate-unavailable'] as const)
    .map((outcome) => {
      const count = BigInt(eligible.filter((record) => record.outcome === outcome).length)
      const divisor = gcd(count, BigInt(eligible.length))
      return { outcome, numerator: (count / divisor).toString(), denominator: (BigInt(eligible.length) / divisor).toString() }
    })
    .filter((rate) => rate.numerator !== '0')
  const sourceOutcomeIds = matching.map((record) => record.id).sort()
  const sourceHistoryFingerprint = stableFingerprint(sourceOutcomeIds)
  const payload: Omit<ExecutionCalibrationSnapshot, 'id'> = {
    schemaVersion: 1,
    cohort,
    estimatorVersion: policy.estimatorVersion,
    cutoffAt: policy.cutoffAt,
    generatedAt: policy.generatedAt,
    validUntil: policy.validUntil,
    quantileBps: policy.quantileBps,
    sampleCount: eligible.length,
    censoredCount: censored.length,
    sourceOutcomeIds,
    sourceHistoryFingerprint,
    usageP95,
    latencyP95Ms,
    outcomeRates,
    evidenceRef: policy.evidenceRef
  }
  return freeze({ ...payload, id: stableFingerprint(payload) })
}

export function assertExecutionCalibrationSnapshot(value: unknown): asserts value is ExecutionCalibrationSnapshot {
  if (!object(value)) throw new ExecutionCalibrationContractError(['calibration snapshot must be an object'])
  const fields = [
    'schemaVersion',
    'id',
    'cohort',
    'estimatorVersion',
    'cutoffAt',
    'generatedAt',
    'validUntil',
    'quantileBps',
    'sampleCount',
    'censoredCount',
    'sourceOutcomeIds',
    'sourceHistoryFingerprint',
    'usageP95',
    'latencyP95Ms',
    'outcomeRates',
    'evidenceRef'
  ]
  const issues: string[] = []
  rejectUnknown(value, fields, 'calibration snapshot', issues)
  if (value.schemaVersion !== 1 || !fingerprint(value.id)) issues.push('calibration snapshot version or ID is invalid')
  normalizeCohort(value.cohort, 'calibration snapshot.cohort', issues)
  if (!safeId(value.estimatorVersion) || !safeId(value.evidenceRef)) issues.push('calibration snapshot identifiers must be safe and non-secret')
  if (![value.cutoffAt, value.generatedAt, value.validUntil].every(timestamp)) issues.push('calibration snapshot timestamps must be canonical UTC timestamps')
  else if (!(String(value.cutoffAt) <= String(value.generatedAt) && String(value.generatedAt) < String(value.validUntil)))
    issues.push('calibration snapshot requires cutoffAt <= generatedAt < validUntil')
  if (!Number.isSafeInteger(value.quantileBps) || Number(value.quantileBps) < 5000 || Number(value.quantileBps) > 10000) issues.push('calibration snapshot quantile is invalid')
  if (!Number.isSafeInteger(value.sampleCount) || Number(value.sampleCount) < 2 || Number(value.sampleCount) > MAX_OUTCOMES) issues.push('calibration snapshot sample count is invalid')
  if (!Number.isSafeInteger(value.censoredCount) || Number(value.censoredCount) < 0 || Number(value.censoredCount) > MAX_OUTCOMES) issues.push('calibration snapshot censored count is invalid')
  const usage = normalizeUsage(value.usageP95, 'calibration snapshot.usageP95', issues, false)
  if (value.latencyP95Ms !== null && (!Number.isSafeInteger(value.latencyP95Ms) || Number(value.latencyP95Ms) < 0 || Number(value.latencyP95Ms) > MAX_LATENCY_MS))
    issues.push('calibration snapshot latency must be null or a bounded non-negative integer')
  const sourceOutcomeIds = Array.isArray(value.sourceOutcomeIds) ? value.sourceOutcomeIds : null
  if (!sourceOutcomeIds || !sourceOutcomeIds.every(fingerprint) || new Set(sourceOutcomeIds).size !== sourceOutcomeIds.length)
    issues.push('calibration snapshot source outcome IDs must be unique fingerprints')
  else {
    const sorted = [...sourceOutcomeIds].sort()
    if (sorted.some((entry, index) => entry !== sourceOutcomeIds[index])) issues.push('calibration snapshot source outcome IDs must be canonical')
    if (Number(value.sampleCount) + Number(value.censoredCount) !== sourceOutcomeIds.length) issues.push('calibration snapshot source counts do not match the outcome IDs')
    if (!fingerprint(value.sourceHistoryFingerprint) || stableFingerprint(sourceOutcomeIds) !== value.sourceHistoryFingerprint)
      issues.push('calibration snapshot source history fingerprint is invalid')
  }
  if (!Array.isArray(value.outcomeRates) || value.outcomeRates.length === 0 || value.outcomeRates.length > 4) issues.push('calibration snapshot outcome rates are invalid')
  else {
    const rates = value.outcomeRates as unknown[]
    const names = new Set<string>()
    let total = new ExactRational(0n)
    for (const rate of rates) {
      if (!object(rate) || Object.keys(rate).some((field) => !['outcome', 'numerator', 'denominator'].includes(field))) {
        issues.push('calibration snapshot outcome rate contains unsupported fields')
        continue
      }
      if (!['success', 'execution-failed', 'validation-failed', 'candidate-unavailable'].includes(String(rate.outcome)) || names.has(String(rate.outcome)))
        issues.push('calibration snapshot outcome rate is duplicate or unsupported')
      names.add(String(rate.outcome))
      try {
        const rational = ExactRational.evidence({ numerator: rate.numerator as string, denominator: rate.denominator as string })
        if (rational.numerator <= 0n || rational.compare(new ExactRational(1n)) > 0) issues.push('calibration snapshot outcome rate must be in (0, 1]')
        total = total.add(rational)
      } catch {
        issues.push('calibration snapshot outcome rate must be a reduced exact rational')
      }
    }
    if (total.compare(new ExactRational(1n)) !== 0) issues.push('calibration snapshot outcome rates must sum to one')
  }
  if (Object.keys(usage).length === 0) issues.push('cal snapshot must include calibrated usage')
  if (fingerprint(value.id) && stableFingerprint(withoutId(value as unknown as ExecutionCalibrationSnapshot)) !== value.id) issues.push('calibration snapshot ID does not match its canonical payload')
  if (issues.length) throw new ExecutionCalibrationContractError(issues)
}

/** Applies calibrated usage and latency evidence to a new proposal, leaving the source proposal untouched. */
export function applyExecutionCalibrationToPlanEstimate(proposalValue: unknown, nodeId: string, snapshotValue: unknown): ExecutionPlanProposal {
  assertExecutionPlanProposal(proposalValue)
  assertExecutionCalibrationSnapshot(snapshotValue)
  const proposal = proposalValue
  const snapshot = snapshotValue
  const node = proposal.nodes.find((entry) => entry.id === nodeId)
  if (!node) throw new ExecutionCalibrationContractError(['calibration target node does not exist'])
  if (node.candidateId !== snapshot.cohort.candidateId) throw new ExecutionCalibrationContractError(['calibration cohort candidate does not match the target node'])
  const calibrated: ExecutionPlanProposal = {
    ...proposal,
    nodes: proposal.nodes.map((entry) =>
      entry.id === nodeId
        ? {
            ...entry,
            estimate: {
              ...entry.estimate,
              usageP95: { ...snapshot.usageP95 },
              latencyP95Ms: snapshot.latencyP95Ms,
              observedAt: snapshot.generatedAt,
              validUntil: snapshot.validUntil,
              evidenceRef: snapshot.evidenceRef
            },
            outcomes: entry.outcomes.map((outcome) => ({ ...outcome }))
          }
        : {
            ...entry,
            estimate: { ...entry.estimate, usageP95: { ...entry.estimate.usageP95 } },
            tools: [...entry.tools],
            checks: [...entry.checks],
            outcomes: entry.outcomes.map((outcome) => ({ ...outcome }))
          }
    )
  }
  assertExecutionPlanProposal(calibrated)
  return freeze(calibrated)
}
