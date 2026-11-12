import { resolve } from "node:path";

export const E2E_USER = "e2e";
export const E2E_PASSWORD = "e2e test password";
export const E2E_VAULT = resolve(import.meta.dirname, ".tmp", "vault.json");
export const E2E_AUDIT = resolve(import.meta.dirname, ".tmp", "audit.log");
export const BACKEND_PORT = 8788;
export const DASHBOARD_PORT = 5174;
export const FAKE_VERACODE_PORT = 8789;
