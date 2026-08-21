export type FateDropEventFamily = 'SIGNAL' | 'STOCK' | 'NETWORK' | 'SYSTEM';

export interface FateDropEvent<TPayload = Record<string, unknown>> {
  id: string;
  family: FateDropEventFamily;
  type: string;
  createdAt: string;
  retailerId?: string;
  productId?: string;
  severity?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  payload: TPayload;
}

type EventHandler = (event: FateDropEvent) => Promise<void> | void;

export class EventBus {
  private readonly handlers = new Set<EventHandler>();

  subscribe(handler: EventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async publish(event: FateDropEvent): Promise<void> {
    await Promise.allSettled([...this.handlers].map((handler) => handler(event)));
  }
}

export const eventBus = new EventBus();
