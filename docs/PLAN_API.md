# Plan: the API connection

Turns the mock into a working app: the encrypted vault, `npm run connect`, sign-in, OAuth tokens, and the live users and roles of a Veracode organization. It follows `docs/SPEC.md` and the design in `docs/TECH_STACK.md` ("Local storage: the vault" and "The 30-day limit").

The order puts the secret handling first, since everything else depends on it, and the terminal command before the web routes, so real credentials can be added and tested before the dashboard uses them. Phases 1 to 3 have no dashboard changes. Tests never call the real Veracode API: they use a stub of `fetch`, and the end-to-end tests use `e2e/fake-veracode.ts`, a stand-in for the Veracode API on this machine. There is no Veracode test server: every connection is a real organization.

## Phase 1: the vault

`backend/src/vault/`: the vault file and its crypto, as pure functions plus a small file layer.

- `crypto.ts`: scrypt key derivation (`N = 2^17`, `r = 8`, `p = 1` by default; the settings are stored with each user, so tests can use cheaper ones) and AES-256-GCM `seal` and `open`.
- `vault.ts`: `createVault` (first app user and an empty list of connections), `unlock` (username and password give the data key and the connections), `saveData`, `addUser`, `removeUser`, and `recordSignIn`, which moves the user's removal date to 30 days after now.
- `retention.ts`: `MAX_AGE_DAYS = 30`; which connections and app users are past their date.
- `file.ts`: read the vault, and write it to a temp file and rename it. The path is `VAULT_PATH`, or `.local/vault.json` at the repo root.

Success criteria:

- [x] A vault created for one user unlocks with that username and password, and gives back the connections saved in it.
- [x] A wrong password, an unknown username or a changed byte in the file all fail to unlock with "Wrong username or password" or "The vault is damaged".
- [x] A second app user added by the first can unlock the same vault; a removed user can't.
- [x] The last app user can't be removed.
- [x] An app user whose removal date has passed can't sign in; signing in moves the removal date to 30 days later.
- [x] Connections are given `removes_at = added_at + 30 days`, and the expired ones are found.
- [x] The vault file contains no client secret in plain text, and every save uses a new `iv`.
- [x] Unit tests pass with 80% coverage.

## Phase 2: the Veracode OAuth client

`backend/src/veracode/`: talking to the Identity API with a connection's credentials.

- `oauth.ts`: `getToken` (`POST {base}/v2/oauth2/token`, `grant_type=client_credentials`, `client_secret_basic`), a token cache in memory that reuses a token until a minute before it expires, and `revokeConnection`, which deletes the client's tokens and then the client.
- `identity.ts`: `checkAccess`, which calls `GET {base}/v2/users?size=1` to prove the connection can read users.
- Errors carry the HTTP status and Veracode's message, never the secret.

Success criteria:

- [x] With a stubbed `fetch`, `getToken` sends Basic auth and the right form body to the region's token URL, and returns the token and its expiry.
- [x] A second call before expiry reuses the cached token; a call within a minute of expiry gets a new one.
- [x] `checkAccess` reports "Connected" on 200, and a clear message on 401 and 403.
- [x] `revokeConnection` calls the two DELETE endpoints in order and reports each result; a failure doesn't throw.
- [x] No error message or log line contains the client secret or a token.

## Phase 3: `npm run connect`

`backend/src/connect/`: the terminal command, with prompts behind a small interface so tests can answer them.

- The first run creates the vault and the first app user (username, then a password of at least 12 characters, typed twice), then adds a connection.
- Later runs sign in first; the sign-in extends the app user, removes expired app users, and revokes and removes expired connections.
- Commands: `add` (the default), `list`, `remove [name]`, `add-user`, `remove-user [username]`, `help`.
- `add` asks for a name, the region, the client ID and the secret, then gets a token and checks access before saving. If the check fails, it asks whether to save anyway.
- Secrets and passwords are read with hidden input, and the command refuses to run without a terminal.

Success criteria:

