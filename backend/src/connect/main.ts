import { AuditLog, defaultAuditPath } from "../audit/audit.js";
import { defaultVaultPath } from "../vault/file.js";
import { runConnect } from "./commands.js";
import { terminalPrompter } from "./prompt.js";

process.exitCode = await runConnect(process.argv.slice(2), {
  prompt: terminalPrompter,
  out: (line) => {
    const sanitized =
      typeof line === "string" ? line.replace(/password[=:\s]+[^\s&]+/gi, "password=***") : line;
    if (process.env.NODE_ENV !== "test") {
      console.log(sanitized);
    }
  },
  fetch,
  now: () => new Date(),
  vaultPath: defaultVaultPath(),
  audit: new AuditLog(defaultAuditPath()),
});
