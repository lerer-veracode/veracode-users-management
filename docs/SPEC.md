# Veracode User Manager

From the Veracode platform administrator who looks after user accounts.

## How users are managed today

We add, change and remove users on our Veracode Platform account one at a time in the Administration screens. When a team joins or leaves, or roles change across many people, this is slow and error prone.

## The app

A local web app that manages the users of one Veracode organization at a time through the Veracode Identity API. It should:

- connect to an organization with OAuth client credentials, kept in an encrypted vault that the app password unlocks, and get access tokens on the fly
- open on a sign-in page like the Veracode Platform's, clearly marked "Un-official", that asks for an app username and password, and sign out on request or after 30 idle minutes
- remove every Veracode connection, with its tokens, 30 days after it is added, and remove app users who haven't signed in for 30 days
- list the organization's users, with search, filters and paging
- create a user, change a user's details and roles, and delete a user
- read a CSV file of users with their user name, email address and roles, show what would change, and apply it

## What the administrator needs to see

- The users of the connected organization in a table that looks and works like the Veracode Platform: user name, name, email, type, roles, last login and status. The status is Active, Login disabled (the account is active but its login is disabled), or Inactive; the Status filter offers the same three.
- A form to add or edit a user, with the roles to choose from, like the Veracode Platform's:
  - For a new user, the user name: the email address (the default) or a different one, which must not already be used in the organization. Several users may share an email address. An existing user's user name doesn't change.
  - Security Lead, Creator and Submitter need scan types: All scan types, or one or more specific types. A Creator or Submitter must also be in at least one team, unless they are also a Security Lead; Security Lead alone needs no team. This applies to new users and to changes, and the app refuses such a combination before sending it to Veracode, with "This combination of roles requires the user to be in at least one team".
  - Team Admin needs one or more teams to manage, chosen from the organization's teams; there is no "all teams".
  - The teams the user is a member of, chosen from a drop-down list of the organization's teams. Managing a team (Team Admin) is a separate choice from being a member.
  - Login enabled and Require MFA. A new user's login is enabled, and MFA is required unless it's turned off.
- Enable or disable a user's login straight from the row's Actions menu, after a confirmation. Edit and Delete are there too.
- A confirmation before a user is deleted.
- Roles for products the organization no longer has (Greenlight IDE User, listed in `config/hidden-roles.txt`) appear nowhere in the app, and can't be given; a user who has one keeps it.
- A CSV import page that shows each row, whether it is valid, and what it will do: create, create without the roles that need a team, or nothing (an error).
- The saved connections, with the organization, region and whether the token is valid, and a way to test each one. Connections are added and removed in the terminal with `npm run connect`, never in the browser.

## CSV format

A header row, then one user per row:

```csv
user_name,email_address,first_name,last_name,roles,scan_types
jdoe,jdoe@example.com,Jane,Doe,Security Lead,
,asmith@example.com,Alex,Smith,Reviewer,
mlopez,mlopez@example.com,Maria,Lopez,Security Lead;Creator,Static;Container
```

- `email_address` and `roles` are required. An empty `user_name` is the email address. `first_name` and `last_name` default to the part of the email before the `@`.
- `roles`: the roles as the Platform names them (Security Lead, Creator, Reviewer), separated by `;`; Veracode's role names (`extseclead`) work too, ignoring case. Scan types don't go here. The Import page lists the organization's roles and scan types.
- `scan_types`: empty for All, or the Platform's names separated by `;` (Container, Discovery, Dynamic Analysis, Infrastructure as Code, Static); role names work too. They apply to Security Lead, Creator and Submitter, and are dropped for other roles.
- The import creates users only. A row whose user name is already used in the organization is skipped, naming the user who has it. Several users may share an email address, so the email never matches a row to a user.
- Teams can't be set from a CSV yet. Roles that need a team (Team Admin, and Creator or Submitter without Security Lead) are left out of the user created, and the import names them, to be given by hand. A row with no other role is skipped.
- Details: `docs/PLAN_CSV.md`.

## Rules

