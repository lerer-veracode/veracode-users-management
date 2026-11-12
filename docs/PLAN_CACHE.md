# Plan: fewer calls to Veracode

The app reads more from Veracode than it needs to:

- Roles and teams are read again each time the Edit form opens, and again for every change.
- The users list reads every user's record, one call per user. After any change it throws the whole list away, so the next view reads every record again.

In an organization of 2,000 users, that's about 2,000 calls after each edit. Roles and teams change rarely, and never through this app. This plan keeps them per connection, and reads users in bulk.

It builds on the `inspect` probes of 2026-11-10 (`docs/REALITY.md`, entries 1, 38 to 40):

| Call                                             | Gives                                                                                            |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `GET /v2/users?include_roles=true`               | The list, with each user's roles                                                                 |
| `GET /v2/users?detailed=true&include_teams=true` | The list, with each user's teams, `account_type` and `team_count`                                |
| `GET /v2/users/by_role/{roleId}`                 | Full records of a role's users: `last_login`, `pin_required`, `user_type`, permissions; no teams |
| `GET /v2/users/{id}`                             | One user's full record, with teams                                                               |

Tests never call Veracode: they use a stub of `fetch` and `e2e/fake-veracode.ts`, which learns the new calls. Nothing in this plan creates, changes or deletes a user on the real organization.

## Phase 1: read a team's relationship correctly

A user's team comes back with `relationship: { name, display_name }`, not the string `ADMIN` or `MEMBER` (entry 38). The app reads every team as a membership. Editing a Team Admin's teams would send their managed teams back as memberships, and take them away.

- `toUser` reads `relationship.name`, and still accepts a plain string.
- The local stand-in and the test stubs answer with the object, as Veracode does.
- `inspect-user` prints a team as `Blue (ADMIN)` from either form.

Success criteria:

- [x] With a stubbed `fetch`, a team with `relationship: { name: "ADMIN" }` reads as managed, `{ name: "MEMBER" }` and a missing relationship as a membership, and the plain strings still work.
- [x] An edit that changes only a Team Admin's memberships sends their managed teams back as `ADMIN` (backend test, and Playwright against the local stand-in).
- [x] `inspect-user` on the test user shows each team's relationship (the administrator runs it; read only). The values seen are recorded in entry 38.

## Phase 2: confirm the list's role and team fields

`inspect` shows structure only four levels deep, so the roles and teams inside the list show only as "object". One more read-only run settles their fields before phase 4 relies on them.

- `inspect` prints the first role and the first team of the first user one level deeper, for `include_roles=true` and `detailed=true&include_teams=true`.
- It also probes `include_roles=true&include_teams=true` and `detailed=true&include_roles=true&include_teams=true`, so we know whether one list call can carry both.

Success criteria:

- [x] Unit test: the deeper shape is printed, still with no values.
- [x] The administrator runs `npm run connect -- inspect`. Entry 1 records which combinations work, and whether the list's roles carry `role_name` and `is_api`, and its teams `relationship`.
- [x] Phase 4's calls are adjusted to what this shows. If the list's teams have no relationship, phase 4 reads it from `GET /v2/teams/{id}`, one call per team (entry 39).

## Phase 3: keep roles and teams per connection

- The backend reads a connection's roles and teams the first time they're needed after an app user signs in, and keeps them until the next sign-in or a refresh. There's no time limit and no background schedule: they change only on the Platform.
- Opening the add or edit form uses the kept lists, and makes no call to Veracode.
- The checks on a change (`readOrg`) use the kept lists too. A change that names a role or team that isn't in them reads that list again once before refusing, so a team just made on the Platform still works.
- The Users page's Refresh reads users, roles and teams again. A small ↻ next to "Member of teams" and "Manages teams" reads the teams again without closing the form.

Success criteria:

- [x] With a stubbed `fetch`: after the first read, opening the form twice and making two changes calls `/v2/roles` and `/v2/teams` zero more times.
- [x] A change naming a team that isn't in the kept list reads `/v2/teams` once, then succeeds if Veracode has the team, or is refused with "… isn't a team in this organization" if not.
- [x] A new sign-in, the Users page's Refresh, and the teams ↻ each read the lists again. The ↻ is tested in the dashboard and in Playwright.
- [x] The Activity log shows one `role.list` and one `team.list` per connection per sign-in, plus one per refresh.

## Phase 4: read users in bulk

`listUsers` builds the list from bulk calls in place of one call per user:

1. `GET /v2/users?detailed=true&include_roles=true&include_teams=true`, every page: who the users are, their roles and their teams. Phase 2 showed the three options work together (entry 1).
2. (Merged into step 1.)
3. Last login, `pin_required` and user type come from `by_role`. The roles are taken in order of how many users have them, counted from step 1. A role's pages are read until every user has been seen, so the most common roles usually cover everyone in a few calls.
4. A user no role covered, such as one with no roles, gets their own record read, as now.

Around it:

- A user's details, and the edit form, read that user's full record afresh when opened, unless that user was read in the last minute (by the list, or alone): then the kept copy is used, with no call. Otherwise one call, through a fixed URL with the id in the body (CWE-918). That record supplies direct permissions and current settings.
- After a create, edit or delete, the backend reads that one user again (or drops them) and updates the kept list, in place of throwing it away.
- The users list is kept for 15 minutes, or until Refresh.
- If any bulk call fails or returns users with fields missing, the backend falls back to today's one call per user, and the Activity log says why.

Expected calls, with `R` the roles in use and pages of 100:

| Users | Today, per load | After                                           | After an edit, today   | After an edit |
| ----- | --------------- | ----------------------------------------------- | ---------------------- | ------------- |
| 6     | 7               | about 4–6                                       | 9 (roles, teams, list) | 1             |
| 2,000 | about 2,020     | about 40 + `by_role` pages, typically under 100 | about 2,020            | 1             |

Success criteria:

- [x] With a stubbed `fetch` holding 250 users across 5 roles and 3 teams, one listing makes no `GET /v2/users/{id}` calls, and the users, roles, teams, last login, MFA and type match what the per-user reads give. Tested with 250 users across 3 roles (one an API role) and a team they're in or manage: 7 calls in all.
- [x] The same stub with one user who has no role: that user alone is read with `GET /v2/users/{id}`.
- [x] After an edit, the next listing makes exactly one call to Veracode, for that user. After a delete, none. The edit itself reads the user once; the listing after it makes none.
- [x] A failing `by_role` or `include_roles` call falls back to per-user reads, and the users still list. The fallback is in the Activity log. The failed call shows in the Activity log as a failed `user.list`; a list that ignores the options (no roles in it) falls back without a log line.
- [x] Opening a user's details reads that user's record once, and shows their direct permissions and teams.
- [x] Playwright against the local stand-in, which learns the bulk calls: the users page, filters, sorting by last login, details, add, edit and delete all still work. Last login shows in the list; sorting by it isn't checked in Playwright.
- [x] `npm run check` passes.

## Phase 5: check on the real organization

Read only, by the administrator, in the app.

Success criteria:

- [ ] The Users page shows the same users, roles, teams, type, last login and status as before this plan, checked against the Platform.
- [ ] The Activity log for one load shows the bulk calls and no `user.read` per user. Opening a user's details more than a minute after the list was read shows one `user.read`; sooner, none.
- [ ] Editing the test user (the only user that may be changed) shows a safety-check `user.read` before the `user.update`, and after it a second `user.read` only if the save reply didn't hold the user (the update line's "Got" says which). No full reload.
- [ ] `docs/REALITY.md` and `docs/STATUS.md` record what was seen.
