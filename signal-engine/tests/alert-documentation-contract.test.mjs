import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const lifecycle = await readFile(new URL("../docs/alert-lifecycle.md", import.meta.url), "utf8");
const discord = await readFile(new URL("../docs/discord-alert-guide.md", import.meta.url), "utf8");

test("alert documentation preserves the four canonical meanings", () => {
  assert.match(lifecycle, /Whisper — Oru/);
  assert.match(lifecycle, /Echo — Fenn/);
  assert.match(lifecycle, /Manifested — Koru/);
  assert.match(lifecycle, /Vanished — Nyxen/);
  assert.match(lifecycle, /stock is \*\*not confirmed\*\*/);
  assert.match(lifecycle, /verified that the retailer offer is purchasable/i);
  assert.match(lifecycle, /Observed-live duration belongs \*\*only to Vanished\*\*/);
  assert.match(lifecycle, /Not every product must pass through every stage/);
});

test("Discord guide keeps speculative and confirmed alerts clearly separated", () => {
  assert.match(discord, /WHISPER/);
  assert.match(discord, /ECHO/);
  assert.match(discord, /MANIFESTED/);
  assert.match(discord, /VANISHED/);
  assert.match(discord, /What it does NOT mean:\*\* stock is live/);
  assert.match(discord, /What it does NOT mean:\*\* stock is confirmed/);
  assert.match(discord, /Verified stock is live/);
  assert.match(discord, /Observed live · 12m 34s/);
});
