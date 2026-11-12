import { serve } from "@hono/node-server";
import { setTimeout as sleep } from "node:timers/promises";
import { createApp } from "./app.js";
import { AuditLog, defaultAuditPath } from "./audit/audit.js";
import { defaultVaultPath } from "./vault/file.js";

const port = Number(process.env.PORT ?? 8787);
const vaultPath = defaultVaultPath();

const { app, sweep } = createApp({
  vaultPath,
  fetch,
  now: () => new Date(),
  sleep: (ms) => sleep(ms),
  audit: new AuditLog(defaultAuditPath()),
});

setInterval(() => void sweep(), 60 * 60 * 1000).unref();

serve({ fetch: app.fetch, port }, () => {
  console.log(`Backend on http://localhost:${port}, vault at ${vaultPath}`);
});
