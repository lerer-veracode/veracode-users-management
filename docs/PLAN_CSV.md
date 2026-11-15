# Plan: CSV import and export

Replaces `docs/PLAN_API.md` phase 6. Agreed with the administrator on 2026-11-15:

- **Create only.** The import creates new users; it never changes an existing one. A row whose user name is already used in the organization fails, with who has it and why. Updating existing users from a CSV is a later enhancement (`docs/SPEC.md`, "Future upgrades").
- **User name** may be empty: then it's the email address, as in the add form. Several users may share an email address, so the email never matches a row to a user.
- **Scan types** get their own column, `scan_types`. Empty means All.
- **No teams** in the CSV for now; the organization's teams vary. A role that needs a team is left out, and the user is created with the rest of their roles. The report names the users and the roles left out, to be given by hand in the form. Assigning teams from the CSV is a later enhancement.
- **Export** saves the filtered users to a CSV in the same format, to keep a copy outside Veracode.

The phases below are the order of building, each on its own branch and pull request. For the administrator, an import is one flow: choose a file, review the preview, confirm, read the report.

## The CSV format

```csv
email_address,user_name,first_name,last_name,roles,scan_types
jdoe@example.com,jdoe,Jane,Doe,Security Lead,
asmith@example.com,,Alex,Smith,Reviewer,
mlopez@example.com,mlopez,Maria,Lopez,Security Lead;Creator,Static;Container
```

- `email_address` and `roles` are required. `user_name` defaults to the email address. `first_name` and `last_name` default to the part of the email before the `@`. `scan_types` defaults to All.
- `roles`: the roles as the Platform names them (Security Lead, Creator, Reviewer), separated by `;`. Veracode's role names (`extseclead`) work too, ignoring case (the administrator, 2026-11-15).
- `scan_types`: `All`, or one or more of the Platform's names, separated by `;`: Container, Discovery, Dynamic Analysis, Infrastructure as Code, Static. The role names (`extsubmitstaticscan` and so on) are accepted too, ignoring case. They apply only to Security Lead, Creator and Submitter, and are dropped when the user has none of them.

**Roles that need a team** are left out of the user created: Team Admin always, and Creator or Submitter when the row has no Security Lead (`docs/SPEC.md`, the form's rules). The row is still created, marked "Created without some roles", with the roles left out. If no role is left, the row is an error.

A row is an error, and nothing is sent for it, when:

- its user name is already used in the organization ("jdoe is already the user name of Jane Doe, jdoe@example.com"), or by an earlier row in the file;
- the email, a name, a role or a scan type isn't valid, or a role isn't in the organization;
- it gives a role the app never gives: Administrator, or an API role;
- it has no role left once the roles that need a team are left out.

## Phase 1: the format and the preview

- `dashboard/src/lib/csv.ts` reads the new columns. `dashboard/src/lib/importPlan.ts` checks each row against the organization's users and roles as above: Create, Create without some roles (naming them), or Error.
- The Import page explains the format as a list of points, lists the organization's roles (marking those left out for needing a team) and scan types a CSV can use, and says that roles needing a team (Team Admin, and Creator or Submitter without Security Lead) are left out, to be given by hand in the form. Its preview shows the user name, email, name, roles, scan types, action and problems, and above the table, the users who'll miss roles and which.
- **The sample CSV:** the instructions link to a template, `users-import-sample.csv`: three valid rows, one for each way of writing a user (no user name and All scan types; a user name and a role with no scan types; two roles and specific scan types). The administrator asked for it on 2026-11-15, as a link in the text.
- **Email first:** the columns are `email_address, user_name, first_name, last_name, roles, scan_types`, and the preview shows the email first too.
- **Focus on the users:** once a file is read, the instructions fold away to a bar with the file's name and row count, Choose Another File, and Show instructions.
- `data/sample_users.csv` (for tests) follows the new format: three good rows, one created without a team-bound role, and three bad ones (a user name already used, only a team-bound role, a missing email).
- `docs/SPEC.md` "CSV format" matches this plan.

Success criteria:

- [x] Dashboard tests: an empty user name becomes the email; empty scan types become All; `Static;Container` and the role names give the same roles; scan types are dropped when no role needs them.
- [x] Dashboard tests: Team Admin, and Creator without Security Lead, are left out and named; Creator with Security Lead is kept; a row with only Team Admin is an error.
- [x] Dashboard tests: each error case above, with its message; a user name already used names the user who has it.
- [x] Dashboard tests: roles by Platform name or role name, ignoring case; the lists of roles and scan types leave out Administrator, API roles, scan types and the team setting, and mark the team-bound roles.
- [x] The sample CSV link saves the template, email first, and every row of it previews as Create (dashboard tests).
- [x] After a file is read, the instructions fold away to the file bar, and open again with Show instructions (dashboard test and Playwright).
- [x] The sample file previews as 4 to create (1 without some roles) and 3 with errors against the local stand-in (Playwright); a dashboard test previews a smaller file against the mock data.

## Phase 2: apply the import

- **Apply N users:** opens a confirmation that lists the users to create, the roles left out, and the organization (connection, region). Rows with errors are left out and listed as skipped.
- Each user is created with login enabled and MFA required, as the add form does by default; the CSV has no column for them.
- **`POST /api/import`** takes the rows. For each, it checks with the same rules as `POST /api/users` (`checkNewUser`), leaves out the roles that need a team, and refuses a user name already taken. It reads the user names fresh from Veracode first, and creates the users one by one. A refusal by Veracode on one row doesn't stop the others. Each create is in the Activity log as with the form, with "Import from CSV" as its reason.
- The page then reports each row: Created, Created without some roles (which), or Failed with Veracode's message or the rule it broke. Above it: "Users X, Y were created without roles that need a team (…): give them by hand in the form." The users list reloads.
- At most 200 rows per file, so one import can't run for too long.

Success criteria:

- [ ] Backend tests (stubbed `fetch`): good rows are created in order; team-bound roles are left out of what's sent and reported; a row Veracode refuses is reported with its message and the next row still goes; an Administrator or API role, or a user name taken since the preview, is refused before sending; over 200 rows is refused.
- [ ] Dashboard test: the confirmation names the organization, the users and the roles left out; the report shows Created, Created without some roles, and Failed rows.
- [ ] Playwright against the local stand-in: importing the sample creates four users, which then show on the Users page, one without its team-bound role, and reports the three bad rows; the Activity page shows the four creates.

## Phase 3: export

- **Export CSV** on the Users page downloads the users shown by the current filters, all pages, in the import format: user name, email, names, roles (without scan types or the team setting), and scan types (`All` or the types by name, empty for a user who needs none).
- The file name says the connection and the date, for example `users-acme-2026-11-15.csv`.

Success criteria:

- [ ] Dashboard test: the export of a filtered list has a header and one row per user shown, with roles and scan types as above; names with commas or quotes are escaped.
- [ ] The exported file, read back by the import's parser, gives the same users and roles (every row then fails as "already used", since the import creates only).
- [ ] Playwright against the local stand-in: Export CSV downloads a file with the users shown.
- [ ] `npm run check` passes.

## Phase 4: check on the real organization (administrator, only when asked)

The rule of at most one test user still holds (`AGENTS.md`). If the administrator asks: import a file with one good row and a few bad ones, check the report, the Activity log and the Platform, then delete that user in the table. Export needs no test user: it only reads.

Success criteria:

- [ ] One user was created from a CSV, matches the Platform, and was deleted; the bad rows created nothing.
- [ ] An export of the real users opens in a spreadsheet and matches the Users page.
- [ ] `docs/REALITY.md` and `docs/STATUS.md` record what was seen.
