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
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

SCRYDEX_BASE = "https://api.scrydex.com/pokemon/v1/en/cards"
TCGPLAYER_BASE = "https://api.tcgplayer.com/v1.39.0"
CARDMARKET_PRODUCTS = "https://downloads.s3.cardmarket.com/productCatalog/productList/products_singles_6.json"
USER_AGENT = "FateDrop-FinishEvidence/1.0"


def canonical_json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def sha256_text(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def request_json(url: str, headers: dict[str, str] | None = None, timeout: int = 30) -> tuple[object, str, str]:
    req_headers = {"Accept": "application/json", "User-Agent": USER_AGENT}
    if headers:
        req_headers.update({k: v for k, v in headers.items() if v})
    request = urllib.request.Request(url, headers=req_headers, method="GET")
    with urllib.request.urlopen(request, timeout=timeout) as response:
        body = response.read()
        if len(body) > 64 * 1024 * 1024:
            raise RuntimeError("provider payload exceeds 64 MiB safety limit")
        raw = body.decode("utf-8-sig")
        return json.loads(raw), raw, hashlib.sha256(body).hexdigest()


def snapshot(provider: str, target: dict, source_locator: str, payload: object, *, artifact_sha256: str | None = None) -> dict:
    # Evidence rows use a deterministic canonical JSON representation so the exact
    # string committed to the immutable store can always be hashed again later.
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


def acquire_scrydex(targets: list[dict], timeout: int) -> tuple[list[dict], list[dict]]:
    headers = {
        "X-Api-Key": os.getenv("SCRYDEX_API_KEY", ""),
        "X-Team-ID": os.getenv("SCRYDEX_TEAM_ID", ""),
    }
    snapshots, held = [], []
    for target in targets:
        card_id = str(target.get("scrydexCardId") or target.get("tcgdexCardId") or "").strip()
        if not card_id:
            held.append({"cardIdentityId": target.get("cardIdentityId"), "provider": "scrydex", "reason": "exact_scrydex_card_id_unavailable"})
            continue
        url = f"{SCRYDEX_BASE}/{urllib.parse.quote(card_id, safe='-_.')}"
        try:
            payload, _raw, artifact_hash = request_json(url, headers=headers, timeout=timeout)
            snapshots.append(snapshot("scrydex", target, url, payload, artifact_sha256=artifact_hash))
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, ValueError, RuntimeError) as error:
            held.append({"cardIdentityId": target.get("cardIdentityId"), "provider": "scrydex", "reason": "acquisition_failed", "detail": str(error)})
    return snapshots, held


def acquire_tcgplayer(targets: list[dict], timeout: int) -> tuple[list[dict], list[dict]]:
    # TCGplayer metadata acquisition is intentionally separately gated from Fate Price.
    # Prices returned by this endpoint are ignored; only explicit subTypeName is eligible.
    if os.getenv("TCGPLAYER_METADATA_APPROVED") != "true":
        return [], [{"cardIdentityId": t.get("cardIdentityId"), "provider": "tcgplayer", "reason": "metadata_provider_approval_required"} for t in targets]
    token = os.getenv("TCGPLAYER_BEARER_TOKEN", "").strip()
    if not token:
        return [], [{"cardIdentityId": t.get("cardIdentityId"), "provider": "tcgplayer", "reason": "bearer_token_missing"} for t in targets]
    headers = {"Authorization": f"bearer {token}"}
    cache: dict[str, tuple[object, str]] = {}
    snapshots, held = [], []
    for target in targets:
        group_id = str(target.get("tcgplayerGroupId") or "").strip()
        product_id = target.get("tcgplayerProductId")
        if target.get("tcgplayerExactCrosswalk") is not True or not group_id or product_id is None:
            held.append({"cardIdentityId": target.get("cardIdentityId"), "provider": "tcgplayer", "reason": "exact_tcgplayer_crosswalk_required"})
            continue
        url = f"{TCGPLAYER_BASE}/pricing/group/{urllib.parse.quote(group_id, safe='')}"
        try:
            if group_id not in cache:
                payload, _raw, artifact_hash = request_json(url, headers=headers, timeout=timeout)
                cache[group_id] = (payload, artifact_hash)
            payload, artifact_hash = cache[group_id]
            # Store only rows for the already-reviewed exact product crosswalk. Never
            # infer a product from a name, rarity, price, or absence from the group.
            rows = [r for r in payload.get("results", []) if str(r.get("productId")) == str(product_id)] if isinstance(payload, dict) else []
            snapshots.append(snapshot("tcgplayer", target, url, {"success": bool(payload.get("success", False)), "results": rows}, artifact_sha256=artifact_hash))
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, ValueError, RuntimeError) as error:
            held.append({"cardIdentityId": target.get("cardIdentityId"), "provider": "tcgplayer", "reason": "acquisition_failed", "detail": str(error)})
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


def acquire_cardmarket(targets: list[dict], timeout: int) -> tuple[list[dict], list[dict]]:
    # The public Cardmarket dump is an approved crosswalk source, but idProduct alone
    # never proves finish. The normalizer accepts a snapshot only when the row itself
    # exposes an explicit finish/variant attribute.
    try:
        payload, _raw, artifact_hash = request_json(CARDMARKET_PRODUCTS, timeout=timeout)
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
    out = []
    seen = set()
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
    args = parser.parse_args()
    targets = load_targets(args.targets)
    acquire = {"scrydex": acquire_scrydex, "tcgplayer": acquire_tcgplayer, "cardmarket": acquire_cardmarket}[args.provider]
    snapshots, held = acquire(targets, args.timeout)
    report = {
        "schemaVersion": 1,
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
