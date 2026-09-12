import type { BillableUsageP95, ExactCostEvidence } from './plans'
import type { ExecutionCandidate, PriceDimensionKind, PriceUnit } from './types'

const NON_NEGATIVE_DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d+)?$/
const INTEGER = /^(?:0|[1-9]\d*)$/
const CURRENCY = /^[A-Z]{3}$/
const MAX_DIGITS = 256
const DIMENSION_UNIT: Record<PriceDimensionKind, PriceUnit> = {
  'input-token': 'token',
  'output-token': 'token',
  'cached-input-token': 'token',
  request: 'request',
  second: 'second',
  minute: 'minute',
  'tool-call': 'call'
}
const INTEGER_DIMENSIONS = new Set<PriceDimensionKind>(['input-token', 'output-token', 'cached-input-token', 'request', 'tool-call'])

function gcd(left: bigint, right: bigint): bigint {
  let a = left < 0n ? -left : left
  let b = right < 0n ? -right : right
  while (b !== 0n) [a, b] = [b, a % b]
  return a || 1n
}

function bounded(value: string, expression: RegExp): boolean {
  return value.length <= MAX_DIGITS && expression.test(value)
}

/** Reduced exact arithmetic used for every monetary comparison. */
export class ExactRational {
  readonly numerator: bigint
  readonly denominator: bigint

  constructor(numerator: bigint, denominator = 1n) {
    if (denominator === 0n) throw new Error('An exact rational denominator cannot be zero.')
    const sign = denominator < 0n ? -1n : 1n
    const divisor = gcd(numerator, denominator)
    this.numerator = (numerator / divisor) * sign
    this.denominator = (denominator / divisor) * sign
  }

  static decimal(value: string): ExactRational {
    if (!bounded(value, NON_NEGATIVE_DECIMAL)) throw new Error('Expected a bounded non-negative decimal string.')
    const [whole, fraction = ''] = value.split('.')
    return new ExactRational(BigInt(`${whole}${fraction}`), 10n ** BigInt(fraction.length))
  }

  static evidence(value: Pick<ExactCostEvidence, 'numerator' | 'denominator'>): ExactRational {
    if (!bounded(value.numerator, INTEGER) || !bounded(value.denominator, /^[1-9]\d*$/)) throw new Error('Expected canonical non-negative exact cost parts.')
    const rational = new ExactRational(BigInt(value.numerator), BigInt(value.denominator))
    if (rational.numerator.toString() !== value.numerator || rational.denominator.toString() !== value.denominator) throw new Error('Expected reduced exact cost parts.')
    return rational
  }

  add(other: ExactRational): ExactRational {
    return new ExactRational(this.numerator * other.denominator + other.numerator * this.denominator, this.denominator * other.denominator)
  }

  subtract(other: ExactRational): ExactRational {
    return new ExactRational(this.numerator * other.denominator - other.numerator * this.denominator, this.denominator * other.denominator)
  }

  multiply(other: ExactRational): ExactRational {
    return new ExactRational(this.numerator * other.numerator, this.denominator * other.denominator)
  }

  divide(divisor: bigint): ExactRational {
    if (divisor <= 0n) throw new Error('An exact rational divisor must be positive.')
    return new ExactRational(this.numerator, this.denominator * divisor)
  }

  compare(other: ExactRational): number {
    const delta = this.numerator * other.denominator - other.numerator * this.denominator
    return delta < 0n ? -1 : delta > 0n ? 1 : 0
  }

  maximum(other: ExactRational): ExactRational {
    return this.compare(other) >= 0 ? this : other
  }
}

/** Builds the sole rounded representation of an exact, non-negative cost. */
export function exactCostEvidence(value: ExactRational, currency: string, scale: number): ExactCostEvidence {
  if (value.numerator < 0n) throw new Error('Cost evidence cannot be negative.')
  if (!CURRENCY.test(currency)) throw new Error('Cost evidence requires an ISO 4217 currency code.')
  if (!Number.isSafeInteger(scale) || scale < 0 || scale > 12) throw new Error('Cost evidence scale must be a safe integer from 0 to 12.')
  const factor = 10n ** BigInt(scale)
  const scaled = value.numerator * factor
  const rounded = (scaled + value.denominator - 1n) / value.denominator
  const digits = rounded.toString().padStart(scale + 1, '0')
  const amount = scale === 0 ? digits : `${digits.slice(0, -scale)}.${digits.slice(-scale)}`
  return { currency, numerator: value.numerator.toString(), denominator: value.denominator.toString(), amount, scale, rounding: 'ceiling' }
}

