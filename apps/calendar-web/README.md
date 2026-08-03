# Levnet & Moodle Calendar Web App

A standalone, user-owned Google Apps Script Web App that synchronizes a private
JCT Moodle iCalendar export into a dedicated Google Calendar. It runs in
Google's cloud, so scheduled synchronization continues when the user's computer
is off.

## Privacy and permissions

- The Moodle export URL is a bearer secret. It is stored only in that user's
  Apps Script `UserProperties`; it is never returned by status APIs, written to
  a page, event, log, or error message.
- The app requests `calendar.app.created`, so it manages only calendars it
  creates. It does not request access to the primary calendar or other existing
  calendars.
- Network access is allowlisted to the exact JCT Moodle calendar export path.
- Disconnecting removes the secret and daily trigger but leaves the created
  calendar and events in the user's account.

## Maintainer deployment

1. Create a standalone Apps Script project named `Levnet & Moodle Calendar`.
2. Copy its Script ID into a local `.clasp.json` using `.clasp.json.example`.
3. Push the source and create a versioned web-app deployment:

   ```powershell
   npx @google/clasp@latest push
   npx @google/clasp@latest deploy --description "Levnet & Moodle Calendar v2.0.0"
   ```

4. Deploy as **User accessing the web app**, restricted to signed-in users.
5. Put the resulting `/exec` URL in the plugin's private
   `LMI_CALENDAR_WEB_APP_URL` environment setting.

The first visit asks each person to authorize the narrow Google scopes. Setup
creates `Moodle – Assignments`, installs a daily trigger around 06:30 in
`Asia/Jerusalem`, and performs the first synchronization.

## Synchronization behavior

- Hebrew and English assignment titles become transparent one-hour events that
  end at the Moodle deadline.
- Notifications fire one week, one day, and two hours before the deadline.
- Deterministic SHA-256-based IDs prevent duplicates.
- Missing events are marked first and removed only after another successful scan
  at least 24 hours later.
- Empty, malformed, or failed source scans never drive deletion.
- Moodle remains the source of truth for managed events.

## Development

```powershell
cd apps/calendar-web
npm test
npm run check
```

The test suite covers the ICS parser, Hebrew and English titles, time zones,
one-hour events, deterministic IDs, idempotency, delayed deletion, secret
redaction, manifest scopes, and the standalone web-app surface.
