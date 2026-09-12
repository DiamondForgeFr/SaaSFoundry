import {
  CandidateExclusion,
  CandidateExclusionCode,
  ExecutionCandidate,
  ExecutionCandidateAdapter,
  ExecutionCandidateCatalogueSnapshot,
  ExecutionCandidateIdentity,
  ExecutionCandidateObservation,
  NormalizedEffort,
  PriceDimensionKind,
  PriceUnit,
  PrivacyBoundary,
  RuntimeKind,
  ToolBehaviorMode,
  TrainingUse
} from './types'

const SAFE_COMPONENT = /^[a-z0-9][a-z0-9._:-]*$/i
const SAFE_REFERENCE = /^[a-z0-9][a-z0-9._:/-]*$/i
const DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d+)?$/
const SECRET_KEYS = new Set([
  'apikey',
  'authorization',
  'bearer',
  'clientsecret',
  'cookie',
  'credential',
  'credentials',
  'password',
  'privatekey',
  'refreshtoken',
  'secret',
  'sessionid',
  'token',
  'accesstoken'
])
const SECRET_VALUES = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bBearer\s+[A-Za-z0-9._~+/-]{12,}={0,2}\b/i,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /\b(?:github_pat_|gh[pousr]_|sk-|xox[baprs]-)[A-Za-z0-9_-]{12,}\b/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/
]
const EFFORTS = new Set<NormalizedEffort>(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'custom'])
const RUNTIMES = new Set<RuntimeKind>(['cloud', 'local', 'hybrid'])
const PRIVACY = new Set<PrivacyBoundary>(['local-device', 'customer-controlled', 'provider-managed', 'unknown'])
const TRAINING = new Set<TrainingUse>(['none', 'opt-in', 'opt-out', 'unknown'])
const TOOL_MODES = new Set<ToolBehaviorMode>(['none', 'native', 'adapter-mediated'])
const PRICE_KINDS = new Set<PriceDimensionKind>(['input-token', 'output-token', 'cached-input-token', 'request', 'second', 'minute', 'tool-call'])
const PRICE_UNITS = new Set<PriceUnit>(['token', 'request', 'second', 'minute', 'call'])

export class CandidateValidationError extends Error {
  readonly issues: string[]

