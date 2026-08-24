import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import os from "node:os";

const envModuleUrl = new URL("../src/config/env.mjs", import.meta.url).href;

function readDiscordEnv(overrides = {}) {
  const childEnv = { ...process.env };
  for (const name of [
    "FATEDROP_DISCORD_ENABLED",
    "DISCORD_BOT_TOKEN",
    "DISCORD_ORU_BOT_TOKEN",
    "DISCORD_FENN_BOT_TOKEN",
    "DISCORD_KORU_BOT_TOKEN",
    "DISCORD_NYXEN_BOT_TOKEN",
    "DISCORD_NIXON_BOT_TOKEN",
    "DISCORD_PREMIUM_DROPS_CHANNEL_ID",
    "DISCORD_WHISPER_CHANNEL_ID",
    "DISCORD_ECHO_CHANNEL_ID",
    "DISCORD_MANIFESTED_CHANNEL_ID",
    "DISCORD_VANISHED_CHANNEL_ID",
  ]) delete childEnv[name];
  Object.assign(childEnv, overrides);

  const script = `import { env } from ${JSON.stringify(envModuleUrl)}; console.log(JSON.stringify(env.discord));`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: os.tmpdir(),
    env: childEnv,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim());
}

test("Discord auto-enables with legacy bot token and any lifecycle-specific channel", () => {
  const discord = readDiscordEnv({
    DISCORD_BOT_TOKEN: "test-token",
    DISCORD_MANIFESTED_CHANNEL_ID: "333",
  });
  assert.equal(discord.enabled, true);
  assert.equal(discord.channelIds.manifested, "333");
  assert.equal(discord.premiumDropsChannelId, "");
});

test("Discord auto-enables with lifecycle bot token and matching channel", () => {
  const discord = readDiscordEnv({
    DISCORD_KORU_BOT_TOKEN: "koru-token",
    DISCORD_MANIFESTED_CHANNEL_ID: "333",
  });
  assert.equal(discord.enabled, true);
  assert.equal(discord.botToken, "");
  assert.equal(discord.botTokens.manifested, "koru-token");
});

test("all lifecycle channel IDs and companion bot tokens are exposed independently", () => {
  const discord = readDiscordEnv({
    DISCORD_ORU_BOT_TOKEN: "oru-token",
    DISCORD_FENN_BOT_TOKEN: "fenn-token",
    DISCORD_KORU_BOT_TOKEN: "koru-token",
    DISCORD_NYXEN_BOT_TOKEN: "nyxen-token",
    DISCORD_WHISPER_CHANNEL_ID: "111",
    DISCORD_ECHO_CHANNEL_ID: "222",
    DISCORD_MANIFESTED_CHANNEL_ID: "333",
    DISCORD_VANISHED_CHANNEL_ID: "444",
  });
  assert.deepEqual(discord.channelIds, {
    whisper: "111",
    echo: "222",
    manifested: "333",
    vanished: "444",
  });
  assert.deepEqual(discord.botTokens, {
    whisper: "oru-token",
    echo: "fenn-token",
    manifested: "koru-token",
    vanished: "nyxen-token",
  });
});


test("legacy Nixon token variable remains a migration fallback, but Nyxen takes precedence", () => {
  const legacy = readDiscordEnv({
    DISCORD_NIXON_BOT_TOKEN: "legacy-nixon-token",
    DISCORD_VANISHED_CHANNEL_ID: "444",
  });
  assert.equal(legacy.botTokens.vanished, "legacy-nixon-token");

  const canonical = readDiscordEnv({
    DISCORD_NYXEN_BOT_TOKEN: "nyxen-token",
    DISCORD_NIXON_BOT_TOKEN: "legacy-nixon-token",
    DISCORD_VANISHED_CHANNEL_ID: "444",
  });
  assert.equal(canonical.botTokens.vanished, "nyxen-token");
});