- Nothing changes on the platform without a confirmation step that shows what will change, and in which organization. Deleting a user also needs the user name typed.
- The Administrator role is read only: the app never changes or deletes a user who has it, and never gives it to anyone. It doesn't give API roles either, and changes only UI users, not API or SAML accounts. The backend enforces this, whatever the dashboard sends.
- Client secrets are typed only into the terminal, stored only in the encrypted vault, and never reach the browser. Tokens live in memory only. Nothing secret goes anywhere except to the Veracode API.
- The vault is never committed to git.
- Any app user with a valid username and password can open the vault. The vault is not tied to a machine: it can be copied and opened anywhere by an app user.
- Each Veracode connection is removed 30 days after it is added: its tokens and its client are revoked on Veracode and its secret is deleted. This cannot be extended.
- App users are kept as long as they keep signing in: each sign-in extends them to 30 days from then. An app user who hasn't signed in for 30 days is removed.
- Every call the app makes to the Veracode Platform is logged: user changes, token requests and connection checks, and revoking tokens and clients when a connection is removed or expires. So are sign-ins and app users and connections being added, removed or expiring. The log records who, when, which organization, what and the result, never a secret, a token or a request body. Each call to Veracode also says why the app made it, in plain words (for example "Change a user: safety check, read the user"), how long Veracode took, and what came back as counts only (for example "23 users"), never the records themselves. A change to a user (create, update, delete) also records which user, and each field it changed, from and to: names, email, status, login, MFA, roles, scan types and teams. Administrators can read it on the Activity page.
- The app never presents itself as Veracode: the sign-in page and the top bar always show "Un-official", and the sign-in page says not to use a Veracode password.
- The app works with one organization at a time; switching connection switches organization. There can be several connections:
  - With one connection, its users load straight away.
  - With several, the administrator chooses one from a list before any users load.
  - Each app user's last-used connection is remembered and chosen again at their next sign-in. A connection that expires or is removed is forgotten.
  - Every list of users, and every user's details, says clearly which connection it came from.
- Regions: US (`api.veracode.com`), EU (`api.veracode.eu`) and US Federal (`api.veracode.us`).
- For now, the credentials belong to an administrator account: a user with the Admin API role (`adminapi`) or Administrator (`extadmin`), as the Identity API requires. A least-privilege role is a future upgrade; see below.

## Not for now

- The light theme. Only the dark theme is built at first; see `docs/BRAND.md`.
- Deleting users from a CSV file. Deletes are one user at a time in the table.
- Creating or changing teams. A user's team memberships, and which teams a Team Admin manages, are set on the user.
- SAML and API service accounts beyond showing their type.
- Sign-in to the app itself; it runs on the administrator's own machine.

## Future upgrades (optional)

### A least-privilege role for the app

Run the app on a dedicated API service account with a custom role that can manage users and nothing else, in place of an administrator account. Admin API covers the whole organization and more than users, and Veracode advises keeping it to dedicated automation accounts. Team Admin doesn't fit: it is for people in the web interface only, can't be given to an API account, and can't delete users.

A custom API role (`POST /v2/roles` with `is_api: true`) can carry the `ManageUser` permission:

- Whole organization: `retrieveOrg`, `create`, `updateOrg`, `delete`
- Own teams only: `retrieveTeamOnly`, `createTeamOnly`, `updateTeamOnly`, `deleteTeamOnly`

```json
{
  "role_name": "usermanager",
  "role_description": "User Manager API",
  "is_api": true,
  "permissions": [
    {
      "permission_name": "ManageUser",
      "permission_types": ["retrieveOrg", "create", "updateOrg", "delete"]
    }
  ]
}
```

Veracode adds `custom-` to the front of the name. Check the exact request format against `docs/identity-api-1.5.json` before using it.

Not yet confirmed: the Identity API docs still say its endpoints need Admin API or Administrator, and they don't say whether `ManageUser` alone opens `/v2/users` and `/v2/roles`. Before relying on it:

1. An administrator creates the custom role. Only administrators can create custom roles.
2. Create an API service account with only that role, and give it OAuth client credentials.
3. With those credentials, call `GET /v2/users` and `GET /v2/roles`, then create, update and delete a test user. A 403 means a permission is missing.

With this, the Connections page could also check what each connection is allowed to do (list, create, update, delete) and show it.

### Restrict sign-in by IP address

Veracode can limit a user's sign-in to a set of IP addresses (`ip_restricted` and `allowed_ip_addresses` in the Identity API). The edit form could offer it, with the addresses to allow, checked before saving.

### Browser sign-in (device code)

Veracode's OAuth metadata lists the device-code grant (`urn:ietf:params:oauth:grant-type:device_code`), which would let someone approve the app in their browser with no client secret at all. Veracode does not yet document a device-authorization endpoint or a client ID that other apps can use, so we can't build on it. Revisit if Veracode documents it.

### After the CSV import (agreed 2026-11-15)

In this order of need, none scheduled yet:

- **Teams in the CSV import.** Let a row give the teams a user is a member of, and the teams a Team Admin manages, so roles that need a team (Creator, Submitter, Team Admin) can be imported. Until then the import refuses them (`docs/PLAN_CSV.md`).
- **Update users from a CSV.** Let the import change existing users (matched by user name) as well as create new ones, with a preview of each change. Until then the import creates only.
- **Mass assignment.** Add or remove roles and teams for several chosen users at once, with one review of every change.
- **The organization's own roles.** List custom roles apart, under "Your organization's roles", with the roles each includes, as the Platform does (`docs/PLAN_ROLES.md`, "Later").