  constructor(issues: string[]) {
    super(`Invalid execution candidate: ${issues.join('; ')}`)
    this.name = 'CandidateValidationError'
    this.issues = [...issues]
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function date(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function secretKey(value: string): boolean {
  return SECRET_KEYS.has(value.replace(/[^a-z0-9]/gi, '').toLowerCase())
}

function containsCredential(value: string): boolean {
  try {
    const url = new URL(value)
    if (url.username || url.password || [...url.searchParams.keys()].some(secretKey)) return true
  } catch {
    // Most public metadata strings are not URLs.
  }
  return (
    SECRET_VALUES.some((pattern) => pattern.test(value)) ||
    /\b(?:api[_-]?key|authorization|bearer|client[_-]?secret|cookie|credentials?|password|private[_-]?key|refresh[_-]?token|secret|session[_-]?id|access[_-]?token|token)\s*[:=]\s*\S+/i.test(value)
  )
}

function publicText(value: unknown): value is string {
  return nonEmpty(value) && !containsCredential(value)
}

function id(value: unknown): value is string {
  return publicText(value) && SAFE_COMPONENT.test(value)
}

function reference(value: unknown): value is string {
  return publicText(value) && SAFE_REFERENCE.test(value)
}

function isObservation(value: unknown): value is ExecutionCandidateObservation {
  return isObject(value) && reference(value.sourceId) && Object.prototype.hasOwnProperty.call(value, 'value')
}

function positiveIntegerOrNull(value: unknown): boolean {
  return value === null || (Number.isInteger(value) && Number(value) > 0)
}

function nonNegativeIntegerOrNull(value: unknown): boolean {
  return value === null || (Number.isSafeInteger(value) && Number(value) >= 0)
}

function stringList(value: unknown, allowEmpty = true): value is string[] {
  return Array.isArray(value) && (allowEmpty || value.length > 0) && value.every(publicText) && new Set(value).size === value.length
}

function idList(value: unknown, allowEmpty = true): value is string[] {
  return stringList(value, allowEmpty) && value.every(id)
}

function validateNamedId(value: unknown, path: string, issues: string[]): void {
  if (!isObject(value) || !id(value.id)) issues.push(`${path}.id must be a safe non-empty identifier`)
  else if (value.displayName !== undefined && !publicText(value.displayName)) issues.push(`${path}.displayName must be public non-empty text when present`)
}

/** Runtime validation is required because adapters ingest provider-owned data. */
export function assertExecutionCandidate(value: unknown): asserts value is ExecutionCandidate {
  const issues: string[] = []
  if (!isObject(value)) throw new CandidateValidationError(['candidate must be an object'])
  if (!reference(value.id)) issues.push('id must be a safe non-empty identifier')
  validateNamedId(value.provider, 'provider', issues)
  validateNamedId(value.model, 'model', issues)
  validateNamedId(value.runtime, 'runtime', issues)
  if (isObject(value.runtime) && !RUNTIMES.has(value.runtime.kind as RuntimeKind)) issues.push('runtime.kind is unsupported')

  if (!isObject(value.effort)) issues.push('effort must be an object')
  else {
    if (!EFFORTS.has(value.effort.normalized as NormalizedEffort)) issues.push('effort.normalized is unsupported')
    if (!publicText(value.effort.sourceId)) issues.push('effort.sourceId must be public non-empty text')
    if (value.effort.sourceLabel !== undefined && !publicText(value.effort.sourceLabel)) issues.push('effort.sourceLabel must be public non-empty text when present')
  }

  if (!isObject(value.context)) issues.push('context must be an object')
  else {
    if (!positiveIntegerOrNull(value.context.windowTokens)) issues.push('context.windowTokens must be a positive integer or null')
    if (!positiveIntegerOrNull(value.context.maxOutputTokens)) issues.push('context.maxOutputTokens must be a positive integer or null')
  }
  if (!idList(value.capabilities, false)) issues.push('capabilities must contain unique safe identifiers')

  if (!isObject(value.availability)) issues.push('availability must be an object')
  else {
    if (!['available', 'unavailable'].includes(String(value.availability.state))) issues.push('availability.state is unsupported')
    if (!date(value.availability.checkedAt)) issues.push('availability.checkedAt must be a canonical UTC ISO timestamp')
    if (!date(value.availability.validUntil)) issues.push('availability.validUntil must be a canonical UTC ISO timestamp')
    if (date(value.availability.checkedAt) && date(value.availability.validUntil) && Date.parse(value.availability.validUntil) <= Date.parse(value.availability.checkedAt))
      issues.push('availability.validUntil must be later than checkedAt')
    if (value.availability.reason !== undefined) {
      if (!isObject(value.availability.reason) || !id(value.availability.reason.code)) issues.push('availability.reason.code must be a safe non-empty identifier')
      else if (value.availability.reason.detail !== undefined && !publicText(value.availability.reason.detail)) issues.push('availability.reason.detail must be public non-empty text when present')
    }
  }

  if (!isObject(value.pricing)) issues.push('pricing must be an object')
  else {
    if (!date(value.pricing.observedAt)) issues.push('pricing.observedAt must be a canonical UTC ISO timestamp')
    if (!date(value.pricing.validUntil)) issues.push('pricing.validUntil must be a canonical UTC ISO timestamp')
    if (date(value.pricing.observedAt) && date(value.pricing.validUntil) && Date.parse(value.pricing.validUntil) <= Date.parse(value.pricing.observedAt))
      issues.push('pricing.validUntil must be later than observedAt')
    if (!Array.isArray(value.pricing.dimensions)) issues.push('pricing.dimensions must be an array')
    else
      value.pricing.dimensions.forEach((dimension, index) => {
        const path = `pricing.dimensions[${index}]`
        if (!isObject(dimension)) {
          issues.push(`${path} must be an object`)
          return
        }
        if (!PRICE_KINDS.has(dimension.kind as PriceDimensionKind)) issues.push(`${path}.kind is unsupported`)
        if (!nonEmpty(dimension.amount) || !DECIMAL.test(dimension.amount)) issues.push(`${path}.amount must be a non-negative decimal string`)
        if (!nonEmpty(dimension.currency) || !/^[A-Z]{3}$/.test(dimension.currency)) issues.push(`${path}.currency must be a three-letter uppercase code`)
        if (!PRICE_UNITS.has(dimension.unit as PriceUnit)) issues.push(`${path}.unit is unsupported`)
        if (!Number.isInteger(dimension.per) || Number(dimension.per) <= 0) issues.push(`${path}.per must be a positive integer`)
        if (!publicText(dimension.sourceUnit)) issues.push(`${path}.sourceUnit must retain a public provider unit`)
      })
  }

  if (!isObject(value.privacy)) issues.push('privacy must be an object')
  else {
    if (!PRIVACY.has(value.privacy.boundary as PrivacyBoundary)) issues.push('privacy.boundary is unsupported')
    if (!TRAINING.has(value.privacy.trainingUse as TrainingUse)) issues.push('privacy.trainingUse is unsupported')
    if (value.privacy.dataResidency !== undefined && !stringList(value.privacy.dataResidency)) issues.push('privacy.dataResidency must contain unique public non-empty values')
    if (!nonNegativeIntegerOrNull(value.privacy.retentionDays)) issues.push('privacy.retentionDays must be a non-negative safe integer or null')
  }

  if (!isObject(value.tools)) issues.push('tools must be an object')
  else {
    if (!TOOL_MODES.has(value.tools.mode as ToolBehaviorMode)) issues.push('tools.mode is unsupported')
    if (!idList(value.tools.supported)) issues.push('tools.supported must contain unique safe identifiers')
    if (typeof value.tools.parallelCalls !== 'boolean') issues.push('tools.parallelCalls must be boolean')
    if (typeof value.tools.requiresApproval !== 'boolean') issues.push('tools.requiresApproval must be boolean')
  }

  if (!isObject(value.source)) issues.push('source must be an object')
  else {
    if (!id(value.source.adapterId)) issues.push('source.adapterId must be a safe non-empty identifier')
    if (!reference(value.source.candidateRef)) issues.push('source.candidateRef must be a safe non-empty identifier')
    if (!date(value.source.retrievedAt)) issues.push('source.retrievedAt must be a canonical UTC ISO timestamp')
  }
  if (isObject(value.provider) && id(value.provider.id) && isObject(value.runtime) && id(value.runtime.id) && isObject(value.model) && id(value.model.id) && isObject(value.effort)) {
    const normalized = value.effort.normalized as NormalizedEffort
    if (EFFORTS.has(normalized)) {
      const expectedId = createExecutionCandidateId(value.provider.id, value.runtime.id, value.model.id, normalized)
      if (value.id !== expectedId) issues.push(`id must equal canonical identity '${expectedId}'`)
    }
  }
  if (issues.length) throw new CandidateValidationError(issues)
}

export function createExecutionCandidateId(providerId: string, runtimeId: string, modelId: string, effort: NormalizedEffort): string {
  if (![providerId, runtimeId, modelId].every(id) || !EFFORTS.has(effort)) throw new Error('Canonical execution candidate identity requires safe provider, runtime, model, and effort identifiers.')
  return `${providerId}/${runtimeId}/${modelId}/${effort}`
}

function cloneCandidate(candidate: ExecutionCandidate): ExecutionCandidate {
  return {
    id: candidate.id,
    provider: { id: candidate.provider.id, ...(candidate.provider.displayName ? { displayName: candidate.provider.displayName } : {}) },
    runtime: { id: candidate.runtime.id, kind: candidate.runtime.kind, ...(candidate.runtime.displayName ? { displayName: candidate.runtime.displayName } : {}) },
    model: { id: candidate.model.id, ...(candidate.model.displayName ? { displayName: candidate.model.displayName } : {}) },
    effort: { normalized: candidate.effort.normalized, sourceId: candidate.effort.sourceId, ...(candidate.effort.sourceLabel ? { sourceLabel: candidate.effort.sourceLabel } : {}) },
    context: { windowTokens: candidate.context.windowTokens, maxOutputTokens: candidate.context.maxOutputTokens },
    capabilities: [...candidate.capabilities],
    availability: {
      state: candidate.availability.state,
      checkedAt: candidate.availability.checkedAt,
      validUntil: candidate.availability.validUntil,
      ...(candidate.availability.reason
        ? {
            reason: {
              code: candidate.availability.reason.code,
              ...(candidate.availability.reason.detail ? { detail: candidate.availability.reason.detail } : {})
            }
          }
        : {})
    },
    pricing: {
      observedAt: candidate.pricing.observedAt,
      validUntil: candidate.pricing.validUntil,
      dimensions: candidate.pricing.dimensions.map((dimension) => ({
        kind: dimension.kind,
        amount: dimension.amount,
        currency: dimension.currency,
        unit: dimension.unit,
        per: dimension.per,
        sourceUnit: dimension.sourceUnit
      }))
    },
    privacy: {
      boundary: candidate.privacy.boundary,
      ...(candidate.privacy.dataResidency ? { dataResidency: [...candidate.privacy.dataResidency] } : {}),
      trainingUse: candidate.privacy.trainingUse,
      retentionDays: candidate.privacy.retentionDays
    },
    tools: {
      mode: candidate.tools.mode,
      supported: [...candidate.tools.supported],
      parallelCalls: candidate.tools.parallelCalls,
      requiresApproval: candidate.tools.requiresApproval
    },
    source: { adapterId: candidate.source.adapterId, candidateRef: candidate.source.candidateRef, retrievedAt: candidate.source.retrievedAt }
  }
}

function exclusion(adapterId: string, sourceId: string, code: CandidateExclusionCode, observedAt: string, candidate?: Partial<ExecutionCandidateIdentity>, detailCode?: string): CandidateExclusion {
  return {
    status: 'excluded',
    identity: {
      adapterId,
      sourceId,
      ...(candidate?.id ? { candidateId: candidate.id } : {}),
      ...(candidate?.provider?.id ? { providerId: candidate.provider.id } : {}),
      ...(candidate?.runtime?.id ? { runtimeId: candidate.runtime.id } : {}),
      ...(candidate?.model?.id ? { modelId: candidate.model.id } : {})
    },
    exclusion: { code, observedAt, ...(detailCode ? { detailCode } : {}) }
  }
}

interface NormalizedRecord {
  adapterId: string
  sourceId: string
  candidate: ExecutionCandidate
}

export class ExecutionCandidateCatalogue {
  private readonly adapters = new Map<string, ExecutionCandidateAdapter>()
  private readonly clock: () => Date

  constructor(options: { clock?: () => Date } = {}) {
    this.clock = options.clock ?? (() => new Date())
  }

  register(adapter: ExecutionCandidateAdapter): this {
    if (!id(adapter.id)) throw new Error('Execution candidate adapter ID must be a safe non-empty identifier.')
    if (this.adapters.has(adapter.id)) throw new Error(`Execution candidate adapter '${adapter.id}' is already registered.`)
    this.adapters.set(adapter.id, adapter)
    return this
  }

  async snapshot(): Promise<ExecutionCandidateCatalogueSnapshot> {
    const now = this.clock()
    if (!Number.isFinite(now.getTime())) throw new Error('Execution candidate catalogue clock returned an invalid date.')
    const generatedAt = now.toISOString()
    const normalized: NormalizedRecord[] = []
    const excluded: CandidateExclusion[] = []

    for (const adapter of [...this.adapters.values()].sort((left, right) => left.id.localeCompare(right.id))) {
      let observations: readonly ExecutionCandidateObservation[]
      try {
        observations = await adapter.discover()
        if (!Array.isArray(observations)) throw new Error('discover() did not return an array')
      } catch {
        excluded.push(exclusion(adapter.id, adapter.id, 'adapter-unavailable', generatedAt))
        continue
      }

      for (const observation of observations) {
        const sourceId = isObservation(observation) ? observation.sourceId : 'invalid-source'
        try {
          if (!isObservation(observation)) throw new CandidateValidationError(['observation.sourceId must be a safe non-empty identifier'])
          const candidate = adapter.normalize(observation)
          assertExecutionCandidate(candidate)
          if (candidate.source.adapterId !== adapter.id) throw new CandidateValidationError(['source.adapterId must match the adapter that produced the candidate'])
          if (candidate.source.candidateRef !== observation.sourceId) throw new CandidateValidationError(['source.candidateRef must match observation.sourceId'])
          normalized.push({ adapterId: adapter.id, sourceId, candidate: cloneCandidate(candidate) })
        } catch (error) {
          const detailCode = error instanceof CandidateValidationError ? 'contract-validation' : 'adapter-normalization'
          excluded.push(exclusion(adapter.id, sourceId, 'invalid-candidate', generatedAt, undefined, detailCode))
        }
      }
    }

    const candidateCounts = new Map<string, number>()
    for (const record of normalized) candidateCounts.set(record.candidate.id, (candidateCounts.get(record.candidate.id) ?? 0) + 1)
    const duplicateIds = new Set([...candidateCounts.entries()].filter(([, count]) => count > 1).map(([candidateId]) => candidateId))
    const eligible: ExecutionCandidate[] = []
    for (const record of normalized) {
      const { adapterId, sourceId, candidate } = record
      if (duplicateIds.has(candidate.id)) {
        excluded.push(exclusion(adapterId, sourceId, 'duplicate-candidate', generatedAt, candidate))
      } else if (candidate.availability.state === 'unavailable') {
        excluded.push(exclusion(adapterId, sourceId, 'candidate-unavailable', generatedAt, candidate, candidate.availability.reason?.code))
      } else if (Date.parse(candidate.availability.validUntil) <= now.getTime() || Date.parse(candidate.pricing.validUntil) <= now.getTime()) {
        excluded.push(exclusion(adapterId, sourceId, 'catalogue-stale', generatedAt, candidate))
      } else {
        eligible.push(candidate)
      }
    }

    eligible.sort((left, right) => left.id.localeCompare(right.id))
    excluded.sort((left, right) => {
      const leftKey = `${left.identity.candidateId ?? ''}:${left.identity.adapterId}:${left.identity.sourceId}:${left.exclusion.code}`
      const rightKey = `${right.identity.candidateId ?? ''}:${right.identity.adapterId}:${right.identity.sourceId}:${right.exclusion.code}`
      return leftKey.localeCompare(rightKey)
    })
    return { version: 1, generatedAt, eligible, excluded }
  }
}
