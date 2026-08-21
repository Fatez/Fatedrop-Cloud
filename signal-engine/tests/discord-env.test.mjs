import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import os from "node:os";

const envModuleUrl = new URL("../src/config/env.mjs", import.meta.url).href;

function readDiscordEnv(overrides = {}) {
  const childEnv = { ...process.env, ...overrides };
  delete childEnv.FATEDROP_DISCORD_ENABLED;
  if (Object.prototype.hasOwnProperty.call(overrides, "FATEDROP_DISCORD_ENABLED")) {
    childEnv.FATEDROP_DISCORD_ENABLED = overrides.FATEDROP_DISCORD_ENABLED;
  }

  const script = `import { env } from ${JSON.stringify(envModuleUrl)}; console.log(JSON.stringify(env.discord));`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: os.tmpdir(),
    env: childEnv,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim());
}

test("Discord auto-enables when bot token and drops channel are configured", () => {
  const discord = readDiscordEnv({
    DISCORD_BOT_TOKEN: "test-token",
    DISCORD_PREMIUM_DROPS_CHANNEL_ID: "123456789",
  });
  assert.equal(discord.enabled, true);
});

test("explicit Discord disable overrides configured credentials", () => {
  const discord = readDiscordEnv({
    FATEDROP_DISCORD_ENABLED: "false",
    DISCORD_BOT_TOKEN: "test-token",
    DISCORD_PREMIUM_DROPS_CHANNEL_ID: "123456789",
  });
  assert.equal(discord.enabled, false);
});

test("Discord remains disabled when required credentials are incomplete", () => {
  const discord = readDiscordEnv({
    DISCORD_BOT_TOKEN: "test-token",
    DISCORD_PREMIUM_DROPS_CHANNEL_ID: "",
  });
  assert.equal(discord.enabled, false);
});
