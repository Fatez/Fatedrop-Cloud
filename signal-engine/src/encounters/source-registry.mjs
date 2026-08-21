const DAY_MS = 24 * 60 * 60 * 1000;

const RAW_SOURCES = [
  { id: 'uk-card-shows', name: 'UK Card Shows', url: 'https://www.ukcardshows.co.uk/', category: 'official_organiser', regions: ['UK'], reviewEveryDays: 2 },
  { id: 'card-con', name: 'Card Con', url: 'https://www.card-con.co.uk/', category: 'official_organiser', regions: ['UK'], reviewEveryDays: 3 },
  { id: 'the-card-show-uk', name: 'The Card Show UK', url: 'https://thecardshowuk.co.uk/', category: 'official_organiser', regions: ['UK'], reviewEveryDays: 3 },
  { id: 'cardmania', name: 'Cardmania Events', url: 'https://www.cardmania.co.uk/', category: 'official_organiser', regions: ['UK'], reviewEveryDays: 2 },
  { id: 'manchester-card-con', name: 'Manchester Card Con', url: 'https://manchestercardcon.com/', category: 'official_organiser', regions: ['North West England'], reviewEveryDays: 3 },
  { id: 'canterbury-card-show', name: 'Canterbury Card Show', url: 'https://www.eventbrite.com/o/canterbury-card-show-121066655560', category: 'official_ticketing', regions: ['South East England'], reviewEveryDays: 3 },
  { id: 'uk-card-expo', name: 'UKCardExpo', url: 'https://www.eventbrite.com/e/ukcardexpo-london-newest-tcg-trading-card-show-north-finchley-tickets-1993133510985', category: 'official_ticketing', regions: ['Greater London'], reviewEveryDays: 3 },
  { id: 'london-card-show', name: 'London Card Show', url: 'https://londoncardshow.co.uk/', category: 'official_organiser', regions: ['Greater London', 'South East England'], reviewEveryDays: 2 },
  { id: 'tap-and-play', name: 'Tap And Play', url: 'https://www.tapandplay.co.uk/', category: 'official_organiser', regions: ['South East England'], reviewEveryDays: 7 },
  { id: 'northern-card-shows', name: 'Northern Card Shows', url: 'https://www.northerncardshows.co.uk/events/', category: 'official_organiser', regions: ['England', 'Scotland', 'Wales'], reviewEveryDays: 2 },
  { id: 'striking-events', name: 'Striking Events', url: 'https://strikingshows.co.uk/2026-events/', category: 'official_organiser', regions: ['England'], reviewEveryDays: 2 },
  { id: 'card-market-events', name: 'Card Market Events', url: 'https://cardmarketevents.com/events/', category: 'official_organiser', regions: ['England', 'Wales'], reviewEveryDays: 2 },
  { id: 'collectors-showcase', name: 'Collectors Showcase', url: 'https://collectors-showcase.com/', category: 'official_organiser', regions: ['Greater London'], reviewEveryDays: 7 },
];

const ALLOWED_CATEGORIES = new Set(['official_organiser', 'official_ticketing', 'official_tcg', 'official_venue', 'authorised_feed']);
const BLOCKED_DIRECTORY_HOSTS = new Set(['cardshowfinder.uk', 'cardcompass.co.uk', 'tcgshowsnearme.com', 'reverseholo.app']);

function safeHttpsUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return null;
    return url;
  } catch {
    return null;
  }
}

export function validateEncounterSource(source = {}) {
  const errors = [];
  const id = String(source.id || '').trim();
  const name = String(source.name || '').trim();
  const url = safeHttpsUrl(source.url);
  if (!id || !/^[a-z0-9-]+$/.test(id)) errors.push('invalid_id');
  if (!name) errors.push('missing_name');
  if (!url) errors.push('invalid_url');
  if (!ALLOWED_CATEGORIES.has(source.category)) errors.push('invalid_category');
  if (url && BLOCKED_DIRECTORY_HOSTS.has(url.hostname.replace(/^www\./, '').toLowerCase())) errors.push('directory_not_source_of_truth');
  if (!Number.isInteger(source.reviewEveryDays) || source.reviewEveryDays < 1 || source.reviewEveryDays > 30) errors.push('invalid_review_interval');
  return { valid: errors.length === 0, errors };
}

export function encounterSourceRegistry() {
  const ids = new Set();
  return RAW_SOURCES.map((source) => {
    const validation = validateEncounterSource(source);
    if (!validation.valid) throw new Error(`Invalid Fate Encounters source ${source.id || '<unknown>'}: ${validation.errors.join(', ')}`);
    if (ids.has(source.id)) throw new Error(`Duplicate Fate Encounters source id: ${source.id}`);
    ids.add(source.id);
    return Object.freeze({
      ...source,
      regions: Object.freeze([...(source.regions || [])]),
      ingestionPolicy: 'manual_or_authorised_feed',
      stockEvidenceAllowed: false,
    });
  });
}

export function encounterSourceById(id) {
  return encounterSourceRegistry().find((source) => source.id === id) || null;
}

export function sourcesDueForReview({ lastReviewedById = {}, now = new Date() } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (!Number.isFinite(nowMs)) throw new Error('Invalid review time');
  return encounterSourceRegistry().filter((source) => {
    const reviewed = lastReviewedById[source.id];
    if (!reviewed) return true;
    const reviewedMs = new Date(reviewed).getTime();
    if (!Number.isFinite(reviewedMs)) return true;
    return nowMs - reviewedMs >= source.reviewEveryDays * DAY_MS;
  });
}

export const encounterSourcePolicy = Object.freeze({
  discoveryDirectoriesAreLeadsOnly: true,
  directoryHostsNotSourceOfTruth: Object.freeze([...BLOCKED_DIRECTORY_HOSTS]),
  automaticPageScrapingAllowed: false,
  authorisedFeedsAllowed: true,
  organiserSubmissionsAllowed: true,
  retailerSubmissionsAllowed: true,
  sourceVerificationNeverImpliesStock: true,
});
