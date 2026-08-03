import assert from "node:assert/strict";
import test from "node:test";

import { createMoodleCalendarPairingService } from "../scripts/lib/moodleCalendarPairing.mjs";

const FEED_URL = "https://moodle.jct.ac.il/calendar/export_execute.php?userid=42&authtoken=private-token&preset_what=all&preset_time=recentupcoming";

test("calendar pairing is confirmed, account-bound, single-use, and never returns the feed secret", async () => {
  const fixture = pairingFixture();
  const prepared = await fixture.service.prepare();
  assert.equal(prepared.confirmationRequired, "single");
  assert.equal(prepared.preview.secretReturnedToModel, false);
  assert.doesNotMatch(JSON.stringify(prepared), /private-token/);

  const result = await fixture.service.execute({ prepareToken: prepared.prepareToken, confirm: true });
  assert.equal(result.status, "succeeded");
  assert.equal(result.copiedToClipboard, true);
  assert.equal(result.webAppOpened, true);
  assert.equal(result.secretReturnedToModel, false);
  assert.equal(fixture.presentedSecrets[0], FEED_URL);
  assert.deepEqual(fixture.openedUrls, ["https://script.google.com/macros/s/test-deployment/exec"]);
  assert.doesNotMatch(JSON.stringify(result), /private-token|authtoken/);

  await assert.rejects(() => fixture.service.execute({ prepareToken: prepared.prepareToken, confirm: true }), /state succeeded/);
});

test("calendar pairing requires confirmation and rejects a changed Moodle account", async () => {
  const fixture = pairingFixture();
  const prepared = await fixture.service.prepare();
  await assert.rejects(() => fixture.service.execute({ prepareToken: prepared.prepareToken }), /confirm=true/);
  fixture.account.userId = "another-user";
  await assert.rejects(
    () => fixture.service.execute({ prepareToken: prepared.prepareToken, confirm: true }),
    /another Moodle account/,
  );
  assert.equal(fixture.presentedSecrets.length, 0);
});

test("calendar pairing consumes the token when local presentation fails without leaking the URL", async () => {
  const fixture = pairingFixture({ presentationError: new Error(`Could not present ${FEED_URL}`) });
  const prepared = await fixture.service.prepare();
  const result = await fixture.service.execute({ prepareToken: prepared.prepareToken, confirm: true });
  assert.equal(result.status, "presentation_failed");
  assert.equal(result.secretReturnedToModel, false);
  assert.doesNotMatch(JSON.stringify(result), /private-token|authtoken/);
});

function pairingFixture({ presentationError = null } = {}) {
  let now = Date.parse("2026-08-03T03:00:00Z");
  const secrets = new Map();
  const account = { userId: "moodle-user-42" };
  const presentedSecrets = [];
  const openedUrls = [];
  const service = createMoodleCalendarPairingService({
    now: () => now,
    readSecret: async (serviceName, accountName) => secrets.get(`${serviceName}:${accountName}`) ?? null,
    writeSecret: async (serviceName, accountName, value) => secrets.set(`${serviceName}:${accountName}`, value),
    readAccountBindingMaterial: async () => ({ ...account }),
    generateCalendarExportUrl: async () => FEED_URL,
    showSecret: async (value) => {
      presentedSecrets.push(value);
      if (presentationError) throw presentationError;
      return { copied: true, shown: true };
    },
    webAppUrl: "https://script.google.com/macros/s/test-deployment/exec",
    openExternal: async (url) => { openedUrls.push(url); return { opened: true }; },
  });
  return { service, account, presentedSecrets, openedUrls, advance: (ms) => { now += ms; } };
}
