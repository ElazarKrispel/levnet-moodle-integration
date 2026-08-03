# Privacy Policy

Last updated: 3 August 2026

Levnet & Moodle Integration is an independent, self-hosted-by-the-user tool. It
does not operate a central database and the maintainer does not receive student
credentials, course data, calendar feeds, or Google tokens through the normal
product flow.

## Data processed locally

The local Codex plugin may process Microsoft sign-in details, a TOTP seed,
session cookies, Moodle/Levnet student data, and selected downloaded files.
Protected authentication values are stored using the operating system's secure
per-user facilities. Downloaded files are written only to a path selected by
the user.

## Data processed by Google

The Apps Script Web App stores the private Moodle iCalendar URL in that Google
user's `UserProperties`, fetches the feed directly from JCT Moodle, and creates
or updates events only in the secondary calendar created by the app. Google
processes this data under the user's Google account and applicable Google terms.

The app does not write the feed URL into HTML after setup, spreadsheets,
calendar events, logs, diagnostics, or error output. The maintainer does not
receive it.

## Retention and deletion

Local authentication data remains until the user clears it through the plugin
or the operating system. Disconnecting calendar sync deletes the feed URL and
scheduled trigger from user properties; the created calendar and events remain
until the user deletes them in Google Calendar.

## Sharing

The project does not sell or intentionally share personal data. Data is sent
only to the services required for the user's requested operation: JCT Moodle,
Levnet, Microsoft authentication, Google Apps Script, and Google Calendar.

## Contact

Use GitHub private vulnerability reporting for security/privacy incidents. Do
not include secrets or student records in public issues.
