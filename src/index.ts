import express from 'express';
import { eventBus, type FateDropEvent } from './events/eventBus.js';
import { sendDiscordEvent } from './notifications/discord.js';
import { calculateTruePrice } from './pricing/truePrice.js';

const app = express();
app.use(express.json());

const recentEvents: FateDropEvent[] = [];

eventBus.subscribe(async (event) => {
  recentEvents.unshift(event);
  if (recentEvents.length > 200) recentEvents.pop();
  await sendDiscordEvent(event);
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
