# Levnet & Moodle Integration

An independent, unofficial Codex plugin for JCT Moodle and reviewed Levnet
student operations. It supports courses, deadlines, grades, tests, protected
downloads, account-bound confirmed actions, and automatic Google Calendar
synchronization.

## Personal-first architecture

- One local MCP server and one Codex skill per person.
- Credentials, TOTP seed, cookies, and preparation keys are protected by the
  operating system. On Windows they use per-user DPAPI storage under the new
  `LevnetMoodleIntegration` namespace.
- Existing JCT plugin secrets are copied into the new namespace on first run.
  Migration is idempotent and never deletes the old values.
- Moodle and Levnet keep independent sessions while sharing the same protected
  Microsoft sign-in material.
- No developer-operated server or shared student database exists.

## Calendar connection

`lmi_moodle_prepare_calendar_pairing` and
`lmi_moodle_execute_calendar_pairing` use an account-bound,
single-use `prepare → confirm → execute` flow. The private iCalendar URL is
shown only in a native local copy dialog and never enters MCP output or chat.

The execute step opens the standalone **Levnet & Moodle Calendar** Apps Script
Web App. Each signed-in Google user gets independent `UserProperties`, a
dedicated `Moodle – Assignments` calendar, and a daily trigger around 06:30 in
`Asia/Jerusalem`. The sync runs in Google's cloud when the computer is off.

Events are transparent, last one hour, and end at the Moodle deadline. They
have week, day, and two-hour reminders. Deterministic IDs prevent duplicates;
missing source events are deleted only after another successful scan at least
24 hours later.

## First run

Start with `lmi_preflight`. If the authenticator seed is missing, the skill
guides one Microsoft Security Info setup while passwords, TOTP setup keys, and
verification codes remain outside chat. Normal renewal then uses the local
integration without browser automation.

The Windows pilot package includes its own runtime. Source development requires
Node.js 20 or newer and Chrome, Chromium, or Microsoft Edge. Linux additionally
requires `secret-tool` and `zenity`.

## Safety boundary

- Levnet discovery is metadata-only. Executable calls come from a manually
  reviewed typed allowlist.
- Mutations use account-bound, expiring, single-use confirmation tokens and are
  never retried after an ambiguous dispatch.
- Downloads stream through a size-limited temporary file and cannot escape the
  user-selected directory.
- Payments, signatures, CAPTCHA, and unsupported uploads remain official-browser
  flows.
- The Moodle calendar URL must never appear in chat, logs, screenshots, issues,
  shared sheets, or calendar events. Reset it in Moodle if exposed.

## Development

```powershell
cd packages/levnet-moodle-source
npm install
npm test
npm run build
npm run build:windows

cd ../../apps/calendar-web
npm test
npm run check
```

The Apps Script Web App is deployed separately from `apps/calendar-web`. The
Windows installer is built with `installer/windows/build-installer.ps1` after
the standalone server executable exists.
