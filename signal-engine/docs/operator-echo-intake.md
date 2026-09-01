# Operator Echo intake

FateDrop accepts reviewed manual intelligence through an issue authored by the authorised
`Fatez` account in `Fatez/Fatedrop-Cloud`. The issue body must be raw JSON: do not wrap it
in a Markdown code fence or add prose outside the JSON object.

Private source notes may be placed in `evidenceBasis`; the public Echo projection uses
sanitised readiness wording. Only use `sourceUrl` when the destination is safe to expose as
the alert's evidence/retailer link.

Production polling requires `FATEDROP_GITHUB_OPERATOR_TOKEN`, configured only on the Cloud
runtime, with read-only Issues access to `Fatez/Fatedrop-Cloud`.

## Online retailer-readiness Echo

Use this for credible movement such as Pokémon Center queue, traffic, security or access
behaviour. It is an Echo readiness alert, not a stock claim.

Issue title:

`[FATEDROP ECHO] Pokémon Center readiness movement`

Issue body:

```json
{
  "schemaVersion": 1,
  "tcgCode": "pokemon",
  "availabilityScope": "online_retailer_readiness",
  "retailerId": "pokemon-center-uk",
  "retailerName": "Pokémon Center UK",
  "rawProductTitle": "Pokémon Center retailer movement",
  "kind": "echo",
  "sourceType": "operator_manual",
  "sourceUrl": "https://www.pokemoncenter.com/en-gb",
  "sourceLabel": "Reviewed FateDrop operator intelligence",
  "explicitTcgRelevance": true,
  "evidenceBasis": "Credible retailer traffic movement observed; this does not prove purchasable stock.",
  "expectedLabel": "Traffic and access movement observed",
  "expiresAt": "2026-09-02T23:00:00Z",
  "confidence": 0.72,
  "targetBranches": []
}
```

This path persists a non-stock readiness event, delivers one deduplicated Echo push to
eligible users, and leaves the Echo visible in Alerts. It never writes an offer or physical
stock observation and cannot create Manifested or Vanished.

## Physical Big Fate Echo

Use this for branch-specific expected allocation or reviewed reports. Every branch must
match exactly to a canonical, publicly eligible branch. The event is ingested into Local
Radar, but national push delivery remains held until server-side recipient radius targeting
is proven.

Issue title:

`[FATEDROP LOCAL RADAR] Entertainer expected allocation`

Issue body:

```json
{
  "schemaVersion": 1,
  "tcgCode": "pokemon",
  "availabilityScope": "physical_branch",
  "retailerId": "entertainer-uk",
  "retailerName": "The Entertainer",
  "rawProductTitle": "Pokémon TCG example product",
  "kind": "echo",
  "sourceType": "official_retailer_page",
  "sourceUrl": "https://www.thetoyshop.com/pokemon-at-the-entertainer",
  "sourceLabel": "The Entertainer official Pokémon page",
  "explicitTcgRelevance": true,
  "physicalEvidenceState": "expected",
  "evidenceBasis": "Official retailer allocation page names the participating branches; stock is not guaranteed.",
  "expectedLabel": "Expected 3 September",
  "expiresAt": "2026-09-04T23:00:00Z",
  "confidence": 0.68,
  "targetBranches": [
    "The Entertainer Bromley Lower Mall",
    "The Entertainer Watford"
  ]
}
```

Only `official_retailer_page` and `authorised_feed` may request `physicalEvidenceState:
"expected"`. Reviewed human or influencer intelligence uses `sourceType: "operator_manual"`
and becomes `Echo · Reported`.

## Fail-closed rules

- `kind` must be explicitly `echo` for online readiness.
- The TCG must already have public lifecycle alerts enabled. One Piece remains rejected while
  its activation phase is catalogue shadow.
- `expiresAt` must be in the future, and an expected date/window or label is required.
- Physical intelligence requires exact named branches; ambiguous or missing matches are held.
- Online movement never proves stock. Physical stock remains Echo even when exactly confirmed.
- Expiry removes current authority and never manufactures Vanished.
