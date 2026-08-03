---
name: levnet-moodle-integration
description: Use whenever the user wants Levnet or JCT Moodle student services, account setup, courses, assignments, deadlines, Google Calendar synchronization, grades, tests, reviewed downloads, or authentication repair.
---

# Levnet & Moodle Integration

Use the local Levnet & Moodle Integration tools for Moodle and allowlisted Levnet operations. Prefer these tools
over browser or UI automation. The providers share Microsoft credentials but
maintain separate application sessions.

## Routing order

1. Call `lmi_status`.
2. If credentials are complete, use the integration tools only. Refresh expired sessions
   with `lmi_refresh_sessions`; do not use Computer Use.
3. If setup state is unclear or a local prerequisite is missing, call
   `lmi_preflight`.
4. Use [@Computer](plugin://computer-use@openai-bundled) only when preflight
   explicitly returns `onboarding.useComputerUse: true`. This is the one-time
   authenticator bootstrap path.
5. Once `credentials.present.mfaSeed` is true, never use Computer Use for institutional
   authentication, even if another credential or provider session is missing.

## First-run authenticator bootstrap

When preflight reports `authenticator_seed_missing`:

1. Use Computer Use to open the user's browser and navigate to the exact
   `onboarding.url` returned by preflight.
2. Help navigate to Microsoft Security Info and the option for adding an
   authenticator app.
3. Before creating or changing the authentication method, hand control to the
   user. The user must complete the security-sensitive steps, choose manual
   setup when offered, and copy the base32 setup key themselves. Do not inspect
   or repeat the QR code, setup key, password, or verification code.
4. After the user says the setup key is ready, call `lmi_setup` with
   `authenticatorReady: true`. Native secure dialogs collect the email,
   password, and setup key outside chat.
5. Call `lmi_status` again and report Moodle and Levnet readiness separately.

Keep the bootstrap moving once the user reaches the manual setup-key screen so
the Microsoft activation page does not expire. The native setup asks for the
setup key first, then email and password. If Microsoft reports that activation
expired, tell the user the old key is invalid and restart authenticator
creation. Never reuse or store an expired key.

If Computer Use is unavailable, give the user the preflight URL and the same
handoff instructions, then continue with `lmi_setup` after they are ready.

## Normal operations

- Courses: `lmi_moodle_courses`
- Deadlines and action events: `lmi_moodle_calendar_events`
- Google Calendar pairing: call `lmi_moodle_prepare_calendar_pairing`, show the
  user its security preview, and wait for explicit confirmation. Then call
  `lmi_moodle_execute_calendar_pairing` once with `confirm: true`. The private
  Moodle iCalendar URL is copied through a native local dialog and is never
  returned to the model. The execute step copies it locally and opens the
  Levnet & Moodle Integration Google connection page when configured. Tell the
  user to paste it only into that page, never into chat. A new prepare token is
  required after cancellation or failure.
- Assignment details: `lmi_moodle_assignment`
- Moodle file downloads: `lmi_moodle_download_resources`, only for exact
  Moodle resource URLs the user asked to download and an explicit local output
  directory. Report every file written.
- Levnet capabilities: `lmi_levnet_capabilities`. Only operation IDs returned
  by this reviewed allowlist are executable.
- Levnet reads: `lmi_levnet_read`, or the typed grades, tests, and notebook tools.
- Levnet downloads: `lmi_levnet_download`; use
  `lmi_levnet_download_notebook` for a selected scanned notebook. Always use an
  explicit output directory and report the written file.
- Unknown Levnet surfaces: inspect metadata with
  `lmi_levnet_endpoint_inventory`. Discovery output is never executable.
- Levnet writes: call `lmi_levnet_prepare_action` only for the exact action the
  user requested. Show its preview and wait for explicit confirmation before
  calling `lmi_levnet_execute_action`. High-risk actions require the second
  confirmation flag.
- Never reuse a prepare token. If execution returns `unknown_outcome`, do not
  execute again; use `lmi_levnet_reconcile_action` and report whether the
  change is applied or still indeterminate.
- Payments, signatures, CAPTCHA, and unsupported uploads use
  `lmi_levnet_open_official_flow`. Never collect card details or one-time codes.

## Privacy and safety

- Treat credentials, authenticator seeds, cookies, tokens, student records,
  course names, assignments, and API responses as private.
- Treat the Moodle calendar export URL as a bearer secret. Never include it in
  chat, tool output, logs, screenshots, issue reports, or shared spreadsheet
  cells. If it is exposed, direct the user to Moodle Security keys at
  `https://moodle.jct.ac.il/user/managetoken.php` to reset the calendar key.
- Never ask for or accept credentials, cookies, QR codes, authenticator setup
  keys, or one-time codes in chat.
- Never invent an operation ID or translate discovery output into a raw API
  call. Only actions returned by `lmi_levnet_capabilities` are executable.
- Use `lmi_clear_sessions` for logout. Set `alsoCredentials: true` only when the
  user explicitly asks to remove protected Microsoft credentials.

## Platform behavior

Version 2 is distributed for Windows first and uses per-user DPAPI protection
plus native secure dialogs. The underlying implementation retains macOS
Keychain and Linux Secret Service support for later validation. Follow preflight
remediation when PowerShell or Chrome/Edge is unavailable.
