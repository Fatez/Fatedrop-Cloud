import assert from "node:assert/strict";
import test from "node:test";
import { classifyRrpApplicability } from "../src/core/rrp-applicability.mjs";

for (const title of [
  "Pokemon TCG: Battle Partners Booster Box [JP] sv9",
  "Pokemon TCG: Gem Pack Vol. 4 Chinese Booster Box [CN]",
  "Pokemon TCG: Example Booster Box [KR]",
  "Sun & Moon - Shining Synergy Tag Team - Chinese Slim Booster Box — Sealed",
]) {
  test(`RRP applicability excludes explicit non-UK language marker: ${title}`, () => {
    assert.deepEqual(classifyRrpApplicability({ title, productType: "booster_box" }), {
      eligible: false,
      reason: "non_uk_import",
    });
  });
}

test("English UK-style booster box remains reference eligible", () => {
  assert.deepEqual(classifyRrpApplicability({
    title: "Pokemon TCG: Battle Styles - Booster Box",
    productType: "booster_box",
  }), { eligible: true, reason: null });
});
