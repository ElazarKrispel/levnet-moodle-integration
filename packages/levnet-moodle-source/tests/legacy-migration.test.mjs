import assert from "node:assert/strict";
import test from "node:test";

import { createLegacyMigrator, legacySecretMappingsForTest } from "../scripts/lib/legacyMigration.mjs";

test("legacy migration copies protected values once and never deletes or returns them", async () => {
  const values = new Map();
  const writes = [];
  const first = legacySecretMappingsForTest()[0];
  values.set(`JCT:${first.fromService}:${first.account}`, "private-value");
  const migrate = createLegacyMigrator({
    platform: "win32",
    readSecret: async (service, account, options = {}) => values.get(`${options.windowsRoot || "new"}:${service}:${account}`) || null,
    writeSecret: async (service, account, value) => {
      writes.push({ service, account, value });
      values.set(`new:${service}:${account}`, value);
    },
  });

  const initial = await migrate();
  assert.equal(initial.migrated, 1);
  assert.equal(initial.legacyFound, 1);
  assert.equal(JSON.stringify(initial).includes("private-value"), false);
  assert.equal(writes.length, 1);

  const repeated = await migrate();
  assert.equal(repeated.migrated, 0);
  assert.equal(writes.length, 1);
});
