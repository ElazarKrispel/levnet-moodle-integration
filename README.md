# Levnet & Moodle Integration

An independent, unofficial Codex integration for JCT Moodle, Levnet, and
Google Calendar. It is designed for personal accounts first: every user keeps
their credentials locally and authorizes Google directly, with no shared
student database or developer-operated synchronization server.

> This project is not affiliated with or endorsed by JCT, Moodle, Microsoft,
> or Google.

## What it does

- Reads Moodle courses, assignments, deadlines, and approved resources.
- Reads reviewed Levnet student data and downloads selected documents.
- Uses explicit `prepare → confirm → execute` flows for supported mutations.
- Creates a dedicated `Moodle – Assignments` Google Calendar.
- Synchronizes every day around 06:30 Jerusalem time, even when the computer is
  off, with a manual **Update now** button in the web app.
- Creates one-hour calendar events ending exactly at the submission deadline.

## Windows pilot installation

1. Download `Levnet-Moodle-Setup.exe` from the latest GitHub release.
2. Run it. It installs only for the current Windows user and does not require
   administrator access.
3. Codex opens on the plugin page; select **Install**.
4. Ask Codex: `Set up Levnet, Moodle, and my Google Calendar.`

The pilot installer is not yet code-signed, so Windows may show a SmartScreen
warning. Verify that the download comes from this repository's Releases page.
Public distribution to nontechnical users is gated on code signing and Google
OAuth verification.

### One instruction for Codex

After downloading the installer, paste this into Codex:

> Install Levnet & Moodle Integration from the installer in my Downloads
> folder, then guide me through its secure setup. Never ask me to paste a
> password, TOTP key, one-time code, cookie, or Moodle calendar URL into chat.

## Privacy model

- Passwords, TOTP seeds, cookies, and tokens use operating-system protected
  storage. On Windows this is per-user DPAPI storage.
- The private Moodle calendar URL is stored only in Google Apps Script
  `UserProperties` for the signed-in user.
- The URL is never returned by MCP, written to calendar events, saved in a
  spreadsheet, or included in status/error output.
- The Google app requests only an app-created calendar, outbound Moodle fetch,
  and trigger-management scopes.
- Disconnecting removes the URL and trigger but leaves the calendar and events
  for the user to delete explicitly if desired.

See the full [privacy policy](docs/privacy.md), [security policy](SECURITY.md),
and [terms](docs/terms.md).

## Development

```powershell
cd packages/levnet-moodle-source
npm ci
npm test
npm run build

cd ../../apps/calendar-web
npm test
npm run check
```

On Windows, `npm run build:windows` creates the standalone MCP executable, and
`installer/windows/build-installer.ps1` creates the self-contained per-user
installer. The executable and installer are release artifacts, not committed
to Git.

## Release gates

The current release channel is a small personal pilot. Broader distribution
requires all of the following:

- Google OAuth consent-screen verification and a verified project domain.
- Authenticode signing for the Windows installer and embedded executable.
- A two-account end-to-end test with independent Moodle and Google accounts.
- Review of requested scopes, privacy text, dependency audit, and secret scan.
