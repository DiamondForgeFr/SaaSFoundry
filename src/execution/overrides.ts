import { createHash } from 'crypto'

import type {
  ExecutionCapability,
  ExecutionRequirementOverride,
  ExecutionRequirementPatch,
  ExecutionRequirementSet,
  RequirementDecision,
  RequirementDecisionReason,
  RequirementEffort,
  ValidationRigor
} from './requirements'

const SAFE_ID = /^[a-z0-9][a-z0-9._:/-]*$/i
const EFFORT_ORDER: RequirementEffort[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']
const VALIDATION_ORDER: ValidationRigor[] = ['self-check', 'automated-checks', 'independent-review', 'independent-review-and-tests']
const PATCH_FIELDS: Array<keyof ExecutionRequirementPatch> = [
  'minimumEffort',
  'requiredCapabilities',
  'validationMinimum',
  'requiredChecks',
  'maximumPlanP95Ms',
  'minimumWindowTokens',
  'minimumOutputTokens',
  'contextMode',
  'allowedPrivacyBoundaries',
  'allowedTrainingUse',
  'maxRetentionDays',
  'requiredTools',
  'forbiddenTools',
  'requireApproval'
]

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)])
    )
  }
  return value
}

export function stableFingerprint(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(value)))
    .digest('hex')
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const entry of Object.values(value as Record<string, unknown>)) freeze(entry)
    Object.freeze(value)
  }
  return value
}

export function finalizeExecutionRequirementSet(value: ExecutionRequirementSet): ExecutionRequirementSet {
  const payload = { ...value }
  delete (payload as Partial<ExecutionRequirementSet>).id
  return freeze({ ...value, id: stableFingerprint(payload) })
}

function clone(value: ExecutionRequirementSet): ExecutionRequirementSet {
  return JSON.parse(JSON.stringify(value)) as ExecutionRequirementSet
}

function sortedUnique<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right))
}

function decision(override: ExecutionRequirementOverride, field: keyof ExecutionRequirementPatch, status: RequirementDecision['status'], reason: RequirementDecisionReason): RequirementDecision {
  return { overrideId: override.id, source: override.source, reference: override.reference, field, status, reason }
}

function validateOverride(override: ExecutionRequirementOverride): void {
  if (!SAFE_ID.test(override.id)) throw new Error('Execution requirement override ID must be a safe non-empty identifier.')
  if (!SAFE_ID.test(override.reference)) throw new Error(`Execution requirement override '${override.id}' reference must be a safe non-empty identifier.`)
  if (!['workflow', 'user'].includes(override.source)) throw new Error(`Execution requirement override '${override.id}' has an unsupported source.`)
  if (!['this-task', 'future-replans'].includes(override.appliesTo)) throw new Error(`Execution requirement override '${override.id}' has unsupported replanning scope.`)
  const unknown = Object.keys(override.changes).filter((field) => !PATCH_FIELDS.includes(field as keyof ExecutionRequirementPatch))
  if (unknown.length) throw new Error(`Execution requirement override '${override.id}' contains unsupported fields: ${unknown.sort().join(', ')}.`)
}

function mergeRanked<T extends string>(current: T, requested: T, order: readonly T[]): { value: T; status: RequirementDecision['status']; reason: RequirementDecisionReason } {
  const currentRank = order.indexOf(current)
  const requestedRank = order.indexOf(requested)
  if (requestedRank < 0) throw new Error(`Unsupported ordered requirement value '${requested}'.`)
  if (requestedRank < currentRank) return { value: current, status: 'rejected', reason: 'would-weaken-required-floor' }
  if (requestedRank === currentRank) return { value: current, status: 'applied', reason: 'already-satisfied' }
  return { value: requested, status: 'applied', reason: 'constraint-applied' }
}

function mergeMinimum(current: number, requested: number): { value: number; status: RequirementDecision['status']; reason: RequirementDecisionReason } {
  if (!Number.isSafeInteger(requested) || requested <= 0) throw new Error('Execution requirement numeric minima must be positive safe integers.')
  if (requested < current) return { value: current, status: 'rejected', reason: 'would-weaken-required-floor' }
  if (requested === current) return { value: current, status: 'applied', reason: 'already-satisfied' }
  return { value: requested, status: 'applied', reason: 'constraint-applied' }
}

function mergeCeiling(current: number | null, requested: number): { value: number; status: RequirementDecision['status']; reason: RequirementDecisionReason } {
  if (!Number.isSafeInteger(requested) || requested < 0) throw new Error('Execution requirement numeric ceilings must be non-negative safe integers.')
  if (current === null || requested < current) return { value: requested, status: 'applied', reason: 'constraint-applied' }
  if (requested === current) return { value: current, status: 'applied', reason: 'already-satisfied' }
  return { value: current, status: 'rejected', reason: 'would-weaken-required-floor' }
}

function mergeRequired<T extends string>(current: T[], requested: readonly T[]): { value: T[]; reason: RequirementDecisionReason } {
  const value = sortedUnique([...current, ...requested])
  return { value, reason: value.length === current.length ? 'already-satisfied' : 'constraint-applied' }
}

function mergeAllowed<T extends string>(current: T[], requested: readonly T[]): { value: T[]; status: RequirementDecision['status']; reason: RequirementDecisionReason } {
  const requestedSet = new Set(requested)
  const value = current.filter((entry) => requestedSet.has(entry)).sort((left, right) => left.localeCompare(right))
  if (!value.length) return { value, status: 'rejected', reason: 'constraint-conflict' }
  if (value.length === current.length) {
    const widens = requested.some((entry) => !current.includes(entry))
    return { value, status: widens ? 'rejected' : 'applied', reason: widens ? 'would-widen-privacy-boundary' : 'already-satisfied' }
  }
  return { value, status: 'applied', reason: 'constraint-applied' }
}

