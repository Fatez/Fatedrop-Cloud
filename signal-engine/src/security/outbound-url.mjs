import dns from "node:dns/promises";
import net from "node:net";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function securityError(message) {
  const error = new Error(message);
  error.code = "unsafe_outbound_url";
  return error;
}

function forbiddenIpv4(address) {
  const parts = String(address).split(".").map(Number);
  if (parts.length !== 4 || parts.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return true;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0) return true;
  if (a === 192 && b === 0 && parts[2] === 2) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51 && parts[2] === 100) return true;
  if (a === 203 && b === 0 && parts[2] === 113) return true;
  if (a >= 224) return true;
  return false;
}

function forbiddenIpv6(address) {
  const normalized = String(address).toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "::" || normalized === "::1") return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  if (/^fe[89ab]/.test(normalized)) return true;
  if (normalized.startsWith("ff")) return true;
  if (normalized.startsWith("2001:db8:")) return true;
  if (normalized.startsWith("::ffff:")) {
    const mapped = normalized.slice("::ffff:".length);
    if (net.isIP(mapped) === 4) return forbiddenIpv4(mapped);
  }
  return false;
}

export function isForbiddenOutboundAddress(address) {
  const version = net.isIP(String(address).replace(/^\[|\]$/g, ""));
  if (version === 4) return forbiddenIpv4(address);
  if (version === 6) return forbiddenIpv6(address);
  return true;
}

function forbiddenHostname(hostname) {
  const value = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  return value === "localhost"
    || value.endsWith(".localhost")
    || value.endsWith(".local")
    || value.endsWith(".internal");
}

export async function assertPublicHttpUrl(rawUrl, { lookup = dns.lookup } = {}) {
  let url;
  try { url = new URL(String(rawUrl || "")); }
  catch { throw securityError("Outbound retailer URL is invalid"); }

  if (!['http:', 'https:'].includes(url.protocol)) throw securityError("Outbound retailer URL protocol is not allowed");
  if (url.username || url.password) throw securityError("Outbound retailer URL credentials are not allowed");
  if (!url.hostname || forbiddenHostname(url.hostname)) throw securityError("Outbound retailer URL host is not allowed");

  const literal = url.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(literal)) {
    if (isForbiddenOutboundAddress(literal)) throw securityError("Outbound retailer URL resolves to a non-public address");
    return url;
  }

  let addresses;
  try { addresses = await lookup(literal, { all: true, verbatim: true }); }
  catch { throw securityError("Outbound retailer URL host could not be resolved safely"); }
  if (!Array.isArray(addresses) || !addresses.length) throw securityError("Outbound retailer URL host has no public address");
  if (addresses.some((row) => isForbiddenOutboundAddress(row?.address))) {
    throw securityError("Outbound retailer URL resolves to a non-public address");
  }
  return url;
}

export async function safeRetailerFetch(rawUrl, options = {}, {
  fetchImpl = fetch,
  lookup = dns.lookup,
  maxRedirects = 5,
} = {}) {
  let current = await assertPublicHttpUrl(rawUrl, { lookup });
  const safeMaxRedirects = Math.max(0, Math.min(10, Number(maxRedirects) || 0));

  for (let redirects = 0; ; redirects += 1) {
    const response = await fetchImpl(current.toString(), { ...options, redirect: "manual" });
    if (!REDIRECT_STATUSES.has(response.status)) return response;
    if (redirects >= safeMaxRedirects) throw securityError("Outbound retailer URL exceeded the redirect limit");
    const location = response.headers.get("location");
    if (!location) throw securityError("Outbound retailer redirect omitted a location");
    current = await assertPublicHttpUrl(new URL(location, current).toString(), { lookup });
  }
}
