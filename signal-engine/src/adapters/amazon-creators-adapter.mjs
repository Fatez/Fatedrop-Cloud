import { env } from "../config/env.mjs";
import { recordCatalogueYield } from "../telemetry/catalogue-yield-context.mjs";
import { normalizeAmazonCreatorsSearchPayload } from "./amazon-creators-normalizer.mjs";

const AMAZON_CREATORS_API_URL = "https://creatorsapi.amazon/catalog/v1/searchItems";
const AMAZON_UK_MARKETPLACE = "www.amazon.co.uk";
const TOKEN_SAFETY_WINDOW_MS = 60_000;
const tokenCache = new Map();

const SEARCH_RESOURCES = Object.freeze([
  "images.primary.large",
  "images.primary.medium",
  "itemInfo.title",
  "offersV2.listings.availability",
  "offersV2.listings.condition",
  "offersV2.listings.isBuyBoxWinner",
  "offersV2.listings.merchantInfo",
  "offersV2.listings.price",
]);

function credentialMajor(version) {
  const major = Number.parseInt(String(version || "3.2").split(".")[0], 10);
  return major === 2 ? 2 : 3;
}

export function tokenEndpointForCredentialVersion(version = "3.2") {
  return credentialMajor(version) === 2
    ? "https://creatorsapi.auth.eu-south-2.amazoncognito.com/oauth2/token"
    : "https://api.amazon.co.uk/auth/o2/token";
}

function amazonError(message, code, status = null) {
  const error = new Error(message);
  error.code = code;
  if (Number.isFinite(status)) error.status = status;
  return error;
}

async function readJsonResponse(response, kind) {
  let payload;
  try { payload = await response.json(); }
  catch { throw amazonError(`${kind} returned invalid JSON`, "amazon_creators_invalid_json", response?.status); }

  if (response.status === 429) throw amazonError(`${kind} rate limited by Amazon`, "amazon_creators_rate_limited", 429);
  if (response.status === 401 || response.status === 403) {
    throw amazonError(`${kind} rejected Amazon Creators API credentials or access`, "amazon_creators_access_denied", response.status);
  }
  if (!response.ok) throw amazonError(`${kind} failed (${response.status})`, "amazon_creators_request_failed", response.status);
  if (Array.isArray(payload?.errors) && payload.errors.length) {
    const detail = payload.errors.map((entry) => entry?.message || entry?.code).filter(Boolean).join("; ");
    throw amazonError(`${kind} returned API errors${detail ? `: ${detail}` : ""}`, "amazon_creators_api_error", response.status);
  }
  return payload;
}

function tokenCacheKey({ clientId, credentialVersion }) {
  return `${String(credentialVersion || "3.2").trim()}::${String(clientId || "").trim()}`;
}

export function clearAmazonCreatorsTokenCacheForTest() {
  tokenCache.clear();
}

export async function fetchAmazonCreatorsAccessToken({
  clientId,
  clientSecret,
  credentialVersion = "3.2",
  fetchImpl = globalThis.fetch,
  now = Date.now,
} = {}) {
  if (!clientId || !clientSecret) throw amazonError("Amazon Creators API credentials are not configured", "amazon_creators_credentials_required");
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");

  const key = tokenCacheKey({ clientId, credentialVersion });
  const nowMs = Number(now());
  const cached = tokenCache.get(key);
  if (cached?.accessToken && cached.expiresAt - TOKEN_SAFETY_WINDOW_MS > nowMs) return cached.accessToken;

  const major = credentialMajor(credentialVersion);
  const url = tokenEndpointForCredentialVersion(credentialVersion);
  let body;
  let headers;
  if (major === 2) {
    body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
      scope: "creatorsapi/default",
    }).toString();
    headers = { "content-type": "application/x-www-form-urlencoded" };
  } else {
    body = JSON.stringify({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
      scope: "creatorsapi::default",
    });
    headers = { "content-type": "application/json" };
  }

  const response = await fetchImpl(url, { method: "POST", headers, body });
  const payload = await readJsonResponse(response, "Amazon Creators token request");
  const accessToken = String(payload?.access_token || "").trim();
  const expiresInSeconds = Number(payload?.expires_in);
  if (!accessToken) throw amazonError("Amazon Creators token response did not include an access token", "amazon_creators_token_missing");
  const expiresAt = nowMs + (Number.isFinite(expiresInSeconds) && expiresInSeconds > 0 ? expiresInSeconds * 1000 : 3600_000);
  tokenCache.set(key, { accessToken, expiresAt });
  return accessToken;
}

