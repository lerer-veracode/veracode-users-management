import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { VaultFile } from "./vault.js";
import { VaultError } from "./vault.js";

export const defaultVaultPath = (): string =>
  process.env.VAULT_PATH ?? resolve(import.meta.dirname, "../../../.local/vault.json");

const isVaultFile = (value: unknown): value is VaultFile =>
  typeof value === "object" &&
  value !== null &&
  "version" in value &&
  value.version === 1 &&
  "users" in value &&
  Array.isArray(value.users) &&
  "data" in value;

export const readVault = async (path: string): Promise<VaultFile | null> => {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (e) {
    if (e instanceof Error && "code" in e && e.code === "ENOENT") return null;
    throw e;
  }
  const parsed: unknown = JSON.parse(text);
  if (!isVaultFile(parsed)) throw new VaultError("The vault is damaged.");
  return parsed;
};

export const writeVault = async (path: string, file: VaultFile): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(file, null, 2), { mode: 0o600 });
  await rename(temp, path);
};
