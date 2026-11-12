# Veracode User Manager

A local TypeScript web app that manages the users of a Veracode Platform organization through the Veracode Identity API: list, create, change and delete users, and import them from a CSV file.

The administrator may be on Windows, where the terminal in VS Code is PowerShell, or on a Mac. Give commands that work on their system.

## Start here

IMPORTANT: before you plan, build or change anything, or answer questions about the app, read each of these files in full:

1. `docs/SPEC.md`: what the app must do
2. `docs/TECH_STACK.md`: the tech choices and the Veracode API
3. `docs/CODE_STANDARDS.md`: how to write the code
4. `docs/PROCESS.md`: how to plan, build and check the work
5. `docs/BRAND.md`: the look, matching the Veracode Platform
6. `docs/STATUS.md`: what's built so far and how to run it
7. `docs/REALITY.md`: where the real systems differ from their documentation, specs or settings
8. Any `docs/PLAN_<NAME>.md` for the work in progress

## The real Veracode organization: hard rules

IMPORTANT: there is no Veracode test server or test organization. Every connection in the vault is a real, live organization. Treat it as production.

1. The **Administrator** role (`extadmin`) is read only for you. Never create, change or delete a user who has it, and never give it to a new or existing user, by any route: the app, a script, `curl`, or the Veracode Platform.
2. In any testing on a real organization, create **at most one** user in total. Change or delete **only that user**. Never change or delete any other user.
3. Do even that only when the administrator asks you to, for that run.

Automated tests never reach Veracode: they use a stub of `fetch`, or `e2e/fake-veracode.ts`, a small program on this machine that imitates the Identity API.

## Your role

The administrator directs the work and reviews your plans and builds. You plan, build and check the work as `docs/PROCESS.md` describes. Build only what the documents in `docs/` ask for.

## Folders

- `docs/`: the documentation, including the Identity API spec `docs/identity-api-1.5.json`
- `backend/`, `dashboard/` and `e2e/`: the app
- `data/`: sample CSV files
- `images/`: reference screenshots of the Veracode Platform
- `.local/`: connections and tokens, never committed
