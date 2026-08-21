import { eventBus } from '../events/eventBus.js';

export interface IndieRetailer {
  id: string;
  name: string;
  location?: string;
  website?: string;
  deliveryCost?: number;
  joinedAt: string;
  updatedAt: string;
}

export interface IndieOffer {
  retailerId: string;
  productId: string;
  title: string;
  price: number;
  stockQuantity: number;
  preorder?: boolean;
  deliveryCost?: number;
  mandatoryFees?: number;
  updatedAt: string;
}

const retailers = new Map<string, IndieRetailer>();
const offers = new Map<string, IndieOffer>();

function offerKey(retailerId: string, productId: string): string {
  return `${retailerId}:${productId}`;
}

export async function upsertIndieRetailer(input: Omit<IndieRetailer, 'joinedAt' | 'updatedAt'>): Promise<IndieRetailer> {
  const existing = retailers.get(input.id);
  const now = new Date().toISOString();
  const retailer: IndieRetailer = {
    ...input,
    joinedAt: existing?.joinedAt ?? now,
    updatedAt: now,
  };

  retailers.set(retailer.id, retailer);

  if (!existing) {
    await eventBus.publish({
      id: crypto.randomUUID(),
      family: 'NETWORK',
      type: 'INDIE_JOINED',
      createdAt: now,
      retailerId: retailer.id,
      severity: 'MEDIUM',
      payload: { name: retailer.name, location: retailer.location, website: retailer.website },
    });
  }

  return retailer;
}

export async function upsertIndieOffer(input: Omit<IndieOffer, 'updatedAt'>): Promise<IndieOffer> {
  const key = offerKey(input.retailerId, input.productId);
  const existing = offers.get(key);
  const now = new Date().toISOString();
  const offer: IndieOffer = { ...input, updatedAt: now };
  offers.set(key, offer);

  if (existing && existing.stockQuantity !== offer.stockQuantity) {
    await eventBus.publish({
      id: crypto.randomUUID(),
      family: 'NETWORK',
      type: 'INDIE_STOCK_CHANGED',
      createdAt: now,
      retailerId: offer.retailerId,
      productId: offer.productId,
      severity: offer.stockQuantity > 0 ? 'MEDIUM' : 'LOW',
      payload: {
        title: offer.title,
        previousStock: existing.stockQuantity,
        stockQuantity: offer.stockQuantity,
        price: offer.price,
      },
    });
  }

  return offer;
}

export function listIndieRetailers(): IndieRetailer[] {
  return [...retailers.values()];
}

export function listIndieOffers(retailerId?: string): IndieOffer[] {
  return [...offers.values()].filter((offer) => !retailerId || offer.retailerId === retailerId);
}
