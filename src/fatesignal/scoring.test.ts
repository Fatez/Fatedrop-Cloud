import { describe, expect, it } from 'vitest';
import { resolveSignalState, scoreSignals, type SignalObservation } from './scoring.js';

const make = (type: SignalObservation['type']): SignalObservation => ({
  type,
  observedAt: new Date().toISOString(),
  retailerId: 'pokemon-center-uk',
});

describe('FateSignal scoring', () => {
  it('keeps weak activity static', () => {
    expect(resolveSignalState([make('CATALOGUE_CHANGED')])).toBe('STATIC');
  });

  it('creates an echo from a meaningful single signal', () => {
    expect(resolveSignalState([make('NEW_SKU')])).toBe('ECHO');
  });

  it('creates a drop pulse from converging signals', () => {
    const observations = [make('QUEUE_OPENED'), make('NEW_SKU')];
    expect(scoreSignals(observations)).toBe(40);
    expect(resolveSignalState(observations)).toBe('DROP_PULSE');
  });

  it('requires explicit manifestation evidence for manifested state', () => {
    const observations = [make('NEW_PRODUCT'), make('STOCK_RETURNED')];
    expect(resolveSignalState(observations)).toBe('HIGH_SIGNAL');
    expect(resolveSignalState([...observations, make('PRODUCT_MANIFESTED')])).toBe('MANIFESTED');
  });
});
