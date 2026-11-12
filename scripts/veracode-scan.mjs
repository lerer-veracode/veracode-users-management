// Veracode static scan (Pipeline Scan) of the files tracked by git, run by the pre-commit hook.
// Skips, without blocking the commit, when the Veracode CLI isn't installed, when
// SKIP_VERACODE_SCAN=1, or when the scan can't run (no credentials, no network).
// Blocks the commit when it finds Very High or High flaws.
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const WORK = ".veracode";
const SOURCE = join(WORK, "src");
const PACKAGE = join(WORK, "package");
const RESULTS = join(WORK, "results.json");
const FAIL_ON = "Very High, High";

const say = (line) => console.log(`[veracode] ${line}`);

if (process.env.SKIP_VERACODE_SCAN === "1") {
  say("Skipped: SKIP_VERACODE_SCAN=1.");
  process.exit(0);
}

const cli = spawnSync("veracode", ["version"], { encoding: "utf8" });
if (cli.error) {
  say("Skipped: the Veracode CLI is not installed.");
  process.exit(0);
}

// The CLI reads HMAC credentials from these variables; fall back to the API credentials file.
const credentialsEnv = () => {
  if (process.env.VERACODE_API_KEY_ID && process.env.VERACODE_API_KEY_SECRET) return {};
  const file = join(homedir(), ".veracode", "credentials");
  if (!existsSync(file)) return {};
  const profile = process.env.VERACODE_API_PROFILE ?? "default";
  let section = "";
  const values = {};
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    const header = /^\[(.+)\]$/.exec(line);
    if (header) section = header[1];
    else if (section === profile && line.includes("=")) {
      const [key, ...rest] = line.split("=");
      values[key.trim()] = rest.join("=").trim();
    }
  }
  return values.veracode_api_key_id && values.veracode_api_key_secret
    ? {
        VERACODE_API_KEY_ID: values.veracode_api_key_id,
        VERACODE_API_KEY_SECRET: values.veracode_api_key_secret,
      }
    : {};
};

const run = (args) =>
  spawnSync("veracode", args, {
    encoding: "utf8",
    env: { ...process.env, ...credentialsEnv() },
    maxBuffer: 64 * 1024 * 1024,
  });

// Package only what git tracks: never the vault, .env, node_modules or coverage reports.
// OneDrive or antivirus can hold a file here for a moment (EPERM, EBUSY): retry before failing.
rmSync(WORK, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
const tracked = spawnSync("git", ["ls-files", "-z", "--cached"], { encoding: "utf8" })
  .stdout.split("\0")
  .filter(Boolean);
for (const file of tracked) {
  if (!existsSync(file)) continue;
  mkdirSync(join(SOURCE, dirname(file)), { recursive: true });
  copyFileSync(file, join(SOURCE, file));
}

say("Packaging...");
const pack = run(["package", "--source", SOURCE, "--output", PACKAGE, "--trust"]);
const zips = existsSync(PACKAGE)
  ? readdirSync(PACKAGE)
      .filter((f) => f.endsWith(".zip"))
      .map((f) => join(PACKAGE, f))
      .sort((a, b) => statSync(b).size - statSync(a).size)
  : [];
if (pack.status !== 0 || zips.length === 0) {
  say(`Skipped: packaging failed (exit ${pack.status}). Commit not blocked.`);
  console.log(pack.stdout.split("\n").slice(-5).join("\n"));
  process.exit(0);
}

// The largest artifact is the project root, which holds the backend and the dashboard.
say(`Scanning ${zips[0]} (this can take a few minutes; SKIP_VERACODE_SCAN=1 skips it)...`);
const scan = run([
  "static",
  "scan",
  zips[0],
  "--results-file",
  RESULTS,
  "--fail-on-severity",
  FAIL_ON,
]);

const SEVERITY = ["Informational", "Very Low", "Low", "Medium", "High", "Very High"];
const findings = existsSync(RESULTS)
  ? (JSON.parse(readFileSync(RESULTS, "utf8")).findings ?? [])
  : [];
const describe = (f) =>
  `  ${SEVERITY[f.severity] ?? f.severity}  CWE-${f.cwe_id}  ${f.issue_type}  ${f.files?.source_file?.file}:${f.files?.source_file?.line}`;

if (scan.status === 0) {
  say(`Passed: ${findings.length} findings, none ${FAIL_ON}. Details: ${RESULTS}`);
  process.exit(0);
}
if (scan.status === 3) {
  say(`Failed: findings at ${FAIL_ON}. The commit is blocked. Details: ${RESULTS}`);
  for (const f of findings.filter((x) => x.severity >= 4)) console.log(describe(f));
  process.exit(1);
}
say(`Skipped: the scan could not run (exit ${scan.status}). Commit not blocked.`);
console.log(`${scan.stdout}\n${scan.stderr}`.trim().split("\n").slice(-4).join("\n"));
process.exit(0);
