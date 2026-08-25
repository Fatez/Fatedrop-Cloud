import fs from "node:fs/promises";
import path from "node:path";

const EMPTY = { version: 1, products: {}, offers: {}, observations: [], signals: [], retailers: {}, encounters: {}, encounterVendors: {}, encounterInventory: {}, networkSnapshots: [], metadata: { baselineCompleted: {} } };

export class FileStore {
  constructor(filePath) { this.filePath = filePath; this.writeQueue = Promise.resolve(); }
  async read() {
    try { return JSON.parse(await fs.readFile(this.filePath, "utf8")); }
    catch (error) { if (error.code === "ENOENT") return structuredClone(EMPTY); throw error; }
  }
  async mutate(fn) {
    // A rejected mutation must reject its own caller without permanently
    // poisoning the serial write queue. The failed state is never written, and
    // the next mutation starts from the last successfully persisted snapshot.
    const operation = this.writeQueue
      .catch(() => undefined)
      .then(async () => {
        const state = await this.read();
        const result = await fn(state);
        await fs.mkdir(path.dirname(this.filePath), { recursive: true });
        const temp = `${this.filePath}.tmp`;
        await fs.writeFile(temp, `${JSON.stringify(state, null, 2)}\n`);
        await fs.rename(temp, this.filePath);
        return result;
      });
    this.writeQueue = operation.catch(() => undefined);
    return operation;
  }
  async getOffer(offerId) { return (await this.read()).offers[offerId] || null; }
  async getProduct(productId) { return (await this.read()).products[productId] || null; }
  async listOffers({ limit = 5000 } = {}) {
    const state = await this.read();
    return Object.values(state.offers || {}).sort((a, b) => (b.lastSeenAt || 0) - (a.lastSeenAt || 0)).slice(0, Math.min(10000, Math.max(1, limit)));
  }
  async listProducts({ rrpSource = null, limit = 2000 } = {}) {
    const state = await this.read();
    return Object.values(state.products || {}).filter((product) => !rrpSource || product.rrpSource === rrpSource).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, Math.min(5000, Math.max(1, limit)));
  }
  async isBaselineComplete(retailerId) { return Boolean((await this.read()).metadata?.baselineCompleted?.[retailerId]); }
  async saveScan({ retailer, products, offers, observations, signals, completedAt, health }) {
    return this.mutate((state) => {
      state.products ||= {}; state.offers ||= {}; state.observations ||= []; state.signals ||= []; state.retailers ||= {}; state.metadata ||= { baselineCompleted: {} }; state.metadata.baselineCompleted ||= {};
      for (const product of products) state.products[product.id] = product;
      for (const offer of offers) state.offers[offer.offerId] = offer;
      state.observations.push(...observations); state.signals.push(...signals);
      if (state.observations.length > 100000) state.observations = state.observations.slice(-100000);
      if (state.signals.length > 20000) state.signals = state.signals.slice(-20000);
      state.retailers[retailer.id] = { id: retailer.id, name: retailer.name, ...health, lastScanAt: completedAt };
      state.metadata.baselineCompleted[retailer.id] = true;
    });
  }
  async appendSignals(signals) {
    return this.mutate((state) => {
      state.signals ||= [];
      const existing = new Set(state.signals.map((signal) => signal.id));
      for (const signal of signals || []) if (!existing.has(signal.id)) state.signals.push(signal);
      if (state.signals.length > 20000) state.signals = state.signals.slice(-20000);
    });
  }
  async recordFailure(retailer, error, now) {
    return this.mutate((state) => { state.retailers ||= {}; state.retailers[retailer.id] = { ...(state.retailers[retailer.id] || {}), id: retailer.id, name: retailer.name, healthy: false, lastError: String(error?.message || error), lastErrorAt: now }; });
  }
  async listSignals({ states = [], retailerIds = [], since = 0, limit = 100 } = {}) {
    const state = await this.read();
    return (state.signals || []).filter((signal) => signal.detectedAt >= since).filter((signal) => !states.length || states.includes(signal.state)).filter((signal) => !retailerIds.length || retailerIds.includes(signal.retailerId)).sort((a, b) => b.detectedAt - a.detectedAt).slice(0, limit);
  }
  async listRetailers() { return Object.values((await this.read()).retailers || {}); }
  async upsertEncounters(events = []) {
    return this.mutate((state) => {
      state.encounters ||= {};
      for (const event of events) state.encounters[event.id] = event;
      return { saved: events.length };
    });
  }
  async listEncounters({ from = null, to = null, tcgs = [], limit = 1000 } = {}) {
    const state = await this.read();
    const fromTime = from ? Date.parse(from) : 0;
    const toTime = to ? Date.parse(to) : Number.POSITIVE_INFINITY;
    const wanted = tcgs.map((value) => String(value).toLowerCase());
    return Object.values(state.encounters || {})
      .filter((event) => {
        const start = Date.parse(event.startDateTime);
        if (!Number.isFinite(start) || start < fromTime || start > toTime) return false;
        if (!wanted.length) return true;
        const supported = (event.supportedTcgs || []).map((value) => String(value).toLowerCase());
        return supported.some((value) => wanted.includes(value) || value === "all" || value === "all tcg");
      })
      .sort((a, b) => Date.parse(a.startDateTime) - Date.parse(b.startDateTime))
      .slice(0, Math.min(2000, Math.max(1, limit)));
  }
  async upsertEncounterVendors(vendors = []) {
    return this.mutate((state) => {
      state.encounterVendors ||= {};
      for (const vendor of vendors) state.encounterVendors[vendor.id] = vendor;
      return { saved: vendors.length };
    });
  }
  async listEncounterVendors(eventId) {
    const state = await this.read();
    return Object.values(state.encounterVendors || {})
      .filter((vendor) => vendor.eventId === eventId)
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  async upsertEncounterInventory(items = []) {
    return this.mutate((state) => {
      state.encounterInventory ||= {};
      for (const item of items) state.encounterInventory[item.id] = item;
      return { saved: items.length };
    });
  }
  async listEncounterInventory(eventId) {
    const state = await this.read();
    const now = Date.now();
    return Object.values(state.encounterInventory || {})
      .filter((item) => item.eventId === eventId)
      .filter((item) => !item.expiresAt || Date.parse(item.expiresAt) > now)
      .sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt));
  }
  async recordNetworkSnapshot(snapshot) { return this.mutate((state) => { state.networkSnapshots ||= []; if (!state.networkSnapshots.some((item) => item.id === snapshot.id)) state.networkSnapshots.push(snapshot); state.networkSnapshots = state.networkSnapshots.sort((a, b) => a.measuredAt - b.measuredAt).slice(-2000); }); }
  async listNetworkSnapshots(limit = 30) { const state = await this.read(); return [...(state.networkSnapshots || [])].sort((a, b) => b.measuredAt - a.measuredAt).slice(0, Math.min(180, Math.max(1, limit))); }
  async stats() {
    const state = await this.read(); const offers = Object.values(state.offers || {}); const now = Math.floor(Date.now() / 1000); const last24h = (state.signals || []).filter((s) => s.detectedAt >= now - 86400);
    return { productsTracked:Object.keys(state.products||{}).length,offersTracked:offers.length,currentlyAvailable:offers.filter((offer)=>["in_stock","low_stock"].includes(offer.stockStatus)).length,signals24h:last24h.length,manifested24h:last24h.filter((s)=>s.state==="manifested").length,echo24h:last24h.filter((s)=>s.state==="echo").length,vanished24h:last24h.filter((s)=>s.state==="vanished").length,whisper24h:last24h.filter((s)=>s.state==="whisper").length };
  }
}
