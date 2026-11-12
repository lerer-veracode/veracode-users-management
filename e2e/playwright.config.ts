import { defineConfig } from "@playwright/test";
import {
  BACKEND_PORT,
  DASHBOARD_PORT,
  E2E_AUDIT,
  E2E_VAULT,
  FAKE_VERACODE_PORT,
} from "./settings.js";

// Its own ports and a throwaway vault, so the tests never touch your real vault or dev servers.
export default defineConfig({
  testDir: "tests",
  globalSetup: "./global-setup.ts",
  use: { baseURL: `http://localhost:${DASHBOARD_PORT}` },
  webServer: [
    {
      command: "npm run start -w backend",
      cwd: "..",
      url: `http://localhost:${BACKEND_PORT}/api/health`,
      env: {
        PORT: String(BACKEND_PORT),
        VAULT_PATH: E2E_VAULT,
        AUDIT_LOG_PATH: E2E_AUDIT,
        VERACODE_API_BASE: `http://localhost:${FAKE_VERACODE_PORT}/api/authn`,
      },
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: `npm run dev -w dashboard -- --port ${DASHBOARD_PORT} --strictPort`,
      cwd: "..",
      url: `http://localhost:${DASHBOARD_PORT}`,
      env: { BACKEND_URL: `http://localhost:${BACKEND_PORT}` },
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
