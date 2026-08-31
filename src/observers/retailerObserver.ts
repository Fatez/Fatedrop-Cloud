export interface RetailerProductSnapshot {
  externalId?: string;
  sku?: string;
  url: string;
  title?: string;
  availability?: string;
  price?: number;
  currency?: string;
  preorder?: boolean;
}

export interface RetailerSnapshot {
  retailerId: string;
  observedAt: string;
  queue?: {
    active: boolean;
    evidence?: string;
  };
  products: RetailerProductSnapshot[];
  catalogueFingerprint?: string;
}

export interface RetailerObserver {
  retailerId: string;
  observe(): Promise<RetailerSnapshot>;
}