- [x] `npm run connect -- help` prints the commands.
- [x] With scripted answers and a stubbed `fetch`: the first run creates a vault and saves a tested connection; `list` shows it with "30 days left"; `remove` revokes it on Veracode and deletes it.
- [x] `add-user` adds a user who can then sign in; `remove-user` removes them; removing the last user is refused.
- [x] Signing in after a connection's date has passed revokes it and removes it, and says so.
- [x] Passwords under 12 characters, mismatched passwords, duplicate connection names and a wrong sign-in are refused with a clear message.
- [x] Nothing the command prints contains a secret or a password.
- [x] Run by hand against the real Admin API service account: a connection is added, tested and listed. Confirmed by the administrator on 2026-11-12: the connection in use is a real organization.

## Phase 4: sign-in and sessions in the backend

- `POST /api/session` (username and password) unlocks the vault and starts a session in an `HttpOnly`, `SameSite=Strict` cookie; `DELETE /api/session` signs out; `GET /api/session` says who is signed in.
- The session ends after 30 idle minutes or when the backend stops. Each wrong password waits longer before answering.
- The 30-day clean-up runs at each sign-in, each time the connections are listed, and every hour for signed-in sessions. It can't run at start: the vault can't be opened without a password. A connection past its date is never used either way.
- `GET /api/connections` (no secrets), `POST /api/connections/use`, `POST /api/connections/test` (the connection id in the body, so no request URL carries data).
- The dashboard's sign-in page and Connections page use these routes in place of the mock.

Success criteria:

- [x] Sign-in with a valid app user returns 200 and a cookie; a wrong password returns 401 and the next attempt is slower.
- [x] Every route except `/api/health`, `/api/regions` and `POST /api/session` returns 401 without a session.
- [x] `GET /api/connections` never contains a secret; checked by a test that searches the response for it.
- [x] A session idle for 30 minutes is signed out (tested with a fake clock).
- [x] In the browser (Playwright, with a throwaway vault on its own ports): a wrong password is refused, sign in, see the vault's connection and its days left, sign out. Testing and switching connections are covered by the dashboard tests with a fake backend.
- [x] Run by hand with the real vault: sign in, test the real connection, see "Connected". Confirmed by the administrator on 2026-11-12.

## Phase 5a: read the real users and roles

- `GET /api/users` and `GET /api/roles` for the connection in use. They read every page of `/v2/users`, then each user's record (`/v2/users/{id}`) for roles, permissions, teams and last login, and every page of `/v2/roles`, keeping only the fields the app uses. The real API differs from the spec: the list's options return no users, and paging is `page.total_pages`.
- The Users page shows the real users, with filters, sorting and paging in the browser. A user's details show their roles, the permissions each role grants, permissions given directly, and teams.
- Until phase 5b, the page is read only: Add, Edit, Delete and the CSV import's Apply are disabled.
- End-to-end tests run against the local stand-in (`e2e/fake-veracode.ts`), through `VERACODE_API_BASE`, which only accepts a local address.

Success criteria:

- [x] Against a stub of `fetch` and the local stand-in, the routes read every page with a Bearer token and return only the mapped fields.
- [x] Reading users and roles appears in the audit log as `user.list` and `role.list` with the app user and organization.
- [x] A 401 or 403 from Veracode shows "The <name> connection is not allowed to do this (403). It needs the Admin API role." in the dashboard; an unreachable Veracode and no connection in use are explained too.
- [x] In the browser against the local stand-in: the users, filters, a user's roles, permissions and teams, and the import preview against the real users.
- [x] Run by hand against the real organization: the users list and their roles match the Veracode Platform. Done 2026-11-13, after `docs/PLAN_ROLES.md`.

## Phase 5b: change users

- `POST /api/users/create`, `/api/users/update` and `/api/users/delete`, at fixed URLs with the user id and the connection on screen in the body (CWE-918), each with a confirmation in the dashboard showing what will change and in which organization.
- The add and edit form, and delete with the user name typed to confirm, on the Users page.
- Every change is in the audit log as `user.create`, `user.update` or `user.delete` with the app user and organization, because these calls go through `auditedFetch`.
- The Administrator role is read only: the backend refuses to change or delete an administrator or to give the role. It also refuses API roles, and changes to API or SAML accounts.

Success criteria:

