export interface NotificationPreferences {
  echo: boolean;
  dropPulse: boolean;
  highSignal: boolean;
  manifested: boolean;
  restocks: boolean;
  priceChanges: boolean;
  newIndies: boolean;
  indieStockChanges: boolean;
  events: boolean;
}

export interface DeviceSubscription {
  userId: string;
  expoPushToken: string;
  premium: boolean;
  preferences: NotificationPreferences;
}

export const defaultNotificationPreferences: NotificationPreferences = {
  echo: false,
  dropPulse: true,
  highSignal: true,
  manifested: true,
  restocks: true,
  priceChanges: false,
  newIndies: true,
  indieStockChanges: false,
  events: true,
};

const devices = new Map<string, DeviceSubscription>();

export function upsertDevice(subscription: DeviceSubscription): DeviceSubscription {
  devices.set(subscription.expoPushToken, subscription);
  return subscription;
}

export function removeDevice(expoPushToken: string): boolean {
  return devices.delete(expoPushToken);
}

export function listDevices(): DeviceSubscription[] {
  return [...devices.values()];
}
