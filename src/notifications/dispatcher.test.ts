import { describe, expect, it } from 'vitest';
import type { FateDropEvent } from '../events/eventBus.js';
import { notificationRouting } from './dispatcher.js';
import { defaultNotificationPreferences, type DeviceSubscription } from './preferences.js';

const device: DeviceSubscription = {
  userId: 'user-1',
  expoPushToken: 'ExponentPushToken[test]',
  premium: true,
  preferences: defaultNotificationPreferences,
};

function event(type: string): FateDropEvent {
  return {
    id: 'event-1',
    family: 'SIGNAL',
    type,
    createdAt: new Date().toISOString(),
    payload: {},
  };
}

describe('notification routing', () => {
  it('does not push Echo by default', () => {
    expect(notificationRouting.wantsEvent(device, event('ECHO_CREATED'))).toBe(false);
  });

  it('pushes Drop Pulse by default', () => {
    expect(notificationRouting.wantsEvent(device, event('DROP_PULSE_CREATED'))).toBe(true);
  });

  it('routes high-value signal events to premium Discord', () => {
    expect(notificationRouting.shouldSendToPremiumDiscord(event('HIGH_SIGNAL_CREATED'))).toBe(true);
    expect(notificationRouting.shouldSendToPremiumDiscord(event('PRODUCT_MANIFESTED'))).toBe(true);
  });

  it('does not route price changes to premium Discord by default', () => {
    expect(notificationRouting.shouldSendToPremiumDiscord(event('PRICE_CHANGED'))).toBe(false);
  });
});
