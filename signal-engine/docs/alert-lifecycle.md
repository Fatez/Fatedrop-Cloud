# FateDrop Alert Lifecycle

Status: canonical public contract.

This document defines exactly what FateDrop means by **Whisper**, **Echo**, **Manifested** and **Vanished**. Web, app and Discord should use the same meanings.

## Core rule

FateDrop does not treat every retailer change as a stock alert.

The Signal Engine follows this model:

**Observe → understand → classify → decide → notify**

The four lifecycle stages describe the strength and meaning of the evidence. They are not four compulsory steps. A product can enter the network at Manifested if the first reliable observation is already purchasable, and some products may never produce an Echo.

---

## 1. Whisper — Oru

**Meaning:** early product or catalogue movement before verified purchasable stock.

Typical causes:
- a new retailer SKU appears;
- a product is added to a catalogue;
- a non-purchasable product changes state;
- preorder / coming-soon / out-of-stock catalogue movement is observed.

Whisper says:

> Something changed around this product. It may be worth watching, but stock is **not confirmed**.

Whisper must **not** be presented as:
- confirmed stock;
- a guaranteed upcoming drop;
- a queue/security event;
- a reason to tell users to buy immediately.

Recommended user action: **inspect / watch / create a FateFind**.

Companion: **Oru**.

---

## 2. Echo — Fenn

**Meaning:** retailer readiness or access behaviour changed.

Typical evidence:
- queue behaviour;
- traffic/access changes;
- security/challenge behaviour;
- other retailer readiness evidence that may occur around a drop.

Echo says:

> The retailer environment has changed. Get ready and inspect, but stock is **not confirmed**.

Echo must **not** be presented as:
- a product listing merely appearing;
- confirmed inventory;
- a restock;
- proof that a drop will definitely happen.

Recommended user action: **get ready / inspect**.

Companion: **Fenn**.

### Important distinction: Whisper vs Echo

Whisper is primarily **product/catalogue intelligence**.

Echo is primarily **retailer readiness/access intelligence**.

They can happen independently. A Whisper does not require an Echo, and an Echo does not guarantee a Manifested alert.

---

## 3. Manifested — Koru

**Meaning:** FateDrop has verified that the retailer offer is purchasable.

Typical causes:
- an out-of-stock/coming-soon offer becomes purchasable;
- a previously available SKU restocks;
- a newly discovered listing is already live and purchasable.

Manifested says:

> Verified purchasable availability is live now.

This is FateDrop's strongest availability alert and the point at which a live-stock claim is allowed.

Recommended user action:
- Primary/RRP retailer: **buy / view product**;
- Market/independent retailer: **view listing and compare price against RRP / alternatives**.

Companion: **Koru**.

---

## 4. Vanished — Nyxen

**Meaning:** an offer that FateDrop had previously verified as purchasable is no longer verified purchasable.

Typical cause:
- a previously live offer changes from purchasable to non-purchasable.

Vanished says:

> Verified availability has disappeared.

Vanished can include **Observed live** duration when FateDrop has a valid closed Manifested → Vanished window. For example:

> Observed live · 12m 34s

That duration is an observed fact, not a prediction.

Observed-live duration belongs **only to Vanished**. Manifested, Echo and Whisper must never show a completed availability duration.

Recommended user action: **check prepared alternatives / compare sellers / keep watching**.

Companion: **Nyxen**.

---

# Lifecycle examples

### Normal restock
Out of stock → **Manifested** → sold out → **Vanished**

There may be no Whisper or Echo.

### New product discovered before launch
New catalogue SKU → **Whisper** → later purchasable → **Manifested** → later unavailable → **Vanished**

### Queue/readiness event
Retailer queue or access pattern changes → **Echo** → later stock may or may not become **Manifested**

### Product first discovered already live
First reliable observation is purchasable → **Manifested**

FateDrop does not invent earlier stages simply to make the lifecycle look complete.

---

# Product intelligence and alert filtering

Detection remains broad. Notification delivery is selective.

Each product alert is classified as one of:
- **SEALED_TCG**
- **SINGLE_CARD**
- **ACCESSORY**
- **MERCHANDISE**
- **UNKNOWN**

The product category does not change the lifecycle meaning.

For example:
- an Elite Trainer Box can be Manifested;
- a pin can also technically become Manifested at the monitoring layer;
- a user with Merchandise disabled should not be interrupted by the pin event.

This preserves network intelligence while reducing notification noise.

Mixed products are classified by their primary product intent. A TCG collection containing booster packs plus a pin remains a sealed TCG collection rather than being discarded because the title contains "pin".

UNKNOWN remains explicit rather than forcing a bad classification.

---

# Primary/RRP vs Market/Indie

The lifecycle is universal.

A Manifested alert always means verified purchasable availability, whether the retailer is:
- **PRIMARY / RRP**, or
- **MARKET / INDIE**.

The retailer class changes presentation and recommended action, not the meaning of Whisper, Echo, Manifested or Vanished.

---

# Public one-line definitions

**Whisper · Oru** — Early product/catalogue movement. Something may be coming; stock is not confirmed.

**Echo · Fenn** — Retailer readiness/access activity changed. Get ready; stock is not confirmed.

**Manifested · Koru** — Verified purchasable stock is live.

**Vanished · Nyxen** — Previously verified stock is no longer purchasable; where available, FateDrop shows how long it was observed live.

---

# Non-negotiable wording rules

1. Whisper and Echo must explicitly avoid implying confirmed stock.
2. Manifested is the only stage that may make a current verified-live claim.
3. Vanished only follows previously verified purchasable availability.
4. Observed-live duration is Vanished-only and requires a closed observed window.
5. Not every product must pass through every stage.
6. Product filtering changes delivery, not underlying detection.
7. Primary/RRP and Market/Indie labels do not redefine lifecycle semantics.
