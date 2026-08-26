import test from "node:test";
import assert from "node:assert/strict";
import { classifyRrpApplicability } from "../src/core/rrp-applicability.mjs";

const importCases = [
  "Pokemon TCG: 151 Booster Box [JP] sv2a",
  "Pokemon TCG: Gem Pack Vol. 4 Chinese Booster Box [CN]",
  "Sun & Moon - Shining Synergy Tag Team [Set A] - Chinese Slim Booster Box — Sealed",
  "Pokemon TCG: Battle Partners Booster Box [JPN] sv9",
  "Pokemon TCG: Korean Booster Box [KR]",
  "Pokemon TCG: Simplified Chinese Booster Box [CHS]",
  "Pokemon TCG: Traditional Chinese Booster Box [CHT]",
];

for (const title of importCases) {
  test(`RRP applicability excludes import marker: ${title}`, () => {
    assert.deepEqual(
      classifyRrpApplicability({ title, productType: "booster_box" }),
      { eligible: false, reason: "non_uk_import" },
    );
  });
}

test("ordinary English booster boxes remain reference-eligible", () => {
  assert.deepEqual(
    classifyRrpApplicability({ title: "Pokemon TCG: Battle Styles - Booster Box", productType: "booster_box" }),
    { eligible: true, reason: null },
  );
});
