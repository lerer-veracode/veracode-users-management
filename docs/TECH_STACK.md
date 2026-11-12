# Tech stack

All TypeScript, Node 26, npm workspaces from the root `package.json`.

- `backend/`: Hono on Node. Holds the vault, the connections and the tokens, and is the only part that calls the Veracode API. Every route is under `/api` and has one job; the dashboard never sees a secret.
- `dashboard/`: React, Vite and TypeScript. Calls only the backend, through `/api`, proxied by Vite in development.
- `e2e/`: Playwright tests.
- `data/`: sample CSV files for import.
- `docs/identity-api-1.5.json`: the Veracode Identity API OpenAPI spec, version 1.5, from SwaggerHub.

## Veracode API

- Base URL per region: `https://api.veracode.com/api/authn` (US), `.eu` (EU), `.us` (US Federal).
- Auth: OAuth2 client credentials only. The app never uses HMAC credentials (API ID and key). `POST /v2/oauth2/token` with `grant_type=client_credentials` and the client ID and secret (`client_secret_basic`) returns a JWT. Send it as `Authorization: Bearer <token>`. Reuse it until shortly before it expires, then request a new one.
- Users: `GET /v2/users` (paged with `page` and `size`), `GET /v2/users/search`, `GET /v2/users/{userId}`, `POST /v2/users`, `PUT /v2/users/{userId}?partial=true`, `DELETE /v2/users/{userId}`.
- Roles: `GET /v2/roles`, paged like users.
- Roles and teams: `GET /v2/roles` and `GET /v2/teams`, every page. They change only on the Platform, so the backend reads each connection's once and keeps them until an app user signs in or a refresh (`?refresh=1`: the Users page's Refresh, or ↻ Refresh teams in the user form). The checks on a change use the kept lists, and read a list again once if the change names a role or team that isn't in it.
- Reading users, in bulk (`docs/PLAN_CACHE.md`, phase 4; `docs/REALITY.md` entries 1 and 39):
  1. `GET /v2/users?detailed=true&include_roles=true&include_teams=true`, every page (`page`, `size=100`; Veracode answers `page.total_pages`, not the spec's `totalPages`): the users with their roles and teams. Never `inactive`, which empties the list.
  2. `GET /v2/users/by_role/{roleId}`, most held roles first, until every user with a role has been seen: full records, with last login, MFA, user type and permissions. A user's own record has no last login.
  3. `GET /v2/users/{id}`, 8 at a time, for anyone still not seen, or for everyone if the list's options stop working.

  The backend keeps only the fields the app uses, and keeps the list for 15 minutes per connection; `?refresh=1` reads afresh. After a create, change or delete, it patches the kept list with that one user (keeping their last login) instead of reading it again. `POST /api/users/read` reads one user afresh when their details or the edit form open.

- Changing users (`backend/src/veracode/rules.ts` and `identity.ts`):
  - The dashboard posts to fixed URLs, `POST /api/users/create`, `/api/users/update` and `/api/users/delete`, with `connection_id` (the connection on screen), the user `id`, and `user`, `changes` or `confirm` in the body. A change is refused (409) unless `connection_id` is still the connection in use.
  - Before an update or delete, the backend reads the user afresh with `GET /v2/users/{id}` (the safety check, always made). It refuses (403) a user with the Administrator role (`extadmin`, or a role described as "Administrator") and any user that isn't a UI user. After an update, Veracode's reply is used as the saved user when it holds the whole record (user id, roles and teams); otherwise the user is read once more (`docs/REALITY.md`, entry 23).
  - Roles given must be roles of the organization, and never Administrator or an API role (`is_api`). Roles a user already has stay allowed in an update.
  - Create: `POST /v2/users` with `user_name` (the email address, unless the form gives a different one: no spaces, at most 256 characters, not already a user name in the organization), names, email, `active: true` and `roles: [{ role_name }]`. Update: `PUT /v2/users/{id}?partial=true` with only the fields that changed; roles, when sent, are the full new list. Delete: `DELETE /v2/users/{id}`, only when `confirm` equals the user name.
  - Scan types are roles too (docs.veracode.com, Identity API roles table): All scan types is `extsubmitanyscan`; the specific ones include `extsubmitstaticscan`, `extsubmitdynamicscan`, `extsubmitdynamicanalysis`, `extsubmitmanualscan`, `extsubmitdynamicmpscan` and a container scan type. The docs don't list them all, so any `extsubmit…` role other than Submitter, or any role with `is_scan_type`, counts as a scan type. Security Lead (`extseclead`), Creator (`extcreator`) and Submitter (`extsubmitter`) need at least one: All, or one or more specific types, never both. `GET /api/roles` gives each role a `kind` (`plain`, `scan_type`, `any_scan`, `needs_scan_type`, `team_admin`) so the dashboard can group them.
  - Teams: `GET /api/teams` lists the organization's teams (`GET /v2/teams`). A user's teams are sent as `teams: [{ team_id, relationship }]`, `MEMBER` or `ADMIN`, the full list whenever it changes. Team Admin (`teamAdmin`) must manage at least one team (`ADMIN`); there's no "all teams". Only a Team Admin can have `ADMIN`. A Creator or Submitter must be in at least one team unless they are also a Security Lead, on a create or an edit; Veracode refuses otherwise ("The roles provided require a team assignment", `docs/REALITY.md` entry 37), so the form and backend refuse it first, to save the wait for Veracode's answer. Security Lead alone needs no team. These rules are checked on the user's roles and teams after the change, whenever either changes.
  - Login enabled is `login_enabled`, and Require MFA is `pin_required` (the spec's "must provide a PIN to log in"). Both are sent like any other changed field. A new user is created with `login_enabled: true`, and `pin_required` as chosen (on by default). Enable or disable login in the Actions menu is an update with only `login_enabled`.
  - `GET /api/users` marks each user with `locked` (why it can't be changed, or `null`) and `GET /api/roles` each role with `assignable`, so the dashboard disables what the backend would refuse.
  - The audit log records each change as `user.create`, `user.update` or `user.delete`, with `reason` naming the user, `target` (the user's id and name), and `changes`: each field changed, from and to, in the words the dashboard uses (`backend/src/veracode/describe.ts`). A create has every field from `null`; a delete every field to `null`. "Before" is the user's record read from Veracode just before the change. The users cache is dropped after a change.
- Debugging: `npm run connect -- inspect` prints the structure of Veracode's answers (field names, types, list lengths and counts, never values). `npm run connect -- inspect-user USER_NAME ... [--email ADDRESS] [--connection NAME]` reads users' full records (`--email`: every user with that address), read only, and prints their values except sign-in secrets and similar fields (security question and answer, API credentials, session, IP addresses, phone, SAML subject), then the fields they have that the create request doesn't send.
- Tests: there is no Veracode test server. `VERACODE_API_BASE` points the backend at `e2e/fake-veracode.ts`, a stand-in for the Identity API that runs on this machine and keeps its users in memory. Only `http://localhost` or `http://127.0.0.1` is accepted.
- Docs: https://docs.veracode.com/r/c_identity_intro and https://app.swaggerhub.com/apis/Veracode/veracode-identity_api/1.5

## Local storage: the vault

Connections live in an encrypted vault file, `.local/vault.json` by default (`VAULT_PATH` overrides it). It is never committed: git ignores `.local/` and `vault*.json`, and the pre-commit hook (`scripts/check-no-vault.mjs`) refuses any staged file that looks like a vault, wherever it is. It isn't tied to a machine: copy the file and any app user can open it anywhere.

- **One data key, many app users.** A random 32-byte data key encrypts the connections with AES-256-GCM. Each app user has their own copy of the data key, encrypted with a key derived from their password by scrypt (random 16-byte salt per user, at least `N = 2^17`, `r = 8`, `p = 1`). Any app user with a valid username and password can open the vault; nobody else can. Node's built-in `node:crypto`, no extra packages.
- **Format:** JSON with `version`, `users` (each: `username`, `added_at`, `last_sign_in`, `removes_at`, `kdf` with the scrypt salt and cost, and `wrapped_key`, their copy of the data key as `iv`, `tag` and `ciphertext`) and `data` (`iv`, `tag`, `ciphertext`). Binary values are base64. Usernames and dates are readable; secrets are not.
- **Connections inside the vault:** name, region, client ID, client secret, `added_at` and `removes_at`. Also `last_used`: each app user's last-used connection id, in the encrypted part so the vault doesn't reveal who uses which organization. Every save drops entries for connections or app users that are gone.
- **The connection in use:** at sign-in and each refresh, the current one if still valid, else the app user's last-used one, else the only connection if there is just one; with several and no choice, none. `POST /api/connections/use` sets it, saves it as last used, and logs `connection.selected`.
- **Answers name their connection:** `GET /api/users` returns `{ connection: { id, name, region }, users }` and `GET /api/roles` `{ connection, roles }`. The dashboard ignores an answer whose connection isn't the one chosen. With several connections and none chosen, they answer 409 "Choose a connection first."
- **Saves:** a fresh `iv` every time; write a temp file, then rename it.
- **Sign in:** the dashboard's sign-in page sends the username and password to the local backend once. The backend unwraps the data key, decrypts the vault and keeps the connections in memory. The password, the data key and the secrets are never stored in plain text or sent to the browser. Wrong passwords are slowed down after each failure.
- **Sign out:** the button in the top bar, 30 idle minutes, or stopping the backend all clear the memory.
- **Tokens:** requested with client credentials when needed, kept in memory only, and reused until a minute before they expire.
- **`npm run connect`:** a terminal command, `backend/src/connect/`, with hidden input that never prints a secret. The first run creates the vault and the first app user. After that you sign in, then add, list or remove connections (`add`, `list`, `remove`) and app users (`add-user`, `remove-user`).
- **No recovery:** a forgotten password needs another app user to remove and re-add you. If no app user is left, delete the vault and start again with new client secrets.

## The 30-day limit

Every Veracode connection is removed 30 days after it is added. `MAX_AGE_DAYS = 30` is fixed and a connection cannot be extended; to keep going, add a new client secret. App users stay as long as they keep signing in.

- **Connections:** `removes_at = added_at + 30 days`. When it passes, the backend first revokes the connection on Veracode while it still can: all its tokens (`DELETE /v2/oauth2/client_credentials/{clientId}/tokens`), then the client itself (`DELETE /v2/oauth2/client_credentials/{clientId}`). Then it deletes the secret from the vault and drops any token from memory. If the revoke fails, the secret is still deleted and the failure is reported.
- **App users:** not limited from when they were added. Each successful sign-in, in the dashboard or in `npm run connect`, sets `last_sign_in` and moves `removes_at` to 30 days later. Only an app user who hasn't signed in for 30 days is removed: their copy of the data key is deleted and they can no longer sign in.
- **When it runs:** at every sign-in, each time the dashboard lists connections, every hour for signed-in sessions, and at every `npm run connect`. It can't run at backend start, because the vault needs a password to open. A connection or app user past its date is never used, even before the clean-up runs.
- **On Veracode too:** the app only runs when someone starts it, so the OAuth client must also be created on Veracode with an expiration of 30 days or less. Then it dies on Veracode even if the app never runs again.
- **Old copies:** removing an app user, by hand or after 30 days without signing in, can't reach a copy of the vault they made earlier. The 30-day limit on connections, enforced on Veracode, caps that exposure.

## The audit log

`backend/src/audit/audit.ts`. One JSON object per line in `.local/audit.log` (`AUDIT_LOG_PATH` overrides it), which git ignores. Each entry has `time`, `actor` (the app user, or `system` for the hourly clean-up), `action`, `outcome` (`ok` or `failed`), and when they apply `connection` (name, region, client ID), `reason` (`test`, `add`, `removed`, `expired`), `method`, `path`, `status` and `detail`. A user change also has `target` and `changes` (see Changing users above); only the create, update or delete call's own entry carries them, not the token or reads around it.

- **Every Veracode call:** the backend and `npm run connect` reach Veracode only through `auditedFetch`, so every call is logged with its HTTP status, including failed and refused ones. Actions: `auth.token`, `auth.revoke_tokens`, `auth.revoke_client`, `user.list`, `user.read`, `user.create`, `user.update`, `user.delete`, `role.list`, `team.list`, and `api.<method>` for anything else. A refused or failed user change is logged too, with what it tried to change and, in `detail`, Veracode's reason (its error message, never a token).
- **What they meant:** `auth.check` (a connection test and its result), `connection.added`, `connection.removed`, `connection.expired`, `app_user.added`, `app_user.removed`, `app_user.expired`, `app.sign_in` (including refused ones) and `app.sign_out`.
- **Who and why:** `withAudit` (AsyncLocalStorage) carries the app user, connection and reason, so calls made deep inside a request are attributed correctly.
- **Never logged:** headers, request and response bodies, secrets, tokens and passwords. Tests check for that.
- **Reading it:** `POST /api/audit/page` with `{ page, size, failed_only }` returns `{ entries, total, page, size }`, newest first; `size` is 50 (the default), 100 or 500. The body carries the page, so the request URL stays fixed. The dashboard's Activity page shows it. Each request reads the whole file, which is fine for now; a much larger log will need an index or rotation.

## Tools

- Testing: vitest (with Testing Library for the dashboard) and Playwright.
- Quality: ESLint, Prettier and `tsc`.
- Security: the Veracode CLI static scan in the pre-commit hook, and the Veracode package firewall for npm.
- CSV: papaparse.