export async function searchAmazonCreatorsItems({
  keywords,
  accessToken,
  partnerTag,
  marketplace = AMAZON_UK_MARKETPLACE,
  credentialVersion = "3.2",
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!keywords) throw new TypeError("keywords are required");
  if (!accessToken) throw amazonError("Amazon Creators access token is required", "amazon_creators_token_required");
  if (!partnerTag) throw amazonError("Amazon Creators partner tag is required", "amazon_creators_partner_tag_required");
  if (marketplace !== AMAZON_UK_MARKETPLACE) throw amazonError("Amazon shadow lane currently supports the UK marketplace only", "amazon_creators_marketplace_not_supported");

  const major = credentialMajor(credentialVersion);
  const authorization = major === 2
    ? `Bearer ${accessToken}, Version ${credentialVersion}`
    : `Bearer ${accessToken}`;
  const body = {
    keywords: String(keywords),
    searchIndex: "ToysAndGames",
    availability: "IncludeOutOfStock",
    condition: "New",
    marketplace,
    partnerTag,
    languagesOfPreference: ["en_GB"],
    currencyOfPreference: "GBP",
    resources: [...SEARCH_RESOURCES],
  };
  const response = await fetchImpl(AMAZON_CREATORS_API_URL, {
    method: "POST",
    headers: {
      authorization,
      "content-type": "application/json",
      "x-marketplace": marketplace,
    },
    body: JSON.stringify(body),
  });
  return readJsonResponse(response, "Amazon Creators SearchItems request");
}

function matches(pattern, value) {
  if (!pattern) return true;
  pattern.lastIndex = 0;
  return pattern.test(value);
}

function acceptedByRetailerFilters(product, retailer) {
  const value = `${product?.title || ""} ${product?.url || ""}`;
  if (!matches(retailer?.include, value)) return false;
  if (!retailer?.exclude) return true;
  retailer.exclude.lastIndex = 0;
  return !retailer.exclude.test(value);
}

export async function scanAmazonCreatorsCatalogue(retailer, {
  fetchImpl = globalThis.fetch,
  credentials = env.amazonCreators,
  now = Date.now,
} = {}) {
  if (retailer?.adapterType !== "structured_feed" || retailer?.catalogue?.provider !== "amazon_creators_api") {
    throw new Error("Amazon Creators scanner requires the explicit amazon_creators_api structured feed provider");
  }
  if (!credentials?.configured) throw amazonError("Amazon Creators API credentials are not configured", "amazon_creators_credentials_required");

  const marketplace = retailer.catalogue.marketplace || credentials.marketplace || AMAZON_UK_MARKETPLACE;
  if (marketplace !== AMAZON_UK_MARKETPLACE) throw amazonError("Amazon shadow lane currently supports the UK marketplace only", "amazon_creators_marketplace_not_supported");
  const searchTerms = Array.isArray(retailer.catalogue.searchTerms) ? retailer.catalogue.searchTerms.filter(Boolean) : [];
  if (!searchTerms.length) throw new Error("Amazon Creators scanner requires at least one configured search term");

  const accessToken = await fetchAmazonCreatorsAccessToken({
    clientId: credentials.clientId,
    clientSecret: credentials.clientSecret,
    credentialVersion: credentials.credentialVersion,
    fetchImpl,
    now,
  });

  const found = new Map();
  const pages = [];
  let rawProductsSeen = 0;
  let normalizedProductsSeen = 0;
  let filteredOutProducts = 0;
  for (const keywords of searchTerms) {
    const payload = await searchAmazonCreatorsItems({
      keywords,
      accessToken,
      partnerTag: credentials.partnerTag,
      marketplace,
      credentialVersion: credentials.credentialVersion,
      fetchImpl,
    });
    const rawCount = Array.isArray(payload?.searchResult?.items) ? payload.searchResult.items.length : 0;
    const observedAt = new Date(Number(now()));
    const normalized = normalizeAmazonCreatorsSearchPayload(payload, retailer, { observedAt });
    const accepted = normalized.filter((product) => acceptedByRetailerFilters(product, retailer));
    rawProductsSeen += rawCount;
    normalizedProductsSeen += normalized.length;
    filteredOutProducts += normalized.length - accepted.length;
    for (const product of accepted) found.set(product.retailerSku, product);
    pages.push({
      query: keywords,
      discovered: accepted.length,
      rawCount,
      normalizedCount: normalized.length,
      filteredOut: normalized.length - accepted.length,
      status: 200,
    });
  }

  const discovery = {
    rawProductsSeen,
    normalizedProductsSeen,
    filteredOutProducts,
    acceptedProductsSeen: found.size,
    pageLimitReached: false,
  };
  recordCatalogueYield(retailer.id, discovery);
  return {
    products: [...found.values()],
    pages,
    complete: true,
    partialCatalogue: false,
    provider: "amazon_creators_api",
    retentionClass: "ephemeral_offer",
    ...discovery,
  };
}

export const __test = {
  AMAZON_CREATORS_API_URL,
  AMAZON_UK_MARKETPLACE,
  SEARCH_RESOURCES,
  credentialMajor,
  acceptedByRetailerFilters,
};
