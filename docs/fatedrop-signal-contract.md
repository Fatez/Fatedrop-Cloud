# FateDrop canonical signal contract

This is the final product and business definition for FateDrop network lifecycle terminology. Do not reinterpret these names in app, web, Discord, push, Companion, marketing or future business plans without an explicit product decision.

## WHISPER — something may be forming
Broad, deliberately lenient pre-event **product-side intelligence**. Whisper is FateDrop's early scouting layer: it should surface meaningful product/catalogue evidence before confirmed live availability, even when the evidence is incomplete or not yet strongly corroborated.

Whisper includes credible product-side intelligence such as:
- new catalogue entries or exact retailer SKUs;
- newly surfaced official product pages;
- preorder / coming-soon labels or launch-date metadata;
- stock objects, inventory metadata and retailer backend product exposure;
- meaningful product-page or catalogue-state changes;
- meaningful pre-live price or inventory-quantity movement;
- other evidence-backed product movement that says **something may be coming; watch this product.**

Whisper is intentionally broad because its job is early awareness. It may carry the retailer's observed stock wording as evidence, but it does **not** claim that purchase availability has been independently verified.

Whisper is NOT retailer queue/security/access-control readiness and is NOT confirmed purchasable stock.

## ECHO — get ready
Retailer/site **readiness intelligence**, distinct from ordinary product/catalogue observations. Echo covers meaningful traffic-control, queue, waiting-room, security/challenge, access-control or similar infrastructure/readiness changes that materially increase confidence a drop/event may be imminent.

An Echo says: **the retailer itself looks like it is preparing for activity; get ready / get into position.**

Ordinary catalogue preparation, an official product page, preorder metadata, a placeholder price, repeated product observations or preparation-cluster scoring do not become Echo merely because they are strong product evidence. Those remain Whisper/product intelligence until separate readiness evidence exists.

Echo is NOT confirmed purchasable stock.

The canonical Echo implementation is the retailer-readiness path (`signal-engine/src/core/network-readiness.mjs`), which records queue/security/access-control readiness independently from catalogue stock classification.

## MANIFESTED — go now
Confirmed live/purchasable availability. This includes first availability, verified restocks, and a preorder only when FateDrop has independently verified a real purchase/preorder path rather than merely reading preorder metadata. A Manifested signal says: **stock/orderability is live; act now and buy if you want it.**

## VANISHED — it is gone
Previously confirmed purchasable availability is no longer verified. A Vanished signal says: **stock appears gone / sold out; you may have missed it.** The product remains navigable so FateDrop can show current status and alternatives.

## Lifecycle
**WHISPER → ECHO → MANIFESTED → VANISHED**

The arrows describe increasing evidence/action states, not a mandatory timed sequence. Not every event must pass through every stage: stock can Manifest without an Echo if no retailer-readiness precursor was observed, and a queue/security Echo may occur against recent product context without a new catalogue change at that exact moment.

A stronger state must never retroactively redefine product-side early intelligence as Echo. Whisper and Echo answer different questions:
- **Whisper:** what product-side evidence is emerging or moving?
- **Echo:** is the retailer/site behaving like an event is imminent?

## Cross-platform invariant
All four states use the same canonical product identity whenever a product can be identified. Alerts must be actionable rather than dead notifications:
- Whisper → product intelligence/search/comparison context.
- Echo → product + retailer readiness context.
- Manifested → product + current retailer offer / buy action.
- Vanished → product current state + alternative known offers.

## Price truth invariant
RRP/markup context may accompany any product-linked signal only when FateDrop has an authoritative RRP for that canonical identity. Never guess an RRP. Item price vs RRP remains valid even when delivery is unknown; delivery-aware True Price is additional evidence, not a prerequisite for markup percentage.

## Companion intent
Whisper / Oru = scouting, curiosity, early awareness. Oru is broad and lenient by design.
Echo / Fenn = anticipation and retailer readiness.
Manifested / Koru = strongest action/victory state.
Vanished / Nyxen = previously confirmed opportunity lost.
Preserve alert-specific animation mappings where already assigned.

## Distribution and subscription model
The live alert network is a premium product.

- **Website:** True Price remains free and acts as the open utility/acquisition surface. The website dashboard may expose Companion interaction and previews that demonstrate the FateDrop experience, but the live alert feed itself stays hidden from free web users.
- **Mobile app:** subscription unlocks the full live alert experience, including Whisper, Echo, Manifested and Vanished notifications, Companion alert reactions and premium alert controls.
- **Discord:** full real-time alert delivery is part of the same premium subscription entitlement rather than a separate free alert surface.
- **Companions:** website Companion interaction can remain available as a showcase/engagement feature, while the strongest value comes from the Companion reacting to premium live alerts inside the subscribed app experience.

The commercial principle is simple: **give collectors permanent free price truth, charge for time advantage.** Do not hide True Price merely to manufacture a paywall; the subscription earns its value through speed, intelligence, live alerts, delivery and the premium Companion experience.

## Business-plan summary
FateDrop's differentiating alert network is a four-stage intelligence ladder: Oru/Whisper scouts broad early product/catalogue intelligence, Fenn/Echo detects distinct retailer/site readiness such as queues and security/access-control changes, Koru/Manifested confirms when stock or a real preorder path is genuinely purchasable, and Nyxen/Vanished records when previously confirmed availability disappears. The same product identity links the collector from intelligence to action and then to alternatives, while evidence-backed RRP pricing explains whether an offer is actually good value.

The go-to-market model pairs a **free True Price utility** with a **premium time-advantage subscription**. Website visitors can compare real prices and interact with the brand/Companion experience, while subscribers receive the live four-stage alert network through the app and premium Discord. This creates a useful free funnel without giving away FateDrop's most valuable advantage: knowing what is happening early enough to act.