function applyOverride(target: ExecutionRequirementSet, override: ExecutionRequirementOverride): void {
  const changes = override.changes
  for (const field of PATCH_FIELDS) {
    if (changes[field] === undefined) continue
    let result: { status: RequirementDecision['status']; reason: RequirementDecisionReason }
    switch (field) {
      case 'minimumEffort': {
        const merged = mergeRanked(target.effective.capabilities.minimumEffort, changes.minimumEffort!, EFFORT_ORDER)
        target.effective.capabilities.minimumEffort = merged.value
        result = merged
        break
      }
      case 'requiredCapabilities': {
        const merged = mergeRequired(target.effective.capabilities.required, changes.requiredCapabilities as ExecutionCapability[])
        target.effective.capabilities.required = merged.value
        result = { status: 'applied', reason: merged.reason }
        break
      }
      case 'validationMinimum': {
        const merged = mergeRanked(target.effective.validation.minimum, changes.validationMinimum!, VALIDATION_ORDER)
        target.effective.validation.minimum = merged.value
        result = merged
        break
      }
      case 'requiredChecks': {
        const merged = mergeRequired(target.effective.validation.requiredChecks, changes.requiredChecks!)
        target.effective.validation.requiredChecks = merged.value
        result = { status: 'applied', reason: merged.reason }
        break
      }
      case 'maximumPlanP95Ms': {
        const merged = mergeCeiling(target.effective.latency.maximumPlanP95Ms, changes.maximumPlanP95Ms!)
        target.effective.latency.maximumPlanP95Ms = merged.value
        result = merged
        break
      }
      case 'minimumWindowTokens': {
        const merged = mergeMinimum(target.effective.context.minimumWindowTokens, changes.minimumWindowTokens!)
        target.effective.context.minimumWindowTokens = merged.value
        result = merged
        break
      }
      case 'minimumOutputTokens': {
        const merged = mergeMinimum(target.effective.context.minimumOutputTokens, changes.minimumOutputTokens!)
        target.effective.context.minimumOutputTokens = merged.value
        result = merged
        break
      }
      case 'contextMode': {
        const merged = mergeRanked(target.effective.context.mode, changes.contextMode!, ['partitionable', 'single-candidate'])
        target.effective.context.mode = merged.value
        result = merged
        break
      }
      case 'allowedPrivacyBoundaries': {
        const merged = mergeAllowed(target.effective.privacy.allowedBoundaries, changes.allowedPrivacyBoundaries!)
        target.effective.privacy.allowedBoundaries = merged.value
        result = merged
        break
      }
      case 'allowedTrainingUse': {
        const merged = mergeAllowed(target.effective.privacy.allowedTrainingUse, changes.allowedTrainingUse!)
        target.effective.privacy.allowedTrainingUse = merged.value
        result = merged
        break
      }
      case 'maxRetentionDays': {
        const merged = mergeCeiling(target.effective.privacy.maxRetentionDays, changes.maxRetentionDays!)
        target.effective.privacy.maxRetentionDays = merged.value
        result = merged
        break
      }
      case 'requiredTools': {
        const merged = mergeRequired(target.effective.tools.required, changes.requiredTools!)
        target.effective.tools.required = merged.value
        const conflict = target.effective.tools.required.some((tool) => target.effective.tools.forbidden.includes(tool))
        result = conflict ? { status: 'rejected', reason: 'constraint-conflict' } : { status: 'applied', reason: merged.reason }
        break
      }
      case 'forbiddenTools': {
        const merged = mergeRequired(target.effective.tools.forbidden, changes.forbiddenTools!)
        target.effective.tools.forbidden = merged.value
        const conflict = target.effective.tools.forbidden.some((tool) => target.effective.tools.required.includes(tool))
        result = conflict ? { status: 'rejected', reason: 'constraint-conflict' } : { status: 'applied', reason: merged.reason }
        break
      }
      case 'requireApproval': {
        if (changes.requireApproval === false && target.effective.tools.requireApproval) result = { status: 'rejected', reason: 'would-disable-required-approval' }
        else {
          const changed = changes.requireApproval === true && !target.effective.tools.requireApproval
          target.effective.tools.requireApproval = target.effective.tools.requireApproval || changes.requireApproval!
          result = { status: 'applied', reason: changed ? 'constraint-applied' : 'already-satisfied' }
        }
        break
      }
    }
    target.resolution.decisions.push(decision(override, field, result.status, result.reason))
  }
}

export function applyExecutionRequirementOverrides(base: ExecutionRequirementSet, overrides: readonly ExecutionRequirementOverride[]): ExecutionRequirementSet {
  const target = clone(base)
  const ordered = [...overrides].sort((left, right) => {
    const sourceOrder = Number(left.source === 'user') - Number(right.source === 'user')
    return sourceOrder || left.id.localeCompare(right.id)
  })
  const seen = new Set<string>()
  for (const override of ordered) {
    validateOverride(override)
    if (seen.has(override.id)) throw new Error(`Duplicate execution requirement override '${override.id}'.`)
    seen.add(override.id)
    applyOverride(target, override)
  }
  const toolConflict = target.effective.tools.required.some((tool) => target.effective.tools.forbidden.includes(tool))
  const privacyConflict = !target.effective.privacy.allowedBoundaries.length || !target.effective.privacy.allowedTrainingUse.length
  target.resolution.status = toolConflict || privacyConflict ? 'unsatisfiable' : 'resolved'
  return finalizeExecutionRequirementSet(target)
}
