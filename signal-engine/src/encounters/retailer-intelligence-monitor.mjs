import crypto from "node:crypto";

import { load } from "cheerio";

import { parseRetailerIntelligenceSurface } from "./retailer-intelligence-parser.mjs";
import { reconcileRetailerIntelligenceSurfaceSnapshot } from "./retailer-intelligence-surfaces.mjs";

const SURFACE = Object.freeze({
  surfaceId: "entertainer-pokemon-drop-hub",
  retailerId: "entertainer-uk",
  sourceUrl: "https://www.thetoyshop.com/pokemon-at-the-entertainer",
});

const BLOCK_PAGE = /access denied|attention required|captcha|verify you are human|unusual traffic|temporarily blocked|cf-chl-/i;
const BLOCK_ELEMENTS = "address,article,aside,blockquote,br,dd,div,dl,dt,figcaption,figure,footer,h1,h2,h3,h4,h5,h6,header,li,main,nav,p,section,table,tbody,td,tfoot,th,thead,tr,ul,ol";

function clean(value, max = 1_000) {
  const text = String(value ?? "").replace(/\u00a0/g, " ").replace(/[\t ]+/g, " ").trim();
  return text ? text.slice(0, max) : "";
}

export function extractRetailerIntelligenceDocument(html, sourceUrl = SURFACE.sourceUrl) {
  const $ = load(String(html || ""));
  $("script,style,noscript,template,svg").remove();

  const pageTitle = clean($("title").first().text(), 240);
  const headings = $("h1,h2,h3,h4").map((_, node) => clean($(node).text(), 500)).get().filter(Boolean);
  const links = $("a[href]").map((_, node) => {
    const href = clean($(node).attr("href"), 1_000);
    try {
      return { text: clean($(node).text(), 300), href: new URL(href, sourceUrl).toString() };
    } catch {
      return null;
    }
  }).get().filter(Boolean);
  const images = $("img[src]").map((_, node) => {
    const src = clean($(node).attr("src"), 1_000);
    try {
      return { alt: clean($(node).attr("alt"), 300), src: new URL(src, sourceUrl).toString() };
    } catch {
      return null;
    }
  }).get().filter(Boolean);

  $(BLOCK_ELEMENTS).each((_, node) => {
    $(node).prepend("\n").append("\n");
  });
  const renderedText = $("body").text()
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => clean(line, 2_000))
    .filter(Boolean)
    .join("\n");

  return { renderedText, pageTitle, headings, links, images };
}

function validFinalUrl(value) {
  if (!value) return true;
  try {
    const url = new URL(value);
    return ["thetoyshop.com", "www.thetoyshop.com"].includes(url.hostname)
      && url.pathname.replace(/\/$/, "") === "/pokemon-at-the-entertainer";
  } catch {
    return false;
  }
}

export async function captureRetailerIntelligenceSurface({
  fetchImpl = fetch,
  timeoutMs = 15_000,
  userAgent = "FateDrop/0.1 (+https://fate-drop.com; retailer-intelligence-monitor)",
  observedAt = new Date().toISOString(),
} = {}) {
  const response = await fetchImpl(SURFACE.sourceUrl, {
    redirect: "follow",
    headers: {
      accept: "text/html,application/xhtml+xml",
      "user-agent": userAgent,
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (response.status !== 200) throw new Error(`Retailer intelligence HTTP ${response.status}; snapshot held`);
  if (!validFinalUrl(response.url)) throw new Error("Retailer intelligence redirected away from the allowlisted surface; snapshot held");
  const contentType = String(response.headers?.get?.("content-type") || "");
  if (contentType && !/text\/html|application\/xhtml\+xml/i.test(contentType)) {
    throw new Error(`Retailer intelligence returned ${contentType}; snapshot held`);
  }
  const declaredBytes = Number(response.headers?.get?.("content-length") || 0);
  if (declaredBytes > 2_000_000) throw new Error("Retailer intelligence response exceeded the size limit; snapshot held");
  const html = await response.text();
  if (!html || Buffer.byteLength(html, "utf8") > 2_000_000) throw new Error("Retailer intelligence response was empty or oversized; snapshot held");
  if (BLOCK_PAGE.test(html)) throw new Error("Retailer intelligence access challenge detected; snapshot held");

  const document = extractRetailerIntelligenceDocument(html);
  const parsed = parseRetailerIntelligenceSurface({ surfaceId: SURFACE.surfaceId, ...document });
  if (!parsed.products.length) {
    throw new Error(`Retailer intelligence produced no branch-addressable products (${parsed.warnings.join(",") || "unclassified"}); snapshot held`);
  }
  if (!parsed.availabilityDisclaimerPresent) {
    throw new Error("Retailer intelligence availability disclaimer was not detected; snapshot held");
  }

  return {
    ...SURFACE,
    observedAt,
    pageTitle: document.pageTitle,
    campaignTitle: parsed.campaignTitle,
    availabilityDisclaimerPresent: parsed.availabilityDisclaimerPresent,
    storeSearchSemantics: parsed.storeSearchSemantics,
    warnings: parsed.warnings,
    publicHttp: {
      status: response.status,
      etag: response.headers?.get?.("etag") || null,
      lastModified: response.headers?.get?.("last-modified") || null,
      bodySha256: crypto.createHash("sha256").update(html).digest("hex"),
      body: html,
    },
    products: parsed.products,
  };
}

export async function monitorRetailerIntelligenceSurface({ store, fetchImpl = fetch, now = Date.now() } = {}) {
  if (!store) throw new Error("Retailer intelligence monitor requires a store");
  const snapshot = await captureRetailerIntelligenceSurface({ fetchImpl, observedAt: new Date(now).toISOString() });
  return reconcileRetailerIntelligenceSurfaceSnapshot({ store, snapshot, now });
}
