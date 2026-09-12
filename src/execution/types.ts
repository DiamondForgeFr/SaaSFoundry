export type NormalizedEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra' | 'custom'
export type RuntimeKind = 'cloud' | 'local' | 'hybrid'
export type PrivacyBoundary = 'local-device' | 'customer-controlled' | 'provider-managed' | 'unknown'
export type TrainingUse = 'none' | 'opt-in' | 'opt-out' | 'unknown'
export type ToolBehaviorMode = 'none' | 'native' | 'adapter-mediated'
export type PriceDimensionKind = 'input-token' | 'output-token' | 'cached-input-token' | 'request' | 'second' | 'minute' | 'tool-call'
export type PriceUnit = 'token' | 'request' | 'second' | 'minute' | 'call'

export interface ExecutionCandidateIdentity {
  /** Canonical `provider/runtime/model/effort` identity, validated by the catalogue. */
  id: string
  provider: { id: string; displayName?: string }
  runtime: { id: string; kind: RuntimeKind; displayName?: string }
  model: { id: string; displayName?: string }
}

export interface ExecutionCandidate extends ExecutionCandidateIdentity {
  effort: {
    normalized: NormalizedEffort
    /** Provider/runtime value used to produce `normalized`. */
    sourceId: string
    sourceLabel?: string
  }
  context: {
    /** `null` means the adapter cannot establish the limit. */
    windowTokens: number | null
    /** `null` means the adapter cannot establish the limit. */
    maxOutputTokens: number | null
  }
  /** Provider-neutral capability identifiers such as `text`, `vision`, or `tool-use`. */
  capabilities: string[]
  availability: {
    state: 'available' | 'unavailable'
    checkedAt: string
    validUntil: string
    reason?: { code: string; detail?: string }
  }
  pricing: {
    observedAt: string
    validUntil: string
    dimensions: Array<{
      kind: PriceDimensionKind
      /** Non-negative decimal string; money is never represented with a float. */
      amount: string
      currency: string
      unit: PriceUnit
      per: number
      /** Original provider unit, retained alongside the normalized unit. */
      sourceUnit: string
    }>
  }
  privacy: {
    boundary: PrivacyBoundary
    dataResidency?: string[]
    trainingUse: TrainingUse
    /** Normalized retention duration; `null` means the adapter cannot establish it. */
    retentionDays: number | null
  }
  tools: {
    mode: ToolBehaviorMode
    supported: string[]
    parallelCalls: boolean
    requiresApproval: boolean
  }
  source: {
    adapterId: string
    /** Stable reference used by the adapter for this provider/runtime record. */
    candidateRef: string
    retrievedAt: string
  }
}

export interface ExecutionCandidateObservation {
  /** Stable, non-secret provider/runtime reference used when normalization fails. */
  sourceId: string
  value: unknown
}

/**
 * Provider-specific discovery and normalization stay behind this interface.
 * Adapters must map only the explicitly declared public fields above. Raw provider
 * responses, configuration objects, credentials, and opaque metadata bags must
 * remain behind the adapter boundary.
 */
export interface ExecutionCandidateAdapter {
  readonly id: string
  discover(): Promise<readonly ExecutionCandidateObservation[]> | readonly ExecutionCandidateObservation[]
  normalize(observation: ExecutionCandidateObservation): ExecutionCandidate
}

export type CandidateExclusionCode = 'adapter-unavailable' | 'invalid-candidate' | 'duplicate-candidate' | 'candidate-unavailable' | 'catalogue-stale'

export interface CandidateExclusion {
  status: 'excluded'
  identity: {
    adapterId: string
    sourceId: string
    candidateId?: string
    providerId?: string
    runtimeId?: string
    modelId?: string
  }
  exclusion: {
    code: CandidateExclusionCode
    observedAt: string
    detailCode?: string
  }
}

export interface ExecutionCandidateCatalogueSnapshot {
  version: 1
  generatedAt: string
  eligible: ExecutionCandidate[]
  excluded: CandidateExclusion[]
}
