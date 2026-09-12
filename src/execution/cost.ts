import { stableFingerprint } from './overrides'
import { calculateExactUsageCost, ExactRational, exactCostEvidence } from './exact-cost'
import {
  assertExecutionPlanProposal,
  type ExecutionPlanExclusion,
  type ExecutionPlanNode,
  type ExecutionPlanProposal,
  type ExecutionPlanQualificationResult,
  type ExecutionPlanSelectionPolicy,
  type QualifiedExecutionPlan
} from './plans'
import type { ExecutionRequirementSet, RequirementEffort, ValidationCheck } from './requirements'
import type { ExecutionCandidateCatalogueSnapshot, NormalizedEffort } from './types'

const EFFORT_ORDER: NormalizedEffort[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']
const POLICY_TIE_BREAKERS = new Set(['lower-max-path-cost', 'lower-p95-latency', 'fewer-nodes', 'prefer-local', 'higher-effort'])

function excluded(proposalId: string, code: ExecutionPlanExclusion['code'], detailCode: string, node?: ExecutionPlanNode): ExecutionPlanExclusion {
  return { proposalId, ...(node ? { nodeId: node.id, candidateId: node.candidateId } : {}), code, detailCode }
}

function validatePolicy(policy: ExecutionPlanSelectionPolicy): void {
  if (policy.schemaVersion !== 1) throw new Error('policy-schema')
  if (!canonicalTimestamp(policy.planningAt)) throw new Error('planning-time')
  if (!/^[A-Z]{3}$/.test(policy.settlementCurrency)) throw new Error('settlement-currency')
  if (!Number.isSafeInteger(policy.displayScale) || policy.displayScale < 0 || policy.displayScale > 12) throw new Error('display-scale')
  if (!Array.isArray(policy.tieBreakers) || new Set(policy.tieBreakers).size !== policy.tieBreakers.length || policy.tieBreakers.some((rule) => !POLICY_TIE_BREAKERS.has(rule)))
    throw new Error('tie-breakers')
}

function canonicalTimestamp(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value
}

function currentAt(observedAt: string, validUntil: string, planningAt: string): boolean {
  return observedAt <= planningAt && planningAt < validUntil
}

function semanticFingerprint(proposal: ExecutionPlanProposal): string {
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

function requirementFingerprintValid(requirements: ExecutionRequirementSet): boolean {
  const payload = { ...requirements } as Partial<ExecutionRequirementSet>
  delete payload.id
  return requirements.id === stableFingerprint(payload)
}

interface Graph {
  nodes: Map<string, ExecutionPlanNode>
  edgeProbability: Map<string, Map<string, ExactRational>>
  order: ExecutionPlanNode[]
}

function graph(proposal: ExecutionPlanProposal): Graph | string {
  const nodes = new Map(proposal.nodes.map((node) => [node.id, node]))
  const root = nodes.get(proposal.rootNodeId)!
  if (root.role !== 'primary' || proposal.nodes.filter((node) => node.role === 'primary').length !== 1) return 'single-primary-root'
  const parents = new Map<string, Set<string>>()
  const edgeProbability = new Map<string, Map<string, ExactRational>>()
  for (const node of proposal.nodes) {
    let sum = new ExactRational(0n)
    const edges = new Map<string, ExactRational>()
    for (const outcome of node.outcomes) {
      const probability = ExactRational.decimal(outcome.conditionalProbability)
      if (probability.numerator <= 0n || probability.compare(new ExactRational(1n)) > 0) return 'outcome-probability-range'
      sum = sum.add(probability)
      if (outcome.nextNodeId) {
        if (!nodes.has(outcome.nextNodeId)) return 'dangling-node'
        edges.set(outcome.nextNodeId, (edges.get(outcome.nextNodeId) ?? new ExactRational(0n)).add(probability))
        const nodeParents = parents.get(outcome.nextNodeId) ?? new Set<string>()
        nodeParents.add(node.id)
        parents.set(outcome.nextNodeId, nodeParents)
      }
    }
    if (sum.compare(new ExactRational(1n)) !== 0) return 'outcome-probabilities-must-sum-to-one'
    edgeProbability.set(node.id, edges)
  }
  if ((parents.get(proposal.rootNodeId)?.size ?? 0) !== 0) return 'root-has-parent'
  if ([...parents.entries()].some(([id, values]) => id !== proposal.rootNodeId && values.size > 1)) return 'multiple-parents'
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const order: ExecutionPlanNode[] = []
  const walk = (id: string): boolean => {
    if (visiting.has(id)) return false
    if (visited.has(id)) return true
    visiting.add(id)
    for (const child of edgeProbability.get(id)?.keys() ?? []) if (!walk(child)) return false
    visiting.delete(id)
    visited.add(id)
    order.unshift(nodes.get(id)!)
    return true
  }
  if (!walk(proposal.rootNodeId)) return 'cycle'
  if (visited.size !== nodes.size) return 'unreachable-node'
  return { nodes, edgeProbability, order }
}

function maximumPathLatency(id: string, graphValue: Graph, memo = new Map<string, number | null>()): number | null {
  if (memo.has(id)) return memo.get(id)!
  const node = graphValue.nodes.get(id)!
  if (node.estimate.latencyP95Ms === null) return null
  const children = [...(graphValue.edgeProbability.get(id)?.keys() ?? [])]
  const childValues = children.map((child) => maximumPathLatency(child, graphValue, memo))
  const value = childValues.some((child) => child === null) ? null : node.estimate.latencyP95Ms + Math.max(0, ...(childValues as number[]))
  memo.set(id, value)
  return value
}

function effortSatisfies(actual: NormalizedEffort, required: RequirementEffort): boolean {
  return actual !== 'custom' && EFFORT_ORDER.indexOf(actual) >= EFFORT_ORDER.indexOf(required)
}

/** Qualifies every node before performing exact full-tree cost evaluation. */
export function qualifyAndCostExecutionPlan(
  proposalValue: unknown,
  requirements: ExecutionRequirementSet,
  catalogue: ExecutionCandidateCatalogueSnapshot,
  policy: ExecutionPlanSelectionPolicy
): ExecutionPlanQualificationResult {
  const rawProposalId = typeof proposalValue === 'object' && proposalValue !== null ? (proposalValue as { id?: unknown }).id : undefined
  const proposalId =
    typeof rawProposalId === 'string' && /^[a-z0-9][a-z0-9._:/-]{0,127}$/i.test(rawProposalId) && !/(?:\bBearer\s+|\b(?:sk|gh[pousr]|github_pat|xox[baprs])[_-])/i.test(rawProposalId)
      ? rawProposalId
      : 'unknown-proposal'
  try {
    assertExecutionPlanProposal(proposalValue)
    validatePolicy(policy)
  } catch {
    return { status: 'excluded', exclusions: [excluded(proposalId, 'invalid-proposal', 'contract-validation')] }
  }
  const proposal = proposalValue
  const proposalFingerprint = semanticFingerprint(proposal)
  if (requirements.resolution.status !== 'resolved' || !requirementFingerprintValid(requirements)) {
    return { status: 'excluded', exclusions: [{ ...excluded(proposal.id, 'requirements-unsatisfiable', 'unresolved-or-invalid-requirements'), proposalFingerprint }] }
  }
  const graphValue = graph(proposal)
  if (typeof graphValue === 'string') return { status: 'excluded', exclusions: [{ ...excluded(proposal.id, 'invalid-proposal', graphValue), proposalFingerprint }] }
  const candidates = new Map(catalogue.eligible.map((candidate) => [candidate.id, candidate]))
  const exclusions: ExecutionPlanExclusion[] = []
  const usedTools = new Set<string>()
  const checks = new Set<ValidationCheck>()
  let approvalRequired = requirements.effective.tools.requireApproval
  const planningAt = policy.planningAt
  for (const node of graphValue.order) {
    const candidate = candidates.get(node.candidateId)
    if (!candidate) {
      exclusions.push(excluded(proposal.id, 'candidate-missing', 'not-in-eligible-catalogue', node))
      continue
    }
    if (!currentAt(candidate.availability.checkedAt, candidate.availability.validUntil, planningAt) || candidate.availability.state !== 'available')
      exclusions.push(excluded(proposal.id, 'candidate-stale', 'availability-not-current', node))
    if (!currentAt(candidate.pricing.observedAt, candidate.pricing.validUntil, planningAt)) exclusions.push(excluded(proposal.id, 'candidate-stale', 'pricing-not-current', node))
    if (!currentAt(node.estimate.observedAt, node.estimate.validUntil, planningAt)) exclusions.push(excluded(proposal.id, 'evidence-stale', 'node-estimate-not-current', node))
    if (requirements.effective.capabilities.required.some((capability) => !candidate.capabilities.includes(capability)))
      exclusions.push(excluded(proposal.id, 'capability-mismatch', 'required-capability-missing', node))
    if (!effortSatisfies(candidate.effort.normalized, requirements.effective.capabilities.minimumEffort)) exclusions.push(excluded(proposal.id, 'effort-mismatch', 'minimum-effort-not-met', node))
    const inputUsage = Number(node.estimate.usageP95['input-token'] ?? '0') + Number(node.estimate.usageP95['cached-input-token'] ?? '0')
    const outputUsage = Number(node.estimate.usageP95['output-token'] ?? '0')
    if (
      candidate.context.windowTokens === null ||
      candidate.context.maxOutputTokens === null ||
      candidate.context.windowTokens < requirements.effective.context.minimumWindowTokens ||
      candidate.context.maxOutputTokens < requirements.effective.context.minimumOutputTokens ||
      !Number.isSafeInteger(inputUsage) ||
      !Number.isSafeInteger(outputUsage) ||
      inputUsage > candidate.context.windowTokens ||
      outputUsage > candidate.context.maxOutputTokens
    )
      exclusions.push(excluded(proposal.id, 'context-mismatch', 'context-capacity-not-proven', node))
    if (!requirements.effective.privacy.allowedBoundaries.includes(candidate.privacy.boundary) || !requirements.effective.privacy.allowedTrainingUse.includes(candidate.privacy.trainingUse))
      exclusions.push(excluded(proposal.id, 'privacy-mismatch', 'privacy-policy-not-met', node))
    if (requirements.effective.privacy.maxRetentionDays !== null) {
      if (candidate.privacy.retentionDays === null) exclusions.push(excluded(proposal.id, 'retention-unknown', 'retention-not-proven', node))
      else if (candidate.privacy.retentionDays > requirements.effective.privacy.maxRetentionDays) exclusions.push(excluded(proposal.id, 'retention-mismatch', 'retention-ceiling-exceeded', node))
    }
    for (const tool of node.tools) {
      usedTools.add(tool)
      if (!candidate.tools.supported.includes(tool) || requirements.effective.tools.forbidden.includes(tool)) exclusions.push(excluded(proposal.id, 'tool-mismatch', 'declared-tool-not-allowed', node))
    }
    for (const check of node.checks) checks.add(check)
    approvalRequired ||= candidate.tools.requiresApproval
  }
  if (requirements.effective.tools.required.some((tool) => !usedTools.has(tool))) exclusions.push(excluded(proposal.id, 'tool-mismatch', 'required-tool-not-covered'))
  if (requirements.effective.validation.requiredChecks.some((check) => !checks.has(check))) exclusions.push(excluded(proposal.id, 'validation-mismatch', 'required-check-not-covered'))
  if (requirements.effective.validation.minimum.startsWith('independent-review') || requirements.effective.validation.requiredChecks.includes('independent-review')) {
    const root = graphValue.nodes.get(proposal.rootNodeId)!
    const validations = proposal.nodes.filter((node) => node.role === 'validation' && node.checks.includes('independent-review'))
    if (!validations.some((node) => node.candidateId !== root.candidateId && node.estimate.independenceDomain !== root.estimate.independenceDomain))
      exclusions.push(excluded(proposal.id, 'independence-mismatch', 'independent-validation-not-proven'))
  }
  const pathLatency = maximumPathLatency(proposal.rootNodeId, graphValue)
  if (requirements.effective.latency.maximumPlanP95Ms !== null) {
    if (pathLatency === null) exclusions.push(excluded(proposal.id, 'latency-unknown', 'path-latency-not-proven'))
    else if (pathLatency > requirements.effective.latency.maximumPlanP95Ms) exclusions.push(excluded(proposal.id, 'latency-mismatch', 'latency-ceiling-exceeded'))
  }
  if (exclusions.length) {
    return {
      status: 'excluded',
      exclusions: exclusions
        .map((entry) => ({ ...entry, proposalFingerprint }))
        .sort((left, right) => `${left.nodeId ?? ''}/${left.code}/${left.detailCode ?? ''}`.localeCompare(`${right.nodeId ?? ''}/${right.code}/${right.detailCode ?? ''}`))
    }
  }

  const nodeCost = new Map<string, ExactRational>()
  for (const node of graphValue.order) {
    const result = calculateExactUsageCost(node.estimate.usageP95, candidates.get(node.candidateId)!, policy.settlementCurrency)
    if (!(result instanceof ExactRational)) return { status: 'excluded', exclusions: [{ ...excluded(proposal.id, result.code, result.detail, node), proposalFingerprint }] }
    nodeCost.set(node.id, result)
  }
  const reach = new Map<string, ExactRational>([[proposal.rootNodeId, new ExactRational(1n)]])
  for (const node of graphValue.order) {
    const parentReach = reach.get(node.id)!
    for (const [child, probability] of graphValue.edgeProbability.get(node.id) ?? []) reach.set(child, (reach.get(child) ?? new ExactRational(0n)).add(parentReach.multiply(probability)))
  }
  let aggregate = new ExactRational(0n)
  for (const node of graphValue.order) aggregate = aggregate.add(reach.get(node.id)!.multiply(nodeCost.get(node.id)!))
  const maximumCost = (id: string, memo = new Map<string, ExactRational>()): ExactRational => {
    if (memo.has(id)) return memo.get(id)!
    const children = [...(graphValue.edgeProbability.get(id)?.keys() ?? [])]
    let tail = new ExactRational(0n)
    for (const child of children) {
      const childCost = maximumCost(child, memo)
      if (childCost.compare(tail) > 0) tail = childCost
    }
    const value = nodeCost.get(id)!.add(tail)
    memo.set(id, value)
    return value
  }
  const maximum = maximumCost(proposal.rootNodeId)
  const rootCandidate = candidates.get(graphValue.nodes.get(proposal.rootNodeId)!.candidateId)!
  const validUntil = proposal.nodes.reduce((earliest, node) => {
    const candidate = candidates.get(node.candidateId)!
    return [earliest, node.estimate.validUntil, candidate.availability.validUntil, candidate.pricing.validUntil].sort()[0]
  }, '9999-12-31T23:59:59.999Z')
  const plan: QualifiedExecutionPlan = {
    proposalId: proposal.id,
    proposalFingerprint,
    rootCandidateId: rootCandidate.id,
    rootEffort: rootCandidate.effort.normalized,
    rootRuntimeKind: rootCandidate.runtime.kind,
    rootBoundary: rootCandidate.privacy.boundary,
    nodeCount: proposal.nodes.length,
    maximumPathLatencyP95Ms: pathLatency,
    validUntil,
    approvalRequired,
    checks: [...checks].sort(),
    evidenceRefs: [...new Set(proposal.nodes.flatMap((node) => [node.estimate.evidenceRef, ...node.outcomes.map((outcome) => outcome.evidenceRef)]))].sort(),
    nodeCosts: graphValue.order
      .map((node) => ({
        nodeId: node.id,
        candidateId: node.candidateId,
        reachProbability: { numerator: reach.get(node.id)!.numerator.toString(), denominator: reach.get(node.id)!.denominator.toString() },
        invocationP95: exactCostEvidence(nodeCost.get(node.id)!, policy.settlementCurrency, policy.displayScale),
        weightedP95: exactCostEvidence(reach.get(node.id)!.multiply(nodeCost.get(node.id)!), policy.settlementCurrency, policy.displayScale)
      }))
      .sort((left, right) => left.nodeId.localeCompare(right.nodeId)),
    expectedAggregateP95: exactCostEvidence(aggregate, policy.settlementCurrency, policy.displayScale),
    maximumPathP95: exactCostEvidence(maximum, policy.settlementCurrency, policy.displayScale)
  }
  return { status: 'qualified', plan }
}
