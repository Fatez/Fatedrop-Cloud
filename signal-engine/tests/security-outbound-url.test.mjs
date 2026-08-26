import assert from "node:assert/strict";
import test from "node:test";

import { assertPublicHttpUrl, isForbiddenOutboundAddress, safeRetailerFetch } from "../src/security/outbound-url.mjs";

const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];

test("private, loopback, link-local and reserved addresses are blocked", () => {
  for (const address of [
    "127.0.0.1",
    "10.0.0.1",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "::1",
    "fc00::1",
    "fe80::1",
    "2001:db8::1",
  ]) {
    assert.equal(isForbiddenOutboundAddress(address), true, address);
  }
  assert.equal(isForbiddenOutboundAddress("93.184.216.34"), false);
});

test("outbound retailer URLs reject local hosts and credentials", async () => {
  await assert.rejects(assertPublicHttpUrl("http://localhost/admin", { lookup: publicLookup }), /host is not allowed/);
  await assert.rejects(assertPublicHttpUrl("http://127.0.0.1/admin", { lookup: publicLookup }), /non-public address/);
  await assert.rejects(assertPublicHttpUrl("http://169.254.169.254/latest/meta-data", { lookup: publicLookup }), /non-public address/);
  await assert.rejects(assertPublicHttpUrl("https://user:pass@example.com/catalogue", { lookup: publicLookup }), /credentials are not allowed/);
  await assert.rejects(assertPublicHttpUrl("file:///etc/passwd", { lookup: publicLookup }), /protocol is not allowed/);
});

test("DNS answers fail closed if any resolved address is private", async () => {
  const lookup = async () => [
    { address: "93.184.216.34", family: 4 },
    { address: "10.0.0.7", family: 4 },
  ];
  await assert.rejects(assertPublicHttpUrl("https://retailer.example.com/products", { lookup }), /non-public address/);
});

test("public HTTP and HTTPS retailer URLs are accepted", async () => {
  const https = await assertPublicHttpUrl("https://retailer.example/products", { lookup: publicLookup });
  const http = await assertPublicHttpUrl("http://retailer.example/products", { lookup: publicLookup });
  assert.equal(https.protocol, "https:");
  assert.equal(http.protocol, "http:");
});

test("safe retailer fetch revalidates redirects and blocks private redirect targets", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return new Response(null, {
      status: 302,
      headers: { location: "http://169.254.169.254/latest/meta-data" },
    });
  };

  await assert.rejects(
    safeRetailerFetch("https://retailer.example/products", {}, { fetchImpl, lookup: publicLookup }),
    (error) => error?.code === "unsafe_outbound_url",
  );
  assert.equal(calls, 1);
});

test("safe retailer fetch follows a bounded public redirect", async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url);
    if (seen.length === 1) return new Response(null, { status: 302, headers: { location: "/products.json" } });
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };

  const response = await safeRetailerFetch("https://retailer.example/start", {}, { fetchImpl, lookup: publicLookup });
  assert.equal(response.status, 200);
  assert.equal(seen.length, 2);
  assert.equal(seen[1], "https://retailer.example/products.json");
});