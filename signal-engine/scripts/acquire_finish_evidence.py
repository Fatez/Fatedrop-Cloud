#!/usr/bin/env python3
"""Acquire raw finish evidence without mutating canonical card or price tables.

The runner deliberately separates acquisition from authorization. It emits SHA-256
pinned snapshots only. JavaScript normalization/classification code decides whether
an explicit provider field is admissible evidence.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import random
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

SCRYDEX_BASE = os.getenv("SCRYDEX_BASE_URL", "https://api.scrydex.com/pokemon/v1/en/cards").rstrip("/")
TCGPLAYER_BASE = os.getenv("TCGPLAYER_BASE_URL", "https://api.tcgplayer.com/v1.39.0").rstrip("/")
CARDMARKET_PRODUCTS = os.getenv("CARDMARKET_PRODUCTS_URL", "https://downloads.s3.cardmarket.com/productCatalog/productList/products_singles_6.json")
USER_AGENT = "FateDrop-FinishEvidence/1.2"
RETRY_HTTP = {408, 425, 429, 500, 502, 503, 504}


def canonical_json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def sha256_text(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _retry_delay(error: BaseException, attempt: int) -> float:
    if isinstance(error, urllib.error.HTTPError):
        retry_after = error.headers.get("Retry-After") if error.headers else None
        if retry_after:
            try:
                return min(60.0, max(0.0, float(retry_after)))
            except ValueError:
                pass
    return min(30.0, (0.75 * (2 ** attempt)) + random.uniform(0.0, 0.35))


def request_json(url: str, headers: dict[str, str] | None = None, timeout: int = 30, retries: int = 5) -> tuple[object, str, str]:
    req_headers = {"Accept": "application/json", "User-Agent": USER_AGENT}
    if headers:
        req_headers.update({k: v for k, v in headers.items() if v})
    last_error: BaseException | None = None
    for attempt in range(retries + 1):
        try:
            request = urllib.request.Request(url, headers=req_headers, method="GET")
            with urllib.request.urlopen(request, timeout=timeout) as response:
                body = response.read()
                if len(body) > 64 * 1024 * 1024:
                    raise RuntimeError("provider payload exceeds 64 MiB safety limit")
                raw = body.decode("utf-8-sig")
                return json.loads(raw), raw, hashlib.sha256(body).hexdigest()
        except urllib.error.HTTPError as error:
            last_error = error
            if error.code not in RETRY_HTTP or attempt >= retries:
                raise
        except (urllib.error.URLError, TimeoutError) as error:
            last_error = error
            if attempt >= retries:
                raise
        if last_error is not None:
            time.sleep(_retry_delay(last_error, attempt))
    raise RuntimeError(f"provider request failed: {last_error}")


def snapshot(provider: str, target: dict, source_locator: str, payload: object, *, artifact_sha256: str | None = None) -> dict:
    raw_payload = canonical_json(payload)
    observed_at = int(time.time() * 1000)
    request_fingerprint = sha256_text(canonical_json({
        "provider": provider,
        "cardIdentityId": target["cardIdentityId"],
        "sourceLocator": source_locator,
    }))
    return {
        "provider": provider,
        "cardIdentityId": target["cardIdentityId"],
        "sourceLocator": source_locator,
        "requestFingerprint": request_fingerprint,
        "observedAt": observed_at,
        "payloadSha256": sha256_text(raw_payload),
        "artifactSha256": artifact_sha256,
        "rawPayload": raw_payload,
    }


def acquire_scrydex(targets: list[dict], timeout: int, retries: int, pace: float) -> tuple[list[dict], list[dict]]:
    headers = {"X-Api-Key": os.getenv("SCRYDEX_API_KEY", ""), "X-Team-ID": os.getenv("SCRYDEX_TEAM_ID", "")}
    snapshots, held = [], []
    for index, target in enumerate(targets):
        card_id = str(target.get("scrydexCardId") or target.get("tcgdexCardId") or "").strip()
        if not card_id:
            held.append({"cardIdentityId": target.get("cardIdentityId"), "provider": "scrydex", "reason": "exact_scrydex_card_id_unavailable"})
            continue
        url = f"{SCRYDEX_BASE}/{urllib.parse.quote(card_id, safe='-_.')}"
        try:
            payload, _raw, artifact_hash = request_json(url, headers=headers, timeout=timeout, retries=retries)
            snapshots.append(snapshot("scrydex", target, url, payload, artifact_sha256=artifact_hash))
        except urllib.error.HTTPError as error:
            reason = "card_not_found" if error.code == 404 else "acquisition_failed"
            held.append({"cardIdentityId": target.get("cardIdentityId"), "provider": "scrydex", "reason": reason, "detail": f"HTTP {error.code}"})
        except (urllib.error.URLError, TimeoutError, ValueError, RuntimeError) as error:
            held.append({"cardIdentityId": target.get("cardIdentityId"), "provider": "scrydex", "reason": "acquisition_failed", "detail": str(error)})
        if pace > 0 and index + 1 < len(targets):
            time.sleep(pace)
    return snapshots, held


def _tcgplayer_envelope(payload: object) -> dict:
    if not isinstance(payload, dict):
        return {"results": [], "errors": ["not_object"], "complete": False, "noPagination": False, "errorsEmpty": False}
    results = payload.get("results") if isinstance(payload.get("results"), list) else []
    errors = payload.get("errors") if isinstance(payload.get("errors"), list) else []
    total_raw = payload.get("totalItems")
    total_matches = True
    if total_raw is not None:
        try:
            total_matches = int(total_raw) == len(results)
        except (TypeError, ValueError):
            total_matches = False
    pagination_keys = ("nextPage", "previousPage", "page", "pageSize", "totalPages", "pagination", "next")
    no_pagination = all(payload.get(key) in (None, "") for key in pagination_keys)
    errors_empty = len(errors) == 0
    complete = payload.get("success") is True and errors_empty and total_matches and no_pagination
    return {
        "results": results,
        "errors": errors,
        "complete": complete,
        "noPagination": no_pagination,
        "errorsEmpty": errors_empty,
        "totalMatches": total_matches,
    }


def _tcgplayer_product(payload: object, product_id: object) -> dict | None:
    expected = str(product_id)
    envelope = _tcgplayer_envelope(payload)
    return next((row for row in envelope["results"] if isinstance(row, dict) and str(row.get("productId")) == expected), None)


def acquire_tcgplayer(targets: list[dict], timeout: int, retries: int, pace: float) -> tuple[list[dict], list[dict]]:
    if os.getenv("TCGPLAYER_METADATA_APPROVED") != "true":
        return [], [{"cardIdentityId": t.get("cardIdentityId"), "provider": "tcgplayer", "reason": "metadata_provider_approval_required"} for t in targets]
    token = os.getenv("TCGPLAYER_BEARER_TOKEN", "").strip()
    if not token:
        return [], [{"cardIdentityId": t.get("cardIdentityId"), "provider": "tcgplayer", "reason": "bearer_token_missing"} for t in targets]
    headers = {"Authorization": f"bearer {token}"}
    product_cache: dict[str, dict] = {}
    category_cache: dict[str, dict] = {}
    snapshots, held = [], []
    for index, target in enumerate(targets):
        product_id = target.get("tcgplayerProductId")
        if target.get("tcgplayerExactCrosswalk") is not True or product_id is None:
            held.append({"cardIdentityId": target.get("cardIdentityId"), "provider": "tcgplayer", "reason": "exact_tcgplayer_crosswalk_required"})
            continue
        product_key = str(product_id)
        try:
            bundle = product_cache.get(product_key)
            if bundle is None:
                product_url = f"{TCGPLAYER_BASE}/catalog/products/{urllib.parse.quote(product_key, safe='')}"
                skus_url = f"{product_url}/skus"
                product_payload, _product_raw, product_hash = request_json(product_url, headers=headers, timeout=timeout, retries=retries)
                product = _tcgplayer_product(product_payload, product_id)
                category_id = product.get("categoryId") if isinstance(product, dict) else None
                try:
                    category_key = str(int(category_id))
                except (TypeError, ValueError):
                    raise RuntimeError("exact_product_category_unavailable")
                skus_payload, _skus_raw, skus_hash = request_json(skus_url, headers=headers, timeout=timeout, retries=retries)
                category = category_cache.get(category_key)
                if category is None:
                    printings_url = f"{TCGPLAYER_BASE}/catalog/categories/{urllib.parse.quote(category_key, safe='')}/printings"
                    languages_url = f"{TCGPLAYER_BASE}/catalog/categories/{urllib.parse.quote(category_key, safe='')}/languages"
                    printings_payload, _printings_raw, printings_hash = request_json(printings_url, headers=headers, timeout=timeout, retries=retries)
                    languages_payload, _languages_raw, languages_hash = request_json(languages_url, headers=headers, timeout=timeout, retries=retries)
                    category = {
                        "printingsUrl": printings_url,
                        "languagesUrl": languages_url,
                        "printingsPayload": printings_payload,
                        "languagesPayload": languages_payload,
                        "printingsHash": printings_hash,
                        "languagesHash": languages_hash,
                    }
                    category_cache[category_key] = category
                bundle = {
                    "productUrl": product_url,
                    "skusUrl": skus_url,
                    "productPayload": product_payload,
                    "skusPayload": skus_payload,
                    "productHash": product_hash,
                    "skusHash": skus_hash,
                    "product": product,
                    "category": category,
                }
                product_cache[product_key] = bundle

            product_check = _tcgplayer_envelope(bundle["productPayload"])
            skus_check = _tcgplayer_envelope(bundle["skusPayload"])
            printings_check = _tcgplayer_envelope(bundle["category"]["printingsPayload"])
            languages_check = _tcgplayer_envelope(bundle["category"]["languagesPayload"])
            exact_skus = [row for row in skus_check["results"] if isinstance(row, dict) and str(row.get("productId")) == product_key]
            payload = {
                "mode": "complete_product_sku_enumeration",
                "product": bundle["product"],
                "skus": exact_skus,
                "printings": printings_check["results"],
                "languages": languages_check["results"],
                "completeness": {
                    "productDetailsComplete": product_check["complete"] and bundle["product"] is not None,
                    "productSkusComplete": skus_check["complete"] and len(exact_skus) == len(skus_check["results"]),
                    "categoryPrintingsComplete": printings_check["complete"],
                    "categoryLanguagesComplete": languages_check["complete"],
                    "noPagination": product_check["noPagination"] and skus_check["noPagination"] and printings_check["noPagination"] and languages_check["noPagination"],
                    "errorsEmpty": product_check["errorsEmpty"] and skus_check["errorsEmpty"] and printings_check["errorsEmpty"] and languages_check["errorsEmpty"],
                },
                "sourceLocators": {
                    "product": bundle["productUrl"],
                    "skus": bundle["skusUrl"],
                    "printings": bundle["category"]["printingsUrl"],
                    "languages": bundle["category"]["languagesUrl"],
                },
                "policy": {"pricesIgnored": True, "omissionRequiresCompleteEnumeration": True},
            }
            combined_hash = sha256_text("|".join((bundle["productHash"], bundle["skusHash"], bundle["category"]["printingsHash"], bundle["category"]["languagesHash"])))
            snapshots.append(snapshot("tcgplayer", target, bundle["skusUrl"], payload, artifact_sha256=combined_hash))
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, ValueError, RuntimeError) as error:
            held.append({"cardIdentityId": target.get("cardIdentityId"), "provider": "tcgplayer", "reason": "acquisition_failed", "detail": str(error)})
        if pace > 0 and index + 1 < len(targets):
            time.sleep(pace)
    return snapshots, held


def _cardmarket_rows(payload: object) -> list[dict]:
    if isinstance(payload, list):
        return [r for r in payload if isinstance(r, dict)]
    if isinstance(payload, dict):
        for key in ("products", "product", "data"):
            value = payload.get(key)
            if isinstance(value, list):
                return [r for r in value if isinstance(r, dict)]
    return []


def acquire_cardmarket(targets: list[dict], timeout: int, retries: int, pace: float) -> tuple[list[dict], list[dict]]:
    del pace
    try:
        payload, _raw, artifact_hash = request_json(CARDMARKET_PRODUCTS, timeout=timeout, retries=retries)
    except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, ValueError, RuntimeError) as error:
        return [], [{"cardIdentityId": t.get("cardIdentityId"), "provider": "cardmarket", "reason": "acquisition_failed", "detail": str(error)} for t in targets]
    by_id = {str(row.get("idProduct") or row.get("productId")): row for row in _cardmarket_rows(payload) if row.get("idProduct") is not None or row.get("productId") is not None}
    snapshots, held = [], []
    for target in targets:
        product_id = target.get("cardmarketProductId")
        if product_id is None:
            held.append({"cardIdentityId": target.get("cardIdentityId"), "provider": "cardmarket", "reason": "exact_cardmarket_product_unavailable"})
            continue
        row = by_id.get(str(product_id))
        if row is None:
            held.append({"cardIdentityId": target.get("cardIdentityId"), "provider": "cardmarket", "reason": "cardmarket_product_absent"})
            continue
        snapshots.append(snapshot("cardmarket", target, CARDMARKET_PRODUCTS, row, artifact_sha256=artifact_hash))
    return snapshots, held


def load_targets(path: Path) -> list[dict]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(payload, dict) and isinstance(payload.get("targets"), list):
        payload = payload["targets"]
    if not isinstance(payload, list):
        raise ValueError("targets file must be an array or {targets:[...]}")
    out, seen = [], set()
    for row in payload:
        if not isinstance(row, dict) or not row.get("cardIdentityId") or not row.get("variantCode"):
            raise ValueError("every target requires cardIdentityId and variantCode")
        if row["cardIdentityId"] in seen:
            raise ValueError(f"duplicate canonical identity: {row['cardIdentityId']}")
        seen.add(row["cardIdentityId"])
        out.append(row)
    return out


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--provider", choices=("scrydex", "tcgplayer", "cardmarket"), required=True)
    parser.add_argument("--targets", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--timeout", type=int, default=30)
    parser.add_argument("--retries", type=int, default=5)
    parser.add_argument("--pace-seconds", type=float, default=0.15)
    args = parser.parse_args()
    targets = load_targets(args.targets)
    acquire = {"scrydex": acquire_scrydex, "tcgplayer": acquire_tcgplayer, "cardmarket": acquire_cardmarket}[args.provider]
    snapshots, held = acquire(targets, args.timeout, args.retries, max(0.0, args.pace_seconds))
    report = {
        "schemaVersion": 2 if args.provider == "tcgplayer" else 1,
        "provider": args.provider,
        "productionWrites": False,
        "priceWrites": False,
        "targetCount": len(targets),
        "snapshotCount": len(snapshots),
        "heldCount": len(held),
        "snapshots": snapshots,
        "held": held,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps({k: report[k] for k in ("provider", "targetCount", "snapshotCount", "heldCount", "productionWrites", "priceWrites")}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
