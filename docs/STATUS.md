# Status

The vault, `npm run connect`, sign-in, the Connections and Activity pages, and reading the organization's real users and roles are real. Adding, changing and deleting users (phase 5b) is built and tested against the local stand-in for Veracode; it hasn't been tried on the real organization yet. Plan: `docs/PLAN_API.md`, phases 1 to 4 and 5a done, 5b built, 5c next.

## Where we left off (2026-11-11)

Next, in this order:

1. **Done: `docs/PLAN_CACHE.md` phase 6** is merged into `main` (pull request #1).
2. **Done 2026-11-12: linked to GitHub**, https://github.com/lerer-veracode/veracode-users-management (private). `main` was pushed as one commit with no earlier history; the earlier history stays on this computer only, in the local branches `history/main` and `history/cache-6-users-first`, never to be pushed. Commits are authored with the administrator's personal email. Email addresses and user names stay out of the repository: the test user's details are in `.local/test-user.md`. The GitHub CLI (`gh`) is installed; on Windows run it from PowerShell (it isn't on the Git Bash path). A CI pipeline (format, lint, typecheck, unit tests, e2e and the Veracode scan, with the Veracode API credentials as repository secrets, never in the code) is its own phase, planned first.
3. **Offered, not yet agreed:** a read-only timing test, to see whether Veracode queues calls sent at the same time (one call alone, then the same call four at once). Veracode's Identity API took 3 to 4 seconds per call on 2026-11-10 and 9 to 11 on 2026-11-11.
4. Then phase 5c of `docs/PLAN_API.md`, step 2, changing the test user on the real organization, run by the administrator by hand in the app. Read the phase's rules first; they repeat the hard rules in `AGENTS.md`.

- **`docs/PLAN_CACHE.md`, fewer calls to Veracode:** phases 1 to 4 are done. Roles and teams are kept per connection until a sign-in or a refresh. Users are read in bulk: the list with its options gives roles and teams, `by_role` gives last login, MFA and type, and a user's own record is read only when needed. After a change, only that user is read. Last login now shows on the real organization: a user's own record never had it (entry 39). **Phase 5 is for the administrator, read only:** compare the Users page with the Platform, and check the Activity log for one load (no `user.read` per user) and after an edit of the test user (one `user.read`).

- **Confirmed, not merged (2026-11-12):** `docs/PLAN_CACHE.md` phase 6. The Users page shows users after the bulk list, then fills in last login, type and MFA from the `by_role` reads; the roles are read once per load, alongside the list. Phase 5 of that plan (the administrator's read-only checks) is still open for the edit check.
- **SCA scans and the package firewall (2026-11-12 and 13), branch `fix/prepare-without-dev-tools`:** the SRCCLR agent runs `npm install --only production` in place, which removed the dev tools and failed on `prepare` (REALITY entry 42). `prepare` now skips the git hook when simple-git-hooks isn't installed. Scan a clean clone, not the working folder. A clean install (empty npm cache) failed with 401 on every download: the firewall key in the registry URL is used for lookups only. `.npmrc` now holds the key as the firewall's `_auth`, with the other credential keys empty, so it works on any machine and in CI and beats the user's own npm settings (REALITY entry 19). The old URL format, with notes on converting it, is in `.local/npmrc-formats.npmrc`. SCA's count of 7 is right: it counts production dependencies only, and the app has 6.
- **Dependency upgrades (2026-11-13), branch `fix/upgrade-vitest-hono`:** after the SCA scan, `vitest` and `@vitest/coverage-v8` 3.2.7 → 5.0.5 (three Medium CVEs in `@vitest/mocker`; 5.1.0 is blocked by the firewall, REALITY entry 43) and `@hono/node-server` 1.19.18 → 2.1.8 (a moderate `serveStatic` advisory; the app doesn't use `serveStatic`). jest-dom's types needed a small file for Vitest 5 (entry 44). `npm audit --omit=dev` finds nothing. Still open, dev tools only: `minimatch` through `typescript-eslint`, with no fixed version yet.
- **New way of working (2026-11-10):** each new phase gets its own branch and an early draft pull request, commits only with substance, CI checks before finishing, and a squash merge. See "Branches and pull requests" in `docs/PROCESS.md`. The GitHub remote exists since 2026-11-12; there is no CI/CD yet.
- **Fewer reads and a clearer Activity log (2026-11-10):** each call to Veracode in the log now says why it was made, how long it took, and what came back as counts only. Opening a user's details or edit form within a minute of reading them uses the kept copy. After a save, the user is read again only if Veracode's reply didn't hold them. The safety check before every change stays. To see on the next edit of the test user: what the `user.update` line "Got" (REALITY entry 23).
- **The test user exists:** its user name, id and connection are in `.local/test-user.md` (git-ignored, so they never reach GitHub). Created 2026-11-09 as Security Lead with Any Scan and no team, and since changed: on 2026-11-10 it was Creator and Submitter with Any Scan, a member of Developers. The one-user allowance is used: **no other create**, and only this user may be changed or deleted.
- **Step 1 is done** (entry 37): Creator or Submitter needs a team unless the user is also a Security Lead, on a create and on an edit. The form and backend now refuse such a combination before sending it.
- Earlier refused creates, in the Activity log (`.local/audit.log`): the email was an existing user's user name (entry 35); `username` in place of `user_name` (entry 36); Creator and Submitter with no team (entry 37).
- **Useful while testing:** `npm run connect -- inspect-user USER_NAME` or `--email ADDRESS` prints users' full Veracode records, read only, with sign-in secrets hidden. Use it to compare the test user with the Platform after each change.
- **Questions for the administrator:** none open. The decisions made so far are in the docs: Security Lead alone needs no team, and lifts the team rule for Creator and Submitter; API and SAML users and administrators can't be changed; Require MFA is `pin_required` (entry 32, to confirm in step 2.3).

## Run it

```
npm install
npm run dev
```

Open http://localhost:5173. `npm run check` runs every check; the first time, run `npx playwright install chromium` in `e2e/`.

## Built

- `backend/`: Hono on port 8787. Open routes: `GET /api/health`, `GET /api/regions`, `POST /api/session` (sign in with an app user; an `HttpOnly`, `SameSite=Strict` cookie; slower after each wrong password). Behind sign-in: `GET` and `DELETE /api/session`, `GET /api/connections` (no secrets), `POST /api/connections/use`, `POST /api/connections/test` (the connection id in the body, so no request URL carries data), `GET /api/app-users`, `GET /api/users`, `GET /api/roles`, and `POST /api/users/create`, `/update` and `/delete`. Sessions end after 30 idle minutes. The vault is re-read on each listing, so `npm run connect` changes show up without signing in again.
- `backend/src/vault/`: the encrypted vault (scrypt and AES-256-GCM, one data key wrapped per app user), app users with the 30-day sliding removal, and connections removed 30 days after they are added.
- `backend/src/veracode/`: OAuth client-credentials tokens with an in-memory cache, the access check (`GET /v2/users?size=1`), and revoking a client's tokens and the client.
- `npm run connect` (`backend/src/connect/`): creates the vault and first app user, signs in, cleans up expired connections (revoking them on Veracode) and idle app users, and runs `add`, `list`, `remove`, `add-user`, `remove-user`, `inspect`, `inspect-user` and `help`. It needs a real terminal for hidden input.
- `dashboard/`: the dark theme, styled on the Veracode Platform, with sample data for tests in `dashboard/src/mock/data.ts`:
  - **Sign in** (real): styled on the Veracode sign-in page, with "Un-official" on it, a warning not to use a Veracode password, and username then password steps, checked against the vault. Sign out is in the top bar, next to an "Un-official" badge. Clean-up notices show as banners.
  - **Connections** (`#/connections`, real): the vault's connections with region, token state and days left; Test checks the credentials against Veracode and shows why it failed; Use switches the organization in the top bar; the app users with their last sign-in and days left. There is no secret field.
  - **Activity** (`#/activity`, real): the audit log, newest first, 50, 100 or 500 per page (50 by default), with a Failed only filter over the whole log. **Export** asks for a date range; the export itself is mocked and not built yet.
  - **Connection picker** on the Users and Import pages: shows which connection the list comes from (name, region, client ID) and switches it. With one connection the users load straight away; with several and none chosen, it asks first. The last-used connection is remembered per app user.
  - **Users** (real): the organization's users from Veracode with filters, sorting and paging; a user's details show their roles, the permissions each grants, direct permissions, and the teams they manage apart from the teams they're a member of. **Add New User**, and **Edit** and **Delete** in a user's details, change users on Veracode: each change is reviewed first (what changes, in which organization), and a delete needs the user name typed. Administrators, API and SAML accounts can't be changed, and the Administrator and API roles are never offered. The form handles scan types (All, or specific ones, container included) for Security Lead, Creator and Submitter; team memberships and the teams a Team Admin manages, each a drop-down of the organization's teams; and Login enabled and Require MFA. Each row's Actions menu has View details, Edit, Enable or Disable login (after a confirmation) and Delete.
  - **Import CSV**: previews a file against the real users and roles; Apply is disabled until phase 6.
- `e2e/`: Playwright tests on their own ports (backend 8788, dashboard 5174) with a throwaway vault in `e2e/.tmp/`: health, a refused password, sign-in and the Connections page, the users page, adding, editing and deleting a user (and an administrator who can't be changed), and the CSV preview. They run against `e2e/fake-veracode.ts`, a stand-in for the Veracode API on this machine; they never reach Veracode.
- `data/sample_users.csv`: a sample import with one bad row.

## Not built yet

- Phase 5b's last step: trying it on the real organization, with one test user, when the administrator asks.
- Phase 6: applying the CSV import, and export.

## In place

- The audit log (`.local/audit.log`, see `docs/TECH_STACK.md`): every user change with who made it, the user, and each field from and to; every Veracode call, connection test, sign-in, and connection or app user added, removed or expired, from both the backend and `npm run connect`. `POST /api/audit/page` serves it one page at a time.
- The pre-commit hook refuses vault files (`scripts/check-no-vault.mjs`) and runs a Veracode static scan (`scripts/veracode-scan.mjs`). The latest scan passed with 2 Medium findings: CWE-312 in `backend/src/server.ts` and `backend/src/connect/main.ts`. CWE-918 (SSRF) in the dashboard's API client is fixed: every request goes to a fixed URL.
- npm installs go through the Veracode package firewall on any machine, whatever the user's own npm settings (`.npmrc`, firewall URLs in `package-lock.json`; see "Packages" in `docs/PROCESS.md`).
- Export to CSV.
- The light theme (see `docs/BRAND.md`).
