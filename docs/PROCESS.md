# Process

`npm install` at the repo root installs everything. `npm run dev` starts the backend on port 8787 and the dashboard on http://localhost:5173.

`npm run check` runs every check:

- Prettier (format) and ESLint
- `tsc` for every workspace
- vitest for the backend and the dashboard, with 80% coverage
- Playwright end-to-end tests

A pre-commit hook (simple-git-hooks, installed by `npm install`) runs, in order: the vault guard (`scripts/check-no-vault.mjs`), format, lint, type and unit test checks, the Playwright end-to-end tests, then a Veracode static scan (`npm run scan`, `scripts/veracode-scan.mjs`).

The scan packages only the files git tracks (never the vault, `.env`, `node_modules` or coverage reports) with `veracode package`, then runs `veracode static scan` (Pipeline Scan) on the project artifact. It takes about a minute and a half. It blocks the commit on Very High or High findings and lists them; the full results are in `.veracode/results.json`. It skips, without blocking, when the Veracode CLI isn't installed, when the scan can't run (no credentials, no network), or when `SKIP_VERACODE_SCAN=1` is set. It uses HMAC API credentials from `VERACODE_API_KEY_ID` and `VERACODE_API_KEY_SECRET`, or from `~/.veracode/credentials`; the account needs a Static Analysis licence and a role that can scan (for example Upload and Scan API, or Submitter).

## What happens when you commit

You don't start the checks yourself: `git commit` sets off a chain of four links, each pointing to the next. Here is the chain, so you can find where each step is defined.

