import type { FateDropEvent } from '../events/eventBus.js';

export async function sendDiscordEvent(event: FateDropEvent): Promise<void> {
  if (process.env.FATESIGNAL_DISCORD_ENABLED !== 'true') return;

  const webhookUrl = process.env.DISCORD_FATESIGNAL_WEBHOOK_URL;
  if (!webhookUrl) return;

  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      embeds: [
        {
          title: `FateDrop — ${event.type.replaceAll('_', ' ')}`,
          description: event.payload && Object.keys(event.payload).length
            ? 'A FateDrop event has been detected.'
            : undefined,
          timestamp: event.createdAt,
          fields: [
            ...(event.retailerId ? [{ name: 'Retailer', value: event.retailerId, inline: true }] : []),
            ...(event.productId ? [{ name: 'Product', value: event.productId, inline: true }] : []),
            ...(event.severity ? [{ name: 'Severity', value: event.severity, inline: true }] : []),
          ],
        },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`Discord webhook failed with status ${response.status}`);
  }
}
