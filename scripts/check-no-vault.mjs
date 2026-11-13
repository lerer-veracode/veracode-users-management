// Pre-commit guard: refuses vault files and npm config files that carry credentials.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const staged = execFileSync("git", ["diff", "--cached", "--name-only", "--diff-filter=ACMR"], {
  encoding: "utf8",
})
  .split("\n")
  .filter(Boolean);

const looksLikeVault = (path) => {
  if (/(^|\/)\.local\//.test(path) || /vault[^/]*\.json$/i.test(path)) return true;
  if (!path.endsWith(".json")) return false;
  const text = readFileSync(path, "utf8");
  return text.includes('"ciphertext"') && text.includes('"kdf"');
};

// A token in a registry URL (https://user:token@host) or an auth setting. The Veracode package
// firewall's access key is the one exception: it isn't a secret, and committing it puts everyone
// who installs this project behind the firewall. It is allowed as the firewall's `_auth` (base64 of
// "-:KEY") or in the firewall registry URL. Empty credential keys for the firewall host are allowed
// too: they carry nothing, and they stop a user's own npmrc from overriding the key.
const CREDENTIAL = /:\/\/[^/\s@]*:[^/\s@]+@|_auth|_authToken|_password|:username=/;
const FIREWALL_REGISTRY = /^registry=https:\/\/-:[^/\s@]+@npm\.firewall\.veracode\.com\/$/;
const FIREWALL_AUTH = /^\/\/npm\.firewall\.veracode\.com\/:_auth=([A-Za-z0-9+/]+={0,2})$/;
const EMPTY_FIREWALL_KEY =
  /^\/\/npm\.firewall\.veracode\.com\/:(_auth|_authToken|username|_password)=\s*$/;
const isFirewallKey = (line) => {
  const match = FIREWALL_AUTH.exec(line);
  return match !== null && /^-:[A-Za-z0-9_]+$/.test(Buffer.from(match[1], "base64").toString());
};
const allowed = (line) =>
  FIREWALL_REGISTRY.test(line) || isFirewallKey(line) || EMPTY_FIREWALL_KEY.test(line);
const carriesCredentials = (path) =>
  /(^|\/)\.npmrc$/.test(path) &&
  readFileSync(path, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .some((line) => CREDENTIAL.test(line) && !allowed(line));

const vaults = staged.filter(looksLikeVault);
const secrets = staged.filter(carriesCredentials);
if (vaults.length > 0) console.error(`Refusing to commit vault files:\n  ${vaults.join("\n  ")}`);
if (secrets.length > 0) {
  console.error(
    `Refusing to commit npm credentials:\n  ${secrets.join("\n  ")}\nOnly the Veracode package firewall registry URL may carry a token; its other credential keys must be empty.`,
  );
}
if (vaults.length > 0 || secrets.length > 0) process.exit(1);
