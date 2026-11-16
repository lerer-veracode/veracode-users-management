import { defineConfig } from "@playwright/test";
import base from "./playwright.config.js";

// The README's screenshots, taken against the fake Veracode with made-up users, never a real
// organization. Not part of the checks: run `npm run screenshots` to refresh docs/screenshots.
export default defineConfig({
  ...base,
  testDir: "screenshots",
  use: { ...base.use, viewport: { width: 1440, height: 860 }, colorScheme: "dark" },
});
