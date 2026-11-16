# Plan: reset a user's MFA

Asked for by the administrator on 2026-11-16, as urgent: one phase, built straight away.

The Identity API's `POST /v2/users/{userId}/reset_mfa` resets a user's MFA: Veracode has them set it up again at their next sign-in. Whether the user had MFA set up doesn't matter: success or failure is reported either way.

## Rules

- Allowed for UI users and API accounts (API accounts have MFA too).
- Never for a user with the Administrator role, and never for a SAML user: their sign-in and MFA belong to their identity provider. The backend checks this on the user as Veracode has them now, whatever the dashboard sent.
- The administrator types the user name to confirm, as for a delete. The dialog names the organization.
- No manual test of the SAML refusal on a real organization (the administrator's decision).

## Phase 1: Reset MFA

- [x] Backend: `POST /api/users/reset-mfa` (sent to Veracode with `{}` and a JSON Content-Type, REALITY entry 46) reads the user afresh, refuses an administrator or a SAML user (403) and a wrong confirmation (400), then calls `reset_mfa`.
- [x] Each user carries `mfa_locked`: why their MFA can't be reset, or null.
- [x] Activity log: the call is `user.reset_mfa`, with purpose "Reset a user's MFA", reason "reset MFA of USER (TYPE user)", the user, and "MFA setup: As the user set it up → Reset: set up again at next sign-in". A refusal from Veracode is logged with its message.
- [x] Dashboard: "Reset MFA" in each user's Actions menu and details, disabled with the reason for administrators and SAML users; a confirmation dialog; a notice when done.
- [x] Tests: backend (UI and API reset, administrator and SAML refused, wrong confirmation, log entry), dashboard (dialog, disabled cases, error shown), end to end (reset from the menu, seen in the Activity log).
- [ ] The administrator resets the MFA of the test user on a real organization, and checks the Activity log.
