#!/usr/bin/env python3
"""Acquire Japanese Pokémon catalogue evidence without writing DB state.

All HTTP response bodies are SHA-256 hashed from the exact raw bytes before JSON
is parsed. The output is a replayable evidence bundle; DB writes happen later.
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
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

TCGDEX_BASE = os.environ.get("TCGDEX_JA_BASE", "https://api.tcgdex.net/v2/ja")
SCRYDEX_BASE = os.environ.get("SCRYDEX_JA_BASE", "https://api.scrydex.com/pokemon/v1/ja")
RETRYABLE = {408, 425, 429, 500, 502, 503, 504}
MAX_BODY = 32 * 1024 * 1024

def now_ms() -> int:
    return int(time.time() * 1000)

def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))

def sha256_bytes(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()

def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()

@dataclass(frozen=True)
class Response:
    provider: str
    url: str
    raw: bytes
    parsed: Any
    observed_at: int

    def snapshot(self, *, scope_type: str, source_record_id: str | None = None, set_code: str | None = None) -> dict[str, Any]:
        raw_text = self.raw.decode("utf-8")
        canonical = canonical_json(self.parsed)
        return {
            "provider": self.provider,
            "scopeType": scope_type,
            "sourceLocator": self.url,
            "sourceRecordId": source_record_id,
            "setCode": set_code,
            "observedAt": self.observed_at,
            "payloadSha256": sha256_bytes(self.raw),
            "canonicalSha256": sha256_text(canonical),
            "rawPayloadText": raw_text,
        }

class HttpClient:
    def __init__(self, *, retries: int, pace_seconds: float):
        self.retries = max(1, retries)
        self.pace_seconds = max(0.0, pace_seconds)

    def get_json(self, provider: str, url: str, headers: dict[str, str] | None = None) -> Response:
        request_headers = {"Accept": "application/json", "User-Agent": "FateDrop-Japanese-Catalogue/1.0"}
        request_headers.update(headers or {})
        last_error: Exception | None = None
        for attempt in range(1, self.retries + 1):
            try:
                req = urllib.request.Request(url, headers=request_headers, method="GET")
                with urllib.request.urlopen(req, timeout=30) as response:
                    raw = response.read(MAX_BODY + 1)
                    if len(raw) > MAX_BODY:
                        raise RuntimeError(f"response_too_large:{url}")
                    observed = now_ms()
                    parsed = json.loads(raw.decode("utf-8"))
                    if self.pace_seconds:
                        time.sleep(self.pace_seconds)
                    return Response(provider, url, raw, parsed, observed)
            except urllib.error.HTTPError as exc:
                last_error = exc
                if exc.code not in RETRYABLE or attempt == self.retries:
                    raise
                retry_after = exc.headers.get("Retry-After") if exc.headers else None
                delay = float(retry_after) if retry_after and retry_after.replace(".", "", 1).isdigit() else min(8.0, 0.5 * (2 ** (attempt - 1)))
                time.sleep(delay)
            except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, UnicodeDecodeError) as exc:
                last_error = exc
                if attempt == self.retries:
                    raise
                time.sleep(min(8.0, 0.5 * (2 ** (attempt - 1))))
        raise RuntimeError(str(last_error or "request_failed"))

def data_array(payload: Any, provider: str) -> list[dict[str, Any]]:
    if provider == "tcgdex":
        if not isinstance(payload, list):
            raise ValueError("tcgdex_array_expected")
        return payload
    if not isinstance(payload, dict) or not isinstance(payload.get("data"), list):
        raise ValueError("scrydex_data_array_expected")
    return payload["data"]

def page_meta(payload: Any) -> tuple[int, int, int]:
    if not isinstance(payload, dict):
        raise ValueError("scrydex_page_object_expected")
    page = int(payload.get("page") or 1)
    page_size = int(payload.get("pageSize") or payload.get("page_size") or 100)
    total = int(payload.get("totalCount") or payload.get("total_count") or 0)
    return page, page_size, total

def norm_code(value: Any) -> str:
    return "".join(ch for ch in str(value or "").upper() if ch.isalnum())

def card_refs(set_payload: dict[str, Any]) -> list[dict[str, Any]]:
    cards = set_payload.get("cards")
    if not isinstance(cards, list):
        raise ValueError("tcgdex_set_cards_missing")
    refs = []
    for item in cards:
        if not isinstance(item, dict) or not str(item.get("id") or "").strip():
            raise ValueError("tcgdex_set_card_ref_invalid")
        refs.append(item)
    return refs

def scrydex_headers() -> dict[str, str]:
    key = os.environ.get("SCRYDEX_API_KEY", "").strip()
    team = os.environ.get("SCRYDEX_TEAM_ID", "").strip()
    if not key or not team:
        raise RuntimeError("SCRYDEX_API_KEY and SCRYDEX_TEAM_ID are required")
    return {"X-Api-Key": key, "X-Team-ID": team}

def scrydex_thumbnail(card: dict[str, Any]) -> str | None:
    images = card.get("images")
    if not isinstance(images, list):
        return None
    for item in images:
        if isinstance(item, dict) and str(item.get("type") or "").lower() == "front":
            for key in ("small", "medium", "large"):
                value = str(item.get(key) or "").strip()
                if value.startswith("https://"):
                    return value
    return None

def probe_image(url: str) -> dict[str, Any]:
    observed = now_ms()
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "FateDrop-Japanese-Catalogue/1.0"}, method="HEAD")
        with urllib.request.urlopen(req, timeout=20) as response:
            status = int(getattr(response, "status", 200))
            content_type = str(response.headers.get("Content-Type") or "")
            return {"url": url, "status": status, "contentType": content_type, "observedAt": observed, "ok": 200 <= status < 400 and content_type.startswith("image/")}
    except urllib.error.HTTPError as exc:
        if exc.code not in (405, 501):
            return {"url": url, "status": exc.code, "contentType": "", "observedAt": observed, "ok": False}
    except Exception as exc:
        return {"url": url, "status": None, "contentType": "", "observedAt": observed, "ok": False, "error": str(exc)}
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "FateDrop-Japanese-Catalogue/1.0", "Range": "bytes=0-0"}, method="GET")
        with urllib.request.urlopen(req, timeout=20) as response:
            status = int(getattr(response, "status", 200))
            content_type = str(response.headers.get("Content-Type") or "")
            return {"url": url, "status": status, "contentType": content_type, "observedAt": observed, "ok": status in (200, 206) and content_type.startswith("image/")}
    except Exception as exc:
        status = exc.code if isinstance(exc, urllib.error.HTTPError) else None
        return {"url": url, "status": status, "contentType": "", "observedAt": observed, "ok": False, "error": str(exc)}

def build_url(base: str, path: str = "", **query: Any) -> str:
    url = base.rstrip("/") + ("/" + path.lstrip("/") if path else "")
    clean = {k: v for k, v in query.items() if v is not None}
    return url + ("?" + urllib.parse.urlencode(clean) if clean else "")

def acquire(args: argparse.Namespace) -> tuple[dict[str, Any], bool]:
    client = HttpClient(retries=args.retries, pace_seconds=args.pace_seconds)
    run_id = f"jp-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}-{uuid.uuid4().hex[:10]}"
    snapshots: list[dict[str, Any]] = []
    quarantined_sets: set[str] = set()
    errors: list[dict[str, Any]] = []

    tcgdex_manifest_resp = client.get_json("tcgdex", build_url(TCGDEX_BASE, "sets"))
    snapshots.append(tcgdex_manifest_resp.snapshot(scope_type="set_manifest", source_record_id="ja:sets"))
    tcgdex_manifest = data_array(tcgdex_manifest_resp.parsed, "tcgdex")

    scrydex_expansions: list[dict[str, Any]] = []
    page = 1
    while True:
        resp = client.get_json("scrydex", build_url(SCRYDEX_BASE, "expansions", page=page, page_size=100, orderBy="code"), scrydex_headers())
        snapshots.append(resp.snapshot(scope_type="set_manifest", source_record_id=f"ja:expansions:{page}"))
        rows = data_array(resp.parsed, "scrydex")
        scrydex_expansions.extend(rows)
        _, page_size, total = page_meta(resp.parsed)
        if page * page_size >= total or not rows:
            break
        page += 1

    scrydex_expansions = [
        row for row in scrydex_expansions
        if str(row.get("language_code") or "").upper() == "JA" and row.get("is_online_only") is not True
    ]
    by_code: dict[str, list[dict[str, Any]]] = {}
    for expansion in scrydex_expansions:
        by_code.setdefault(norm_code(expansion.get("code")), []).append(expansion)

    acquired_sets: list[dict[str, Any]] = []
    max_sets = args.max_sets if args.max_sets and args.max_sets > 0 else None

    for index, brief in enumerate(tcgdex_manifest):
        if max_sets is not None and index >= max_sets:
            break
        tcg_set_id = str(brief.get("id") or "").strip()
        if not tcg_set_id:
            errors.append({"stage": "set_discovery", "reason": "tcgdex_set_id_missing", "record": brief})
            continue
        matches = by_code.get(norm_code(tcg_set_id), [])
        if len(matches) != 1:
            errors.append({"stage": "set_crosswalk", "setId": tcg_set_id, "reason": "scrydex_native_code_not_unique", "candidateCount": len(matches)})
            continue
        expansion = matches[0]
        native_code = str(expansion.get("code") or "").strip()
        expansion_id = str(expansion.get("id") or "").strip()

        try:
            set_resp = client.get_json("tcgdex", build_url(TCGDEX_BASE, f"sets/{urllib.parse.quote(tcg_set_id, safe='')}"))
            snapshots.append(set_resp.snapshot(scope_type="set", source_record_id=tcg_set_id, set_code=native_code))
            set_payload = set_resp.parsed
            if not isinstance(set_payload, dict):
                raise ValueError("tcgdex_set_object_expected")
            refs = card_refs(set_payload)

            tcgdex_cards: list[dict[str, Any]] = []
            for ref in refs:
                card_id = str(ref["id"])
                card_resp = client.get_json("tcgdex", build_url(TCGDEX_BASE, f"cards/{urllib.parse.quote(card_id, safe='')}"))
                snapshots.append(card_resp.snapshot(scope_type="card", source_record_id=card_id, set_code=native_code))
                if not isinstance(card_resp.parsed, dict):
                    raise ValueError(f"tcgdex_card_object_expected:{card_id}")
                tcgdex_cards.append(card_resp.parsed)

            scrydex_cards: list[dict[str, Any]] = []
            scrydex_card_evidence: dict[str, dict[str, Any]] = {}
            card_page = 1
            while True:
                cards_resp = client.get_json(
                    "scrydex",
                    build_url(SCRYDEX_BASE, f"expansions/{urllib.parse.quote(expansion_id, safe='')}/cards", page=card_page, page_size=100, orderBy="number"),
                    scrydex_headers(),
                )
                page_snapshot = cards_resp.snapshot(scope_type="set", source_record_id=f"{expansion_id}:cards:{card_page}", set_code=native_code)
                snapshots.append(page_snapshot)
                rows = data_array(cards_resp.parsed, "scrydex")
                for row in rows:
                    if str(row.get("language_code") or "").upper() != "JA":
                        raise ValueError(f"scrydex_non_ja_card:{row.get('id')}")
                    card_id = str(row.get("id") or "").strip()
                    if not card_id:
                        raise ValueError("scrydex_card_id_missing")
                    scrydex_card_evidence[card_id] = {
                        "payloadSha256": page_snapshot["payloadSha256"],
                        "sourceLocator": page_snapshot["sourceLocator"],
                        "observedAt": page_snapshot["observedAt"],
                    }
                scrydex_cards.extend(rows)
                _, page_size, total = page_meta(cards_resp.parsed)
                if card_page * page_size >= total or not rows:
                    break
                card_page += 1

            acquired_sets.append({
                "nativeSetCode": native_code,
                "tcgdexSetId": tcg_set_id,
                "scrydexExpansionId": expansion_id,
                "tcgdexSet": set_payload,
                "scrydexExpansion": expansion,
                "tcgdexCards": tcgdex_cards,
                "scrydexCards": scrydex_cards,
                "scrydexCardEvidence": scrydex_card_evidence,
            })
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, RuntimeError) as exc:
            quarantined_sets.add(native_code or tcg_set_id)
            errors.append({"stage": "provider_acquisition", "setId": native_code or tcg_set_id, "reason": type(exc).__name__, "detail": str(exc)})
        except (ValueError, TypeError) as exc:
            errors.append({"stage": "schema_validation", "setId": native_code or tcg_set_id, "reason": str(exc)})

    image_probes: dict[str, dict[str, Any]] = {}
    if not args.skip_image_probes:
        urls = sorted({
            url
            for entry in acquired_sets
            for card in entry["scrydexCards"]
            for url in [scrydex_thumbnail(card)]
            if url
        })
        with ThreadPoolExecutor(max_workers=max(1, min(32, args.image_workers))) as executor:
            futures = {executor.submit(probe_image, url): url for url in urls}
            for future in as_completed(futures):
                result = future.result()
                image_probes[result["url"]] = result

    bundle = {
        "format": "fatedrop-japanese-catalogue-acquisition-v1",
        "runId": run_id,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "productionWrites": False,
        "sources": {"tcgdexBase": TCGDEX_BASE, "scrydexBase": SCRYDEX_BASE, "language": "ja"},
        "counts": {
            "tcgdexManifestSets": len(tcgdex_manifest),
            "scrydexPhysicalExpansions": len(scrydex_expansions),
            "exactCrosswalkSetsAcquired": len(acquired_sets),
            "snapshots": len(snapshots),
            "quarantinedSets": len(quarantined_sets),
            "errors": len(errors),
            "imageProbes": len(image_probes),
            "brokenImageProbes": sum(1 for value in image_probes.values() if not value.get("ok")),
        },
        "quarantinedSetIds": sorted(quarantined_sets),
        "errors": errors,
        "sets": acquired_sets,
        "imageProbes": image_probes,
        "snapshots": snapshots,
    }
    blocked = bool(quarantined_sets or errors)
    return bundle, blocked

def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    parser.add_argument("--retries", type=int, default=6)
    parser.add_argument("--pace-seconds", type=float, default=0.08)
    parser.add_argument("--max-sets", type=int, default=0, help="0 means all; non-zero is for canary/rehearsal only")
    parser.add_argument("--skip-image-probes", action="store_true")
    parser.add_argument("--image-workers", type=int, default=16)
    args = parser.parse_args()
    bundle, blocked = acquire(args)
    with open(args.output, "w", encoding="utf-8") as handle:
        json.dump(bundle, handle, ensure_ascii=False, separators=(",", ":"))
    print(json.dumps({"output": args.output, "counts": bundle["counts"], "blocked": blocked}, indent=2))
    return 1 if blocked else 0

if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        print(json.dumps({"status": "blocked", "error": str(exc)}), file=sys.stderr)
        sys.exit(1)
