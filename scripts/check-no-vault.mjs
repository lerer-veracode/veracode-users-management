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
// who installs this project behind the firewall.
const CREDENTIAL = /:\/\/[^/\s@]*:[^/\s@]+@|_auth|_authToken|_password/;
const FIREWALL_REGISTRY = /^registry=https:\/\/-:[^/\s@]+@npm\.firewall\.veracode\.com\/$/;
const carriesCredentials = (path) =>
  /(^|\/)\.npmrc$/.test(path) &&
  readFileSync(path, "utf8")
    .split(/\r?\n/)
    .some((line) => CREDENTIAL.test(line) && !FIREWALL_REGISTRY.test(line.trim()));

const vaults = staged.filter(looksLikeVault);
const secrets = staged.filter(carriesCredentials);
if (vaults.length > 0) console.error(`Refusing to commit vault files:\n  ${vaults.join("\n  ")}`);
if (secrets.length > 0) {
  console.error(
    `Refusing to commit npm credentials:\n  ${secrets.join("\n  ")}\nOnly the Veracode package firewall registry URL may carry a token.`,
  );
}
if (vaults.length > 0 || secrets.length > 0) process.exit(1);