/** Validates both the exact fraction and its one-time upward-rounded display value. */
export function assertExactCostEvidence(value: unknown, label = 'exact cost evidence'): asserts value is ExactCostEvidence {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`)
  const record = value as Record<string, unknown>
  const allowed = ['currency', 'numerator', 'denominator', 'amount', 'scale', 'rounding']
  const unknown = Object.keys(record).filter((field) => !allowed.includes(field))
  if (unknown.length) throw new Error(`${label} contains unsupported fields: ${unknown.sort().join(', ')}.`)
  if (typeof record.currency !== 'string' || !CURRENCY.test(record.currency)) throw new Error(`${label}.currency must be an ISO 4217 code.`)
  if (typeof record.numerator !== 'string' || typeof record.denominator !== 'string') throw new Error(`${label} must contain exact string parts.`)
  if (!Number.isSafeInteger(record.scale) || Number(record.scale) < 0 || Number(record.scale) > 12) throw new Error(`${label}.scale must be a safe integer from 0 to 12.`)
  if (record.rounding !== 'ceiling') throw new Error(`${label}.rounding must equal ceiling.`)
  const rational = ExactRational.evidence({ numerator: record.numerator, denominator: record.denominator })
  const expected = exactCostEvidence(rational, record.currency, Number(record.scale))
  if (record.amount !== expected.amount) throw new Error(`${label}.amount does not match its exact value and scale.`)
}

export function compareExactCosts(left: ExactCostEvidence, right: ExactCostEvidence): number {
  assertExactCostEvidence(left, 'left exact cost')
  assertExactCostEvidence(right, 'right exact cost')
  if (left.currency !== right.currency) throw new Error('Exact costs must use the same currency.')
  return ExactRational.evidence(left).compare(ExactRational.evidence(right))
}

export type ExactUsageCostIssue = { code: 'price-incomplete' | 'currency-uncomparable'; detail: string }

/** Prices one declared workload using the same strict rules as execution-plan nodes. */
export function calculateExactUsageCost(usageP95: BillableUsageP95, candidate: ExecutionCandidate, currency: string): ExactRational | ExactUsageCostIssue {
  const rates = new Map<PriceDimensionKind, ExecutionCandidate['pricing']['dimensions'][number]>()
  for (const rate of candidate.pricing.dimensions) {
    if (rates.has(rate.kind)) return { code: 'price-incomplete', detail: 'duplicate-price-dimension' }
    if (rate.currency !== currency) return { code: 'currency-uncomparable', detail: 'settlement-currency-mismatch' }
    if (rate.unit !== DIMENSION_UNIT[rate.kind]) return { code: 'price-incomplete', detail: 'incompatible-normalized-unit' }
    if (!Number.isSafeInteger(rate.per) || rate.per < 1) return { code: 'price-incomplete', detail: 'invalid-price-unit-size' }
    rates.set(rate.kind, rate)
  }
  const usage = Object.entries(usageP95) as Array<[PriceDimensionKind, string]>
  if (usage.length === 0 || rates.size === 0) return { code: 'price-incomplete', detail: 'explicit-usage-and-prices-required' }
  for (const kind of rates.keys()) if (!Object.prototype.hasOwnProperty.call(usageP95, kind)) return { code: 'price-incomplete', detail: 'usage-missing-for-priced-dimension' }
  let total = new ExactRational(0n)
  try {
    for (const [kind, quantityValue] of usage) {
      if (INTEGER_DIMENSIONS.has(kind) && quantityValue.includes('.')) return { code: 'price-incomplete', detail: 'fractional-discrete-usage' }
      const quantity = ExactRational.decimal(quantityValue)
      const rate = rates.get(kind)
      if (!rate) {
        if (quantity.numerator > 0n) return { code: 'price-incomplete', detail: 'price-missing-for-positive-usage' }
        continue
      }
      total = total.add(quantity.multiply(ExactRational.decimal(rate.amount)).divide(BigInt(rate.per)))
    }
  } catch {
    return { code: 'price-incomplete', detail: 'invalid-price-or-usage-decimal' }
  }
  return total
}
