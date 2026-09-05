# Operator Echo commands

This is the audited remote command contract for FateDrop's owner and an authorised
ChatGPT worker acting on the owner's current, explicit instruction. It does not
contain or require a production secret.

## Authority and safety

- Create the issue in `Fatez/Fatedrop-Cloud` from the authorised `Fatez` GitHub account.
- A request to draft, review, check, or improve an Echo is not authority to publish it.
- Create a publish issue only when the owner's current instruction explicitly says to
  send, publish, or push the supplied Echo out.
- Create a retraction issue only when the owner's current instruction explicitly says
  to retract one identified manual Echo.
- Do not invent movement figures, dates, retailer claims, sources, or stock state.
- Never describe readiness as confirmed stock. A manual global Echo is readiness only.
- Never use this contract for automated signals, physical evidence, Manifested,
  Vanished, or any stock-truth correction.
- Keep the issue body as raw JSON. Markdown fences or surrounding prose invalidate it.

Cloud accepts the command only after verifying the GitHub author, exact title prefix,
schema, explicit confirmation phrase, active TCG, evidence expiry, and target type.
The Web bridge and its production secrets remain server-side.

## Publish a manual global Echo

Use a title beginning with `[FATEDROP ECHO]` and this schema:

```json
{
  "schemaVersion": 2,
  "operation": "publish",
  "operatorConfirmation": "SEND_GLOBAL_ECHO",
  "testOnly": false,
  "tcgCode": "pokemon",
  "retailerId": "fatedrop-intelligence",
  "retailerName": "FateDrop Intelligence",
  "rawProductTitle": "OWNER-SUPPLIED HEADLINE",
  "kind": "echo",
  "availabilityScope": "online_retailer_readiness",
  "sourceType": "operator_manual",
  "sourceUrl": "https://OWNER-SUPPLIED-SOURCE.example/path",
  "sourceLabel": "FateDrop operator intelligence",
  "explicitTcgRelevance": true,
  "expectedLabel": "OWNER-SUPPLIED SHORT MESSAGE",
  "expiresAt": "OWNER-SUPPLIED-OR-EXPLICITLY-AGREED-ISO-TIMESTAMP",
  "confidence": 0.72,
  "targetBranches": [],
  "evidenceBasis": "Authorised FateDrop operator supplied time-sensitive collector intelligence for global Echo delivery.",
  "note": "Global operator Echo only. Follow the linked source and do not treat this message as confirmed stock."
}
```

The issue number becomes the immutable event ID
`local-radar-operator:<issue-number>`. Creating the authorised issue is the send
action: Cloud polls, persists, deduplicates, and asks Web to deliver it.

## Retract one erroneous manual Echo

Use the original publish issue number, a title beginning with
`[FATEDROP ECHO RETRACTION]`, and this schema:

```json
{
  "schemaVersion": 2,
  "operation": "retract",
  "operatorConfirmation": "RETRACT_GLOBAL_ECHO",
  "targetOperatorIssue": 123,
  "reason": "OWNER-SUPPLIED AUDIT REASON OF AT LEAST TEN CHARACTERS",
  "requestedAt": "CURRENT-ISO-TIMESTAMP"
}
```

Retraction never deletes or rewrites the original event. Cloud appends a retraction
event, removes the matching manual readiness Echo from active projections, and sends
Web the authenticated correction command. Web suppresses pending delivery and queues
`This Echo was retracted by FateDrop.` for endpoints that may already have received
the original. The correction has no navigation or buying action.

Creating a new publish issue is not a correction. If replacement information is
required, retract the erroneous Echo first, then request and review a separate Echo.
