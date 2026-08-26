# FateDrop canonical signal contract

This is the final product and business definition for FateDrop network lifecycle terminology. Do not reinterpret these names in app, web, Discord, push, Companion, marketing or future business plans without an explicit product decision.

## WHISPER — something moved
Weak/early pre-event product intelligence. Whisper is triggered by meaningful but not yet strongly corroborated product-side movement before confirmed live availability: low-confidence catalogue additions, ambiguous new SKU activity, weak preorder/coming-soon changes, stock metadata changes, or other early movement that says **something may be coming; watch this product.**

A Whisper is intentionally lower confidence than an Echo. It is NOT confirmed official retailer readiness, queue/security activity or purchasable stock.

## ECHO — get ready
High-value retailer-side readiness intelligence before purchase availability is confirmed. Echo covers a verified official retailer product page surfacing for a newly observed product, official launch/preorder metadata, meaningful retailer backend/catalogue preparation, and traffic/queue/waiting-room/security/readiness changes that materially increase confidence a drop/event is forming.

An Echo says: **the retailer is visibly preparing/publishing this; get ready.**

A verified official product page may create an Echo on its first observation because it is stronger evidence than generic catalogue chatter. However, page existence or a retailer catalogue value such as `PREORDER` is still **not** proof that a user can actually order the product.

Echo is NOT confirmed purchasable stock.

## MANIFESTED — go now
Confirmed live/purchasable availability. This includes first availability, verified restocks, and a preorder only when FateDrop has independently verified a real purchase/preorder path rather than merely reading preorder metadata. A Manifested signal says: **stock/orderability is live; act now and buy if you want it.**

## VANISHED — it is gone
Previously confirmed purchasable availability is no longer verified. A Vanished signal says: **stock appears gone / sold out; you may have missed it.** The product remains navigable so FateDrop can show current status and alternatives.

## Lifecycle
**WHISPER → ECHO → MANIFESTED → VANISHED**

Not every event must pass through every stage. For example, a verified official retailer product page can first appear as an Echo without a prior Whisper, and stock can Manifest without a prior Echo if no readiness precursor was observed. The words describe evidence states, not a mandatory timed sequence.

## Cross-platform invariant
All four states use the same canonical product identity whenever a product can be identified. Alerts must be actionable rather than dead notifications:
- Whisper → product intelligence/search/comparison context.
- Echo → product + retailer readiness context, including the verified official product page where available.
- Manifested → product + current retailer offer / buy action.
- Vanished → product current state + alternative known offers.

## Price truth invariant
RRP/markup context may accompany any product-linked signal only when FateDrop has an authoritative RRP for that canonical identity. Never guess an RRP. Item price vs RRP remains valid even when delivery is unknown; delivery-aware True Price is additional evidence, not a prerequisite for markup percentage.

## Companion intent
Whisper = notice/scan. Echo = anticipation/readiness. Manifested = strongest action/victory state. Vanished = missed/subdued state. Preserve alert-specific animation mappings where already assigned.

## Distribution and subscription model
The live alert network is a premium product.

- **Website:** True Price remains free and acts as the open utility/acquisition surface. The website dashboard may expose Companion interaction and previews that demonstrate the FateDrop experience, but the live alert feed itself stays hidden from free web users.
- **Mobile app:** subscription unlocks the full live alert experience, including Whisper, Echo, Manifested and Vanished notifications, Companion alert reactions and premium alert controls.
- **Discord:** full real-time alert delivery is part of the same premium subscription entitlement rather than a separate free alert surface.
- **Companions:** website Companion interaction can remain available as a showcase/engagement feature, while the strongest value comes from the Companion reacting to premium live alerts inside the subscribed app experience.

The commercial principle is simple: **give collectors permanent free price truth, charge for time advantage.** Do not hide True Price merely to manufacture a paywall; the subscription earns its value through speed, intelligence, live alerts, delivery and the premium Companion experience.

## Business-plan summary
FateDrop's differentiating alert network is a four-stage intelligence ladder: it notices weak product movement early (Whisper), detects strong retailer-side readiness such as verified official product pages, launch/preorder preparation and queue/security signals (Echo), confirms when stock or a real preorder path is genuinely purchasable (Manifested), and records when that availability disappears (Vanished). The same product identity links the collector from intelligence to action and then to alternatives, while evidence-backed RRP pricing explains whether an offer is actually good value.

The go-to-market model pairs a **free True Price utility** with a **premium time-advantage subscription**. Website visitors can compare real prices and interact with the brand/Companion experience, while subscribers receive the live four-stage alert network through the app and premium Discord. This creates a useful free funnel without giving away FateDrop's most valuable advantage: knowing what is happening early enough to act.