1. **Installing the project puts a hook into git.** `npm install` runs the `prepare` script in the root `package.json` (`"prepare": "node scripts/install-hooks.mjs"`), which runs simple-git-hooks. In an install without dev dependencies (the SRCCLR agent's `npm install --only production`, or a CI job) or in a copy without `.git`, it skips this and says why, rather than failing the install. simple-git-hooks reads the `"simple-git-hooks"` block in the same file and writes it into `.git/hooks/pre-commit`. Git runs that file before every commit.
2. **The hook runs one command.** The block says `"pre-commit": "npm run precommit"`, so every `git commit` runs the `precommit` script first.
3. **That script runs the checks in order.** `precommit` in the root `package.json` runs each step only if the one before it passed:

   | Step | Command                           | What it checks                                                 |
   | ---- | --------------------------------- | -------------------------------------------------------------- |
   | 1    | `node scripts/check-no-vault.mjs` | No vault, connection file or npm credential is being committed |
   | 2    | `npm run format`                  | The code is laid out the standard way (Prettier)               |
   | 3    | `npm run lint`                    | The code follows the rules (ESLint)                            |
   | 4    | `npm run typecheck`               | The types are right (TypeScript)                               |
   | 5    | `npm run test`                    | The unit tests pass, with 80% coverage                         |
   | 6    | `npm run e2e`                     | The app works end to end in a browser (Playwright)             |
   | 7    | `npm run scan`                    | The Veracode static scan finds nothing Very High or High       |

4. **The scan step runs a script.** `scan` in the root `package.json` is `node scripts/veracode-scan.mjs`. That script:
   - copies the files git tracks into `.veracode/src`;
   - packages them with `veracode package`;
   - scans the package with `veracode static scan` and saves the results in `.veracode/results.json`.

If any step fails, git doesn't make the commit. Fix the problem and commit again.

The scan is the only step that can be skipped, and it skips itself without blocking the commit:

- when the Veracode CLI isn't installed;
- when it can't run (no credentials, no network);
- when `SKIP_VERACODE_SCAN=1` is set for that commit:
  - in PowerShell: `$env:SKIP_VERACODE_SCAN = "1"; git commit -m "..."; Remove-Item Env:SKIP_VERACODE_SCAN`
  - on a Mac: `SKIP_VERACODE_SCAN=1 git commit -m "..."`

If you change the `"simple-git-hooks"` block, run `npx simple-git-hooks` to write the new hook into git. A change to the `precommit` or `scan` scripts, or to `scripts/veracode-scan.mjs`, applies at the next commit without that.

## Packages

Packages come through the Veracode package firewall. The project's `.npmrc` sets the firewall registry, with its access key in the URL, and `replace-registry-host=never`, and every `resolved` URL in `package-lock.json` points at the firewall. The access key is committed on purpose: it isn't a secret, and it sends everyone who installs the project to the firewall. The firewall also needs an `_auth` credential for `npm.firewall.veracode.com` in each user's own `~/.npmrc` (or, in CI, from a secret); that is never committed (`docs/REALITY.md`, entry 19). The pre-commit guard allows that one line and still refuses any other npm credential. The firewall is set to warn, not block, for now. A package the firewall blocks fails the install with "Blocked by package firewall"; packages it hasn't checked yet can be blocked at first and allowed minutes later.

## Planning

When asked to plan, as in "Please plan the API connection", write the plan to `docs/PLAN_<NAME>.md` and write no code.

- Split the work into phases, usually 3 to 6, each building on the last.
- Give each phase detailed success criteria that you can verify yourself: tests that pass, commands and their output, API calls and their responses, and pages you check in the browser. Write each one as a checkbox.
- Then stop and wait until you are asked to implement the plan.

## Implementing

When asked to implement a plan, build every phase in order without stopping. For each phase:

1. Start its branch and pull request (see "Branches and pull requests").
2. Build it, with tests.
3. Check every success criterion and fix whatever fails.
4. Tick off its criteria in the plan and update `docs/STATUS.md`.
5. Commit and push to the phase's branch. The pre-commit hook runs the checks; if it fails, fix the problem and commit again.

When the last phase is done, run `npm run check` and report the results.

## Branches and pull requests

From 2026-11-10, each new phase is built on its own branch and reaches `main` through one pull request.

1. **One branch per phase.** Start each new phase from an up-to-date `main`, on a branch named `phase/<plan>-<phase>-<short-name>`, for example `phase/api-6-csv-import`. A sub-phase gets its own branch and pull request only when the administrator agrees to that in advance. Never build a phase on `main`.
2. **Open the pull request early.** Open it as a draft as soon as the phase's first commit is pushed. Its title names the phase, and its description links the plan and copies the phase's success criteria as checkboxes. From then on, every commit pushed to the branch adds to that pull request; tick the criteria in it as they're met.
3. **Commit only real changes.** Commit when there is substance: a checked change to code, tests or docs that moves the phase forward. No empty commits, no "work in progress" or "try again" commits, and no commit for formatting alone; fold small fixes into the next real commit. Push each commit to the phase's branch only.
4. **Finish a phase.** When the administrator confirms the phase (or an agreed sub-phase) is complete, mark the pull request ready for review. It must pass every check in the CI/CD pipeline, if the repository has one, as well as `npm run check`. Fix any failure on the branch and push again.
5. **Squash on merge.** Merge only after the administrator's go-ahead, and only by squash, so the phase lands on `main` as one commit. The squash message names the phase and sums up what it built. Then delete the branch, and update the local `main`.

**Status on 2026-11-12:** the repository is on GitHub, https://github.com/lerer-veracode/veracode-users-management (private), with no CI/CD pipeline yet, so `npm run check` stands in for the CI checks. The local branches `history/*` hold the history from before 2026-11-12 and are never pushed. Without the GitHub CLI, pull requests are opened and merged on github.com, and a merge still needs the administrator's explicit instruction.

## Rules

- Add tests with each change. Tests never call the real Veracode API; use a stub of `fetch`.
- There is no Veracode test server or test organization: every connection is a real, live organization. Never create, change or delete a user there unless the administrator asks you to, for that run.
- The Administrator role (`extadmin`) is read only for you. Never create, change or delete a user who has it, and never give it to a new or existing user, by any route: the app, a script, `curl`, or the Veracode Platform.
- In any testing on a real organization, create at most one user in total, and change or delete only that user. Never touch any other user.
- Never print, log or commit a client secret or token.
- Outside a plan, commit each change once you have checked it, if it has substance (see "Branches and pull requests"). Work on a new phase never goes straight to `main`.
- Run `npm run check` before you hand work over.
- Never use `git commit --no-verify`. To skip only the Veracode scan for one commit, set `SKIP_VERACODE_SCAN=1`, and say so.
- Never add a package from outside the firewall, and never commit any npm credential other than the firewall's access key in `.npmrc`.
- Never lower a threshold, turn off a rule or exclude a file to get a green run. If a rule looks wrong, stop and ask.
- Keep `docs/STATUS.md` up to date.
- Whenever a real system behaves differently from its documentation, spec, settings or our instructions, add an entry to `docs/REALITY.md`: what we expected and where from, what happens, how we handle it, and whether it's confirmed. Update the entry when you learn more.
- Push only a phase's own branch, to update its pull request. Never push to `main`, never force-push, and never merge a pull request without the administrator's go-ahead.
- Everything must work on Windows: write `package.json` scripts as plain `node`, `npm` or `.mjs` commands.
