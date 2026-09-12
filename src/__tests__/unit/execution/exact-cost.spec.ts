import { assertExactCostEvidence, compareExactCosts, ExactRational, exactCostEvidence } from '../../../execution/exact-cost'

describe('shared exact cost primitives (#727)', () => {
  it('compares unrounded rational values and rounds display evidence upward once', () => {
    const lower = exactCostEvidence(ExactRational.decimal('1.001'), 'USD', 2)
    const higher = exactCostEvidence(ExactRational.decimal('1.009'), 'USD', 2)

    expect(lower.amount).toBe('1.01')
    expect(higher.amount).toBe('1.01')
    expect(compareExactCosts(lower, higher)).toBe(-1)
    expect(exactCostEvidence(ExactRational.evidence(higher).subtract(ExactRational.evidence(lower)), 'USD', 3)).toMatchObject({ numerator: '1', denominator: '125', amount: '0.008' })
  })

  it.each([
    [{ currency: 'USD', numerator: '2', denominator: '2', amount: '1.00', scale: 2, rounding: 'ceiling' }, 'reduced'],
    [{ currency: 'USD', numerator: '1', denominator: '3', amount: '0.33', scale: 2, rounding: 'ceiling' }, 'amount'],
    [{ currency: 'usd', numerator: '1', denominator: '1', amount: '1.00', scale: 2, rounding: 'ceiling' }, 'currency'],
    [{ currency: 'USD', numerator: '1', denominator: '0', amount: '0.00', scale: 2, rounding: 'ceiling' }, 'parts']
  ])('rejects malformed exact evidence without accepting rounded comparisons', (value, expected) => {
    expect(() => assertExactCostEvidence(value)).toThrow(expected)
  })

  it('bounds decimal inputs before bigint conversion', () => {
    expect(() => ExactRational.decimal('1'.repeat(257))).toThrow(/bounded/)
  })
})
