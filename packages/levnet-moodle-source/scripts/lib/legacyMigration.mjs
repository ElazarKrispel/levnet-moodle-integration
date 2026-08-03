import { readSecret, writeSecret } from "./platform/secretStore.mjs";

const LEGACY_WINDOWS_ROOT = "JCT";

const SECRET_MAPPINGS = Object.freeze([
  ...["email", "password", "mfa-seed", "ms-sso-cookies"].map((account) => ({
    fromService: "codex-jct-microsoft",
    toService: "codex-levnet-moodle-microsoft",
    account,
  })),
  ...["MoodleSessiondev", "moodle-oauth-tokens"].map((account) => ({
    fromService: "codex-moodle-jct",
    toService: "codex-levnet-moodle-moodle",
    account,
  })),
  ...["levnet-cookie-header", "levnet-oauth-tokens"].map((account) => ({
    fromService: "codex-levnet-jct",
    toService: "codex-levnet-moodle-levnet",
    account,
  })),
]);

export function createLegacyMigrator(overrides = {}) {
  const dependencies = { readSecret, writeSecret, platform: process.platform, ...overrides };
  return async function migrateLegacySecrets() {
    const summary = { checked: SECRET_MAPPINGS.length, migrated: 0, alreadyPresent: 0, legacyFound: 0 };
    for (const mapping of SECRET_MAPPINGS) {
      const current = await dependencies.readSecret(mapping.toService, mapping.account, {
        platform: dependencies.platform,
      });
      if (current) {
        summary.alreadyPresent += 1;
        continue;
      }
      const legacy = await dependencies.readSecret(mapping.fromService, mapping.account, {
        platform: dependencies.platform,
        windowsRoot: LEGACY_WINDOWS_ROOT,
      });
      if (!legacy) continue;
      summary.legacyFound += 1;
      await dependencies.writeSecret(mapping.toService, mapping.account, legacy, {
        platform: dependencies.platform,
      });
      summary.migrated += 1;
    }
    return summary;
  };
}

export const migrateLegacySecrets = createLegacyMigrator();

export function legacySecretMappingsForTest() {
  return SECRET_MAPPINGS.map((mapping) => ({ ...mapping }));
}
