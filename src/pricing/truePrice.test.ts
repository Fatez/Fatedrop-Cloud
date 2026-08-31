import { describe, expect, it } from 'vitest';
import { calculateTruePrice } from './truePrice.js';

describe('True Price', () => {
  it('calculates delivered cost and premium versus RRP', () => {
    const result = calculateTruePrice({
      rrp: 49.99,
      itemPrice: 54.99,
      deliveryCost: 7.95,
      mandatoryFees: 0,
    });

    expect(result.deliveredCost).toBe(62.94);
    expect(result.itemPremiumAmount).toBe(5);
    expect(result.itemPremiumPercent).toBe(10);
    expect(result.deliveredPremiumAmount).toBe(12.95);
    expect(result.deliveredPremiumPercent).toBe(25.9);
  });
});
