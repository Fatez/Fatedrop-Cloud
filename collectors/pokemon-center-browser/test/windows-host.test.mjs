import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const launcher = fs.readFileSync(new URL("../scripts/start-windows.ps1", import.meta.url), "utf8");
const installer = fs.readFileSync(new URL("../scripts/install-windows-startup.ps1", import.meta.url), "utf8");

test("Windows launcher starts a dedicated normal Chrome CDP profile and then the existing supervisor", () => {
  assert.match(launcher, /--remote-debugging-port=\$Port/);
  assert.match(launcher, /--user-data-dir=/);
  assert.match(launcher, /PokemonCenterChrome/);
  assert.match(launcher, /\/json\/version/);
  assert.match(launcher, /& npm start/);
  assert.match(launcher, /Missing collectors\/pokemon-center-browser\/\.env/);
});

test("Windows launcher does not add access-control bypass or headless browser flags", () => {
  assert.doesNotMatch(launcher, /--headless/i);
  assert.doesNotMatch(launcher, /disable-web-security/i);
  assert.doesNotMatch(launcher, /ignore-certificate-errors/i);
  assert.doesNotMatch(launcher, /disable-blink-features/i);
});

test("scheduled task remains an interactive per-user logon process and never embeds ingest secrets", () => {
  assert.match(installer, /New-ScheduledTaskTrigger -AtLogOn/);
  assert.match(installer, /-LogonType Interactive/);
  assert.match(installer, /-RunLevel Limited/);
  assert.match(installer, /-RestartCount 20/);
  assert.match(installer, /-MultipleInstances IgnoreNew/);
  assert.doesNotMatch(installer, /FATEDROP_SIGNAL_INGEST_SECRET/);
});
