// npm runs this on every install ("prepare"). It sets up the git pre-commit hook with
// simple-git-hooks, a dev dependency. A production-only install (the SRCCLR agent's
// `npm install --only production`, or a CI job) doesn't have it, and a copy without .git has no
// hooks to set, so then it says so and skips, rather than failing the install.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";

const skip = (why) => {
  console.log(`[install-hooks] Skipped the git hook: ${why}.`);
  process.exit(0);
};

if (!existsSync(".git")) skip("not a git checkout");

let cli;
try {
  cli = createRequire(import.meta.url).resolve("simple-git-hooks/cli.js");
} catch {
  skip("simple-git-hooks isn't installed (a production-only install)");
}

const { status } = spawnSync(process.execPath, [cli], { stdio: "inherit" });
process.exit(status ?? 1);
