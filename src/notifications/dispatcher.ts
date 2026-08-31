import type { FateDropEvent } from '../events/eventBus.js';
import { sendDiscordEvent } from './discord.js';
import { sendExpoPush } from './expoPush.js';
import { listDevices, type DeviceSubscription } from './preferences.js';

function wantsEvent(device: DeviceSubscription, event: FateDropEvent): boolean {
  const p = device.preferences;

  switch (event.type) {
    case 'ECHO_CREATED':
      return p.echo;
    case 'DROP_PULSE_CREATED':
      return p.dropPulse;
    case 'HIGH_SIGNAL_CREATED':
      return p.highSignal;
    case 'PRODUCT_MANIFESTED':
      return p.manifested;
    case 'RESTOCK':
      return p.restocks;
    case 'PRICE_CHANGED':
      return p.priceChanges;
    case 'INDIE_JOINED':
      return p.newIndies;
    case 'INDIE_STOCK_CHANGED':
      return p.indieStockChanges;
    case 'NEW_EVENT':
      return p.events;
    default:
      return false;
  }
}

function shouldSendToPremiumDiscord(event: FateDropEvent): boolean {
  return [
    'DROP_PULSE_CREATED',
    'HIGH_SIGNAL_CREATED',
    'PRODUCT_MANIFESTED',
    'RESTOCK',
    'INDIE_JOINED',
    'NEW_EVENT',
  ].includes(event.type);
}

export async function dispatchNotifications(event: FateDropEvent): Promise<void> {
  const eligibleDevices = listDevices().filter((device) => wantsEvent(device, event));

  const jobs: Promise<unknown>[] = [sendExpoPush(event, eligibleDevices)];

  if (shouldSendToPremiumDiscord(event)) {
    jobs.push(sendDiscordEvent(event));
  }

  await Promise.allSettled(jobs);
}

export const notificationRouting = {
  wantsEvent,
  shouldSendToPremiumDiscord,
};
