export interface TruePriceInput {
  rrp: number;
  itemPrice: number;
  deliveryCost?: number;
  mandatoryFees?: number;
}

export interface TruePriceResult {
  rrp: number;
  itemPrice: number;
  deliveryCost: number;
  mandatoryFees: number;
  deliveredCost: number;
  itemPremiumAmount: number;
  itemPremiumPercent: number;
  deliveredPremiumAmount: number;
  deliveredPremiumPercent: number;
}

const roundMoney = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
const roundPercent = (value: number) => Math.round((value + Number.EPSILON) * 10) / 10;

export function calculateTruePrice(input: TruePriceInput): TruePriceResult {
  if (input.rrp <= 0) throw new Error('RRP must be greater than zero');

  const deliveryCost = input.deliveryCost ?? 0;
  const mandatoryFees = input.mandatoryFees ?? 0;
  const deliveredCost = input.itemPrice + deliveryCost + mandatoryFees;
  const itemPremiumAmount = input.itemPrice - input.rrp;
  const deliveredPremiumAmount = deliveredCost - input.rrp;

  return {
    rrp: roundMoney(input.rrp),
    itemPrice: roundMoney(input.itemPrice),
    deliveryCost: roundMoney(deliveryCost),
    mandatoryFees: roundMoney(mandatoryFees),
    deliveredCost: roundMoney(deliveredCost),
    itemPremiumAmount: roundMoney(itemPremiumAmount),
    itemPremiumPercent: roundPercent((itemPremiumAmount / input.rrp) * 100),
    deliveredPremiumAmount: roundMoney(deliveredPremiumAmount),
    deliveredPremiumPercent: roundPercent((deliveredPremiumAmount / input.rrp) * 100),
  };
}
