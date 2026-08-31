export type FateSignalState = 'STATIC' | 'ECHO' | 'DROP_PULSE' | 'HIGH_SIGNAL' | 'MANIFESTED';

export type SignalEventType =
  | 'QUEUE_OPENED'
  | 'QUEUE_CLOSED'
  | 'NEW_PRODUCT'
  | 'NEW_SKU'
  | 'CATALOGUE_CHANGED'
  | 'STOCK_AVAILABLE'
  | 'STOCK_UNAVAILABLE'
  | 'STOCK_RETURNED'
  | 'PREORDER_OPENED'
  | 'PRICE_CHANGED'
  | 'PRODUCT_MANIFESTED';

export interface SignalObservation {
  type: SignalEventType;
  observedAt: string;
  retailerId: string;
  productId?: string;
}

const weights: Partial<Record<SignalEventType, number>> = {
  QUEUE_OPENED: 15,
  CATALOGUE_CHANGED: 15,
  NEW_SKU: 25,
  NEW_PRODUCT: 30,
  PREORDER_OPENED: 35,
  STOCK_RETURNED: 50,
};

export function scoreSignals(observations: SignalObservation[]): number {
  return observations.reduce((total, observation) => total + (weights[observation.type] ?? 0), 0);
}

export function resolveSignalState(observations: SignalObservation[]): FateSignalState {
  if (observations.some((observation) => observation.type === 'PRODUCT_MANIFESTED')) {
    return 'MANIFESTED';
  }

  const score = scoreSignals(observations);
  if (score >= 70) return 'HIGH_SIGNAL';
  if (score >= 40) return 'DROP_PULSE';
  if (score >= 20) return 'ECHO';
  return 'STATIC';
}

export const fateSignalConfig = {
  weights,
  thresholds: {
    echo: 20,
    dropPulse: 40,
    highSignal: 70,
  },
};
