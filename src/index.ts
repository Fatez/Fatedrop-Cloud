import express from 'express';
import { eventBus, type FateDropEvent } from './events/eventBus.js';
import { dispatchNotifications } from './notifications/dispatcher.js';
import {
  defaultNotificationPreferences,
  listDevices,
  removeDevice,
  upsertDevice,
} from './notifications/preferences.js';
import { calculateTruePrice } from './pricing/truePrice.js';
import {
  listIndieOffers,
  listIndieRetailers,
  upsertIndieOffer,
  upsertIndieRetailer,
} from './retailers/indieStore.js';

const app = express();
app.use(express.json());

const recentEvents: FateDropEvent[] = [];

eventBus.subscribe(async (event) => {
  recentEvents.unshift(event);
  if (recentEvents.length > 200) recentEvents.pop();
  await dispatchNotifications(event);
});

app.get('/health', (_req, res) => {
  res.json({
    service: 'fatedrop-cloud',
    status: 'ok',
    time: new Date().toISOString(),
  });
});

app.get('/api/events', (_req, res) => {
  res.json({ events: recentEvents });
});

app.post('/api/true-price/calculate', (req, res) => {
  try {
    res.json(calculateTruePrice(req.body));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Invalid pricing input' });
  }
});

app.get('/api/notifications/devices', (_req, res) => {
  res.json({ devices: listDevices() });
});

app.post('/api/notifications/devices', (req, res) => {
  const { userId, expoPushToken, premium = false, preferences = {} } = req.body ?? {};

  if (!userId || !expoPushToken) {
    res.status(400).json({ error: 'userId and expoPushToken are required' });
    return;
  }

  const subscription = upsertDevice({
    userId,
    expoPushToken,
    premium: Boolean(premium),
    preferences: { ...defaultNotificationPreferences, ...preferences },
  });

  res.status(201).json(subscription);
});

app.delete('/api/notifications/devices/:token', (req, res) => {
  const removed = removeDevice(req.params.token);
  res.status(removed ? 204 : 404).end();
});

app.get('/api/indies', (_req, res) => {
  res.json({ retailers: listIndieRetailers() });
});

app.post('/api/indies', async (req, res) => {
  const { id, name, location, website, deliveryCost } = req.body ?? {};
  if (!id || !name) {
    res.status(400).json({ error: 'id and name are required' });
    return;
  }

  const retailer = await upsertIndieRetailer({ id, name, location, website, deliveryCost });
  res.status(201).json(retailer);
});

app.get('/api/indies/:retailerId/offers', (req, res) => {
  res.json({ offers: listIndieOffers(req.params.retailerId) });
});

app.put('/api/indies/:retailerId/offers/:productId', async (req, res) => {
  const { title, price, stockQuantity, preorder, deliveryCost, mandatoryFees } = req.body ?? {};

  if (!title || typeof price !== 'number' || typeof stockQuantity !== 'number') {
    res.status(400).json({ error: 'title, numeric price, and numeric stockQuantity are required' });
    return;
  }

  const offer = await upsertIndieOffer({
    retailerId: req.params.retailerId,
    productId: req.params.productId,
    title,
    price,
    stockQuantity,
    preorder,
    deliveryCost,
    mandatoryFees,
  });

  res.json(offer);
});

app.post('/api/dev/events', async (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    res.status(404).end();
    return;
  }

  const event: FateDropEvent = {
    id: crypto.randomUUID(),
    family: req.body.family ?? 'SYSTEM',
    type: req.body.type ?? 'TEST_EVENT',
    createdAt: new Date().toISOString(),
    retailerId: req.body.retailerId,
    productId: req.body.productId,
    severity: req.body.severity,
    payload: req.body.payload ?? {},
  };

  await eventBus.publish(event);
  res.status(202).json(event);
});

const port = Number(process.env.PORT ?? 8080);
app.listen(port, () => {
  console.log(`FateDrop Cloud listening on port ${port}`);
});
