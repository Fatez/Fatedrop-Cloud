import type { FateDropEvent } from '../events/eventBus.js';
import type { DeviceSubscription } from './preferences.js';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

function buildMessage(event: FateDropEvent): { title: string; body: string } {
  switch (event.type) {
    case 'ECHO_CREATED':
      return { title: 'FateDrop Echo', body: 'Unusual retailer activity has been detected.' };
    case 'DROP_PULSE_CREATED':
      return { title: 'FateSignal: Drop Pulse', body: 'Multiple signals are beginning to converge.' };
    case 'HIGH_SIGNAL_CREATED':
      return { title: 'FateSignal: High Signal', body: 'Significant drop activity may be developing.' };
    case 'PRODUCT_MANIFESTED':
      return { title: 'Manifested: Product Live', body: String(event.payload['title'] ?? 'A watched product is now live.') };
    case 'RESTOCK':
      return { title: 'FateDrop Restock', body: String(event.payload['title'] ?? 'A product has returned to stock.') };
    case 'PRICE_CHANGED':
      return { title: 'FateDrop Price Change', body: String(event.payload['title'] ?? 'A tracked price has changed.') };
    case 'INDIE_JOINED':
      return { title: 'New Indie Joined FateDrop', body: String(event.payload['name'] ?? 'A new independent retailer joined the network.') };
    case 'INDIE_STOCK_CHANGED':
      return { title: 'Indie Stock Updated', body: String(event.payload['title'] ?? 'An indie retailer updated stock.') };
    case 'NEW_EVENT':
      return { title: 'New Collector Event', body: String(event.payload['name'] ?? 'A new event has been added to FateDrop.') };
    default:
      return { title: 'FateDrop', body: 'New network activity is available.' };
  }
}

export async function sendExpoPush(event: FateDropEvent, devices: DeviceSubscription[]): Promise<void> {
  if (devices.length === 0) return;
  if (process.env.FATEDROP_PUSH_ENABLED !== 'true') return;

  const { title, body } = buildMessage(event);
  const messages = devices.map((device) => ({
    to: device.expoPushToken,
    sound: 'default',
    title,
    body,
    data: {
      eventId: event.id,
      family: event.family,
      type: event.type,
      retailerId: event.retailerId,
      productId: event.productId,
    },
  }));

  const response = await fetch(EXPO_PUSH_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(messages),
  });

  if (!response.ok) {
    throw new Error(`Expo push request failed with HTTP ${response.status}`);
  }
}
