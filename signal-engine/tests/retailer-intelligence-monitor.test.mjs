import assert from "node:assert/strict";
import test from "node:test";

import {
  captureRetailerIntelligenceSurface,
  extractRetailerIntelligenceDocument,
} from "../src/encounters/retailer-intelligence-monitor.mjs";

const html = `<!doctype html>
<html><head><title>Pokémon at The Entertainer</title></head><body>
<h1>Pokémon 30th Celebration</h1>
<p>Stock is limited. We cannot guarantee a selected store will have stock upon arrival.</p>
<section>
  <h2>Pokémon TCG: Elite Trainer Box - 30th Celebration</h2>
  <p>Released: September 16th</p><p>Group A</p>
  <p>You may only purchase 1 item from Group A</p>
  <a href="/store/watford">The Entertainer Watford</a>
  <p>Only stores listed will receive limited stock</p>
</section>
</body></html>`;

function response(body = html, { status = 200, contentType = "text/html", url = "https://www.thetoyshop.com/pokemon-at-the-entertainer" } = {}) {
  return {
    status,
    url,
    headers: { get(name) { return name.toLowerCase() === "content-type" ? contentType : null; } },
    async text() { return body; },
  };
}

test("ordinary HTML capture preserves exact allocation evidence without a browser", async () => {
  const document = extractRetailerIntelligenceDocument(html);
  assert.match(document.renderedText, /The Entertainer Watford/);
  assert.equal(document.links[0].href, "https://www.thetoyshop.com/store/watford");

  const snapshot = await captureRetailerIntelligenceSurface({
    fetchImpl: async () => response(),
    observedAt: "2026-09-01T12:00:00Z",
  });
  assert.equal(snapshot.products.length, 1);
  assert.equal(snapshot.products[0].allocationGroup, "Group A");
  assert.equal(snapshot.products[0].branchTargets[0].name, "The Entertainer Watford");
  assert.equal(snapshot.availabilityDisclaimerPresent, true);
  assert.equal(snapshot.publicHttp.status, 200);
  assert.equal(snapshot.publicHttp.body, html);
  assert.match(snapshot.publicHttp.bodySha256, /^[a-f0-9]{64}$/);
});

test("access challenges, redirects and incomplete pages fail closed", async () => {
  await assert.rejects(
    captureRetailerIntelligenceSurface({ fetchImpl: async () => response("Verify you are human") }),
    /challenge detected/,
  );
  await assert.rejects(
    captureRetailerIntelligenceSurface({ fetchImpl: async () => response(html, { url: "https://challenge.example/" }) }),
    /redirected away/,
  );
  await assert.rejects(
    captureRetailerIntelligenceSurface({ fetchImpl: async () => response("<html><body>Nothing here</body></html>") }),
    /no branch-addressable products/,
  );
});