- [x] Against a stub of `fetch`, each route calls the right Identity API endpoint with a Bearer token and the right body, and nothing reaches Veracode for a refused change.
- [x] Administrators, API and SAML accounts can't be changed or deleted; the Administrator and API roles can't be given, whatever the dashboard sends.
- [x] A change for a connection other than the one in use is refused.
- [x] Each user change appears in the audit log and on the Activity page with the right action, app user, organization and user.
- [x] In the browser against the local stand-in (`e2e/fake-veracode.ts`): add, edit and delete a user; an administrator can't be edited or deleted.
- [x] Scan types for Security Lead, Creator and Submitter (All, or specific ones), team memberships, and the teams a Team Admin manages, checked in the dashboard and the backend.
- [ ] On the real organization, only when the administrator asks: create one test user, edit it, delete it. No other user is touched, and the Administrator role is never given. Done in phase 5c.

## Phase 5c: check user changes on the real organization

There is no Veracode test server, so this runs on the real organization, by the administrator, by hand in the app. Claude reads the Activity log after each step and records what Veracode did in `docs/REALITY.md`.

The rules for this phase (see `AGENTS.md`):

- At most one user is created. A create that Veracode refuses creates nothing, so refused attempts come first; the first create that succeeds is the test user, and no other create follows.
- Only the test user is changed or deleted. No other user is touched, and the Administrator role is never given.
- The test user's email address is not any existing user's user name (`docs/REALITY.md`, entry 35).

### 1. Which roles need a team to create a user

Each attempt has its scan type and no team. Stop at the first one Veracode accepts: that user is the test user.

1. Creator: refused, "The roles provided require a team assignment." (seen 2026-11-09, with Submitter).
2. Submitter alone: needs a team, like Creator (the administrator's test, 2026-11-09).
3. Security Lead alone: accepted with no team. This is the test user (2026-11-09).
4. Not needed.

Done. Editing the test user then showed the rule also applies to edits, and that Security Lead lifts it: Creator and Submitter with no team was refused, Creator, Security Lead and Submitter with no team was accepted. The form and backend now refuse such a combination before sending it (entry 37).

Other roles (Reviewer, Executive and so on) are checked through edits of the test user in step 2, not by creating more users.

### 2. Change the test user

Each through the app's form or Actions menu, with its review. After each, check the Activity log's from and to, and the user in the Veracode Platform:

1. First and last name, and email address.
2. Disable login from the Actions menu, then enable it again.
3. Require MFA off, then on; check it's the Platform's MFA setting (entry 32).
4. Scan types: All, then specific ones including container; note the container scan type's role name (entry 31).
5. Roles: add Reviewer, remove a role; check the roles sent replace the user's roles (entry 23).
6. Teams: join a second team, leave one; check the teams sent replace the user's teams (entry 29).
7. Team Admin, managing one team; check the Platform shows them managing it (entry 26).
8. Remove all teams while the user has a team-level role, to see whether edits need a team too (entry 37). Settled in step 1: they do, unless the user is a Security Lead, and the app now refuses it before sending.

### 3. Delete the test user

Delete it from the Users page, typing its user name. Check it's gone from the app's list and from the Platform, and the Activity log keeps its last settings.

Success criteria:

- [ ] Steps 1 to 3 done; at most one user was created, and only it was changed and deleted.
- [x] `docs/REALITY.md` says, for Creator, Submitter and Security Lead, whether a new user needs a team (entry 37), with the date and Veracode's message.
- [ ] Each change in step 2 shows on the Activity page with the right from and to, and matches the Platform.
- [ ] The open entries this phase can settle (23, 26, 29, 31, 32, 37) are Confirmed or corrected.
- [ ] Any form check that turns out wrong is fixed, with tests.

## Phase 6: CSV import, export and end-to-end

- `POST /api/import` applies the planned creates and updates one by one and reports each row's result.
- The CSV's roles follow the same rules as the form: scan types for Security Lead, Creator and Submitter, and a Team Admin needs teams to manage. Decide how the CSV gives scan types and teams before building it.
- Export the filtered users to CSV.
- Playwright tests run against the local stand-in.

Success criteria:

- [ ] Importing `data/sample_users.csv` against the local stand-in creates three users and reports the bad row.
- [ ] A failure on one row doesn't stop the others, and the report shows which failed and why.
- [ ] Export downloads a CSV in the import format that imports back with "No change" on every row.
- [ ] `npm run check` passes.
