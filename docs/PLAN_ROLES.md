# Plan: roles and permissions as the Platform shows them

Before the CSV import (`docs/PLAN_API.md`, phase 6). The administrator compared the Users page with the Veracode Platform (`docs/PLAN_API.md`, phase 5a) and found two differences (`docs/REALITY.md`, entry 41):

- The Platform shows some roles as settings: "Any Scan" and the scan-type roles are "Allowed Scan Types", and "No Team Restriction API" is an API account's "Team Memberships: No Team Restrictions". The app lists them as plain roles in the Users table, the role filter and a user's details.
- Some permissions are of no use here and clutter a user's details: anything about DynamicMP or VSA, "Manage Vendor Contact Requests", "Manage rules in SourceClear workspace", and others the administrator names.

Display only: the roles Veracode holds, the rules on a change and what is sent to Veracode stay as they are. Nothing here changes a user on the real organization.

## Phase 1: a file of permissions to hide

- `config/hidden-permissions.txt`, edited by hand: one word or phrase per line, `#` for comments. A permission is hidden when its name or its description contains a line as a whole word or phrase, ignoring case. For example, `VSA` hides "Manage VSA" but not a word that only contains those letters.
- The backend reads the file when it starts, and leaves hidden permissions out of what `GET /api/roles`, `GET /api/users` and `POST /api/users/read` send to the dashboard. It still sees them itself, so telling an API user by its `apiUser` permission is unchanged. A missing file hides nothing; a line that's blank or only a comment is ignored.
- To fill the file, `npm run connect -- permissions` prints every permission the organization's roles carry, name and description, one per line, read only (one `GET /v2/roles`). The administrator picks the lines to hide.
- The file starts with the administrator's examples: `DynamicMP`, `VSA`, `Manage Vendor Contact Requests`, `Manage rules in SourceClear workspace`.

Success criteria:

- [x] Backend test: with the file holding `VSA` and `Manage Vendor Contact Requests`, the roles and users sent leave out "Manage VSA" and "Manage Vendor Contact Requests", keep a permission whose name only contains the letters `vsa` inside a word, and still tell an API user by its `apiUser` permission.
- [x] Backend test: no file, an empty file and a file of comments hide nothing.
- [x] `npm run connect -- permissions`, with a stubbed `fetch`, prints each permission once, sorted, with no user data.
- [x] The administrator runs `npm run connect -- permissions` on the real organization (read only) and adds what else to hide. Done 2026-11-13: the starting four lines are enough for now.
- [x] A user's details show no hidden permission (Playwright against the local stand-in, whose Security Lead role carries "Manage VSA rules"). No dashboard test: the dashboard shows what the backend sends, and never sees a hidden permission.

## Phase 2: roles shown as the Platform shows them

- **Users table, Roles column:** the roles without the scan types and without "No Team Restriction API".
- **A user's details:** "Roles and their permissions" lists the roles the same way; under it, "Allowed scan types: All" or the selected types by name (for example "Static Scan, Container Scan"), or "None" for a user whose roles need none; for an API account, "Team memberships: No team restrictions" or "Restricted to selected teams". The organization's custom roles show as ordinary roles for now (see "Later" below).
- **Filters:** the Roles filter offers the same roles, plus a Scan types filter (All, or each type).
- A role counts as a scan type as it does now (`roleKind` in `backend/src/veracode/rules.ts`). "No Team Restriction API" is found by its role name, `noteamrestrictionapi`, confirmed on the real organization (entry 41). `npm run connect -- roles` lists each role with how the app groups it (API, scan type, all teams, team setting), read only (one `GET /v2/roles`), to check this against the real organization. The administrator ran it on 2026-11-13: the grouping is right.

Success criteria:

- [x] Dashboard tests: a user with Any Scan shows "Allowed scan types: All" and no "Any Scan" role, in the table and in the details; a user with Static and Container shows "Static Scan, Container Scan"; an API account with No Team Restriction API shows "No team restrictions" and not the role.
- [x] Dashboard test: filtering by a scan type, and by All, finds the right users. A scan type finds the users who may submit it: those given that type, and those given All.
- [x] Playwright against the local stand-in: the Users page and a user's details show scan types and team restrictions as above.
- [x] `npm run check` passes.

## Phase 3: compare with the Platform (administrator, read only)

Success criteria:

- [x] The Users page and a few users' details match the Platform, role for role, including scan types and team restrictions. Done 2026-11-13. This also ticks off `docs/PLAN_API.md` phase 5a's hand check.
- [x] No hidden permission shows; anything else that should be hidden is added to `config/hidden-permissions.txt`. Nothing more to hide (2026-11-13).
- [x] `docs/REALITY.md` entry 41 and `docs/STATUS.md` record what was seen.

## Later, after the CSV import: the organization's own roles

Out of scope for now (the administrator, 2026-11-13): custom roles are rarely used. Until then they show as ordinary roles. A later milestone may list them apart, under "Your organization's roles", with the roles each includes nested beneath it, as the Platform does. What's known: a custom role's name starts `custom-` (Veracode's roles carry no custom flag, spec 1.5), and its `child_roles` are the roles it includes (on the real organization, ELearning Admin, `custom-eLearningAdmin`, includes eLearning, `extelearn`).
