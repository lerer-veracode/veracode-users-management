import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readVault, writeVault } from "./file.js";
import { daysLeft } from "./retention.js";
import {
  addUser,
  createVault,
  expiredConnections,
  newConnection,
  recordSignIn,
  removeExpiredUsers,
  removeUser,
  saveData,
  setLastUsed,
  unlock,
  VaultError,
} from "./vault.js";

const CHEAP = { N: 2 ** 10, r: 8, p: 1 };
const NOW = new Date("2026-11-09T12:00:00Z");
const PASSWORD = "correct horse battery";
const SECRET = "s3cr3t-client-value";
const later = (days: number) => new Date(NOW.getTime() + days * 86_400_000);

const withConnection = async () => {
  const session = await createVault("Yaakov", PASSWORD, NOW, CHEAP);
  const conn = newConnection(
    { name: "acme", region: "us", client_id: "vrc_1", client_secret: SECRET },
    NOW,
  );
  return saveData(session, { connections: [conn] });
};

describe("vault", () => {
  it("unlocks with the right username and password", async () => {
    const { file } = await withConnection();
    const session = await unlock(file, " yaakov ", PASSWORD, NOW);
    expect(session.username).toBe("yaakov");
    expect(session.data.connections[0]?.client_secret).toBe(SECRET);
  });

  it("refuses a wrong password or unknown user", async () => {
    const { file } = await withConnection();
    await expect(unlock(file, "yaakov", "wrong password!!", NOW)).rejects.toThrow(
      "Wrong username or password.",
    );
    await expect(unlock(file, "nobody", PASSWORD, NOW)).rejects.toThrow(
      "Wrong username or password.",
    );
  });

  it("detects a changed file", async () => {
    const { file } = await withConnection();
    const ct = Buffer.from(file.data.ciphertext, "base64");
    ct[0] = (ct[0] ?? 0) ^ 1;
    const tampered = { ...file, data: { ...file.data, ciphertext: ct.toString("base64") } };
    await expect(unlock(tampered, "yaakov", PASSWORD, NOW)).rejects.toThrow(
      "The vault is damaged.",
    );
  });

  it("never stores the secret in plain text and uses a new iv on each save", async () => {
    const session = await withConnection();
    const again = saveData(session, session.data);
    expect(JSON.stringify(session.file)).not.toContain(SECRET);
    expect(again.file.data.iv).not.toBe(session.file.data.iv);
  });

  it("checks new usernames and passwords", async () => {
    await expect(createVault("yaakov", "short", NOW, CHEAP)).rejects.toThrow("at least 12");
    await expect(createVault("a b", PASSWORD, NOW, CHEAP)).rejects.toThrow("Usernames");
  });

  it("lets any app user open it, and removes users", async () => {
    let session = await withConnection();
    session = await addUser(session, "Dana", "another long password", NOW, CHEAP);
    await expect(addUser(session, "dana", PASSWORD, NOW, CHEAP)).rejects.toThrow("already exists");
    const dana = await unlock(session.file, "dana", "another long password", NOW);
    expect(dana.data.connections).toHaveLength(1);

    session = removeUser(session, "dana");
    await expect(unlock(session.file, "dana", "another long password", NOW)).rejects.toThrow(
      VaultError,
    );
    expect(() => removeUser(session, "dana")).toThrow("No app user named dana.");
    expect(() => removeUser(session, "yaakov")).toThrow("last app user");
  });

  it("removes app users 30 days after their last sign-in, extended by each sign-in", async () => {
    let session = await createVault("yaakov", PASSWORD, NOW, CHEAP);
    session = await addUser(session, "dana", "another long password", NOW, CHEAP);
    const user = (s: typeof session, name: string) => s.file.users.find((u) => u.username === name);
    expect(daysLeft(user(session, "dana")?.removes_at ?? "", NOW)).toBe(30);

    session = recordSignIn(session, later(20));
    expect(user(session, "yaakov")?.last_sign_in).toBe(later(20).toISOString());
    expect(daysLeft(user(session, "yaakov")?.removes_at ?? "", later(20))).toBe(30);

    await expect(unlock(session.file, "dana", "another long password", later(31))).rejects.toThrow(
      "Wrong username or password.",
    );
    const { session: cleaned, removed } = removeExpiredUsers(session, later(31));
    expect(removed).toEqual(["dana"]);
    expect(cleaned.file.users.map((u) => u.username)).toEqual(["yaakov"]);
  });

  it("finds connections 30 days after they were added", async () => {
    const { data } = await withConnection();
    expect(expiredConnections(data, later(29))).toHaveLength(0);
    expect(expiredConnections(data, later(30)).map((c) => c.name)).toEqual(["acme"]);
  });
});

describe("vault file", () => {
  let dir = "";
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("writes, reads back and reports a missing or damaged file", async () => {
    dir = await mkdtemp(join(tmpdir(), "vault-"));
    const path = join(dir, "nested", "vault.json");
    expect(await readVault(path)).toBeNull();
    const { file } = await withConnection();
    await writeVault(path, file);
    expect(await readVault(path)).toEqual(file);
    expect(await readFile(path, "utf8")).not.toContain(SECRET);
    await writeFile(path, "{}");
    await expect(readVault(path)).rejects.toThrow("The vault is damaged.");
  });
});

describe("last-used connection", () => {
  it("is kept per app user and dropped when its connection or app user goes", async () => {
    let session = await withConnection();
    session = await addUser(session, "dana", "another long password", NOW, CHEAP);
    const acme = session.data.connections[0]?.id ?? "";
    session = setLastUsed(session, acme);
    const dana = setLastUsed(
      await unlock(session.file, "dana", "another long password", NOW),
      acme,
    );
    expect(dana.data.last_used).toEqual({ yaakov: acme, dana: acme });

    const withoutDana = removeUser(dana, "dana");
    expect(withoutDana.data.last_used).toEqual({ yaakov: acme });
    const reopened = await unlock(withoutDana.file, "yaakov", PASSWORD, NOW);
    expect(reopened.data.last_used).toEqual({ yaakov: acme });

    const noConnections = saveData(reopened, { ...reopened.data, connections: [] });
    expect(noConnections.data.last_used).toEqual({});
  });
});
