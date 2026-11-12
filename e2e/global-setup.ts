import { rm } from "node:fs/promises";
import { writeVault } from "../backend/src/vault/file.js";
import { createVault, newConnection, saveData } from "../backend/src/vault/vault.js";
import { startFakeVeracode } from "./fake-veracode.js";
import { E2E_AUDIT, E2E_PASSWORD, E2E_USER, E2E_VAULT, FAKE_VERACODE_PORT } from "./settings.js";

export default async function globalSetup() {
  await rm(E2E_VAULT, { force: true });
  await rm(E2E_AUDIT, { force: true });
  const now = new Date();
  const session = await createVault(E2E_USER, E2E_PASSWORD, now, { N: 2 ** 10, r: 8, p: 1 });
  const conn = newConnection(
    { name: "e2e-org", region: "us", client_id: "vrc_e2e", client_secret: "not-a-real-secret" },
    now,
  );
  await writeVault(E2E_VAULT, saveData(session, { connections: [conn] }).file);
  const fake = await startFakeVeracode(FAKE_VERACODE_PORT);
  return () => new Promise<void>((done) => fake.close(() => done()));
}
