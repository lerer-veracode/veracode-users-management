import type { Region } from "../regions.js";
import {
  DEFAULT_COST,
  OpenError,
  deriveKey,
  newDataKey,
  newKdf,
  open,
  seal,
  type Cost,
  type KdfParams,
  type Sealed,
} from "./crypto.js";
import { MAX_AGE_DAYS, addDays, isPast } from "./retention.js";

export type Connection = {
  id: string;
  name: string;
  region: Region;
  client_id: string;
  client_secret: string;
  added_at: string;
  removes_at: string;
};

// last_used: each app user's last-used connection id. It sits in the encrypted part, so the
// vault doesn't reveal who uses which organization.
export type VaultData = { connections: Connection[]; last_used?: Record<string, string> };

export type VaultUser = {
  username: string;
  added_at: string;
  last_sign_in: string;
  removes_at: string;
  kdf: KdfParams;
  wrapped_key: Sealed;
};

export type VaultFile = { version: 1; users: VaultUser[]; data: Sealed };

export type Session = { file: VaultFile; dataKey: Buffer; data: VaultData; username: string };

export class VaultError extends Error {}

export const MIN_PASSWORD = 12;
const WRONG = "Wrong username or password.";

const isVaultData = (value: unknown): value is VaultData =>
  typeof value === "object" &&
  value !== null &&
  "connections" in value &&
  Array.isArray(value.connections);

export const normalizeUsername = (name: string): string => name.trim().toLowerCase();

const checkCredentials = (username: string, password: string) => {
  if (!/^[a-z0-9._@-]{2,64}$/.test(username)) {
    throw new VaultError("Usernames are 2 to 64 letters, digits or . _ @ -");
  }
  if (password.length < MIN_PASSWORD) {
    throw new VaultError(`Passwords need at least ${MIN_PASSWORD} characters.`);
  }
};

const sealData = (dataKey: Buffer, data: VaultData): Sealed =>
  seal(dataKey, Buffer.from(JSON.stringify(data), "utf8"));

const makeUser = async (
  username: string,
  password: string,
  dataKey: Buffer,
  now: Date,
  cost: Cost,
): Promise<VaultUser> => {
  checkCredentials(username, password);
  const kdf = newKdf(cost);
  const userKey = await deriveKey(password, kdf);
  return {
    username,
    added_at: now.toISOString(),
    last_sign_in: now.toISOString(),
    removes_at: addDays(now, MAX_AGE_DAYS),
    kdf,
    wrapped_key: seal(userKey, dataKey),
  };
};

export const createVault = async (
  rawUsername: string,
  password: string,
  now: Date,
  cost: Cost = DEFAULT_COST,
): Promise<Session> => {
  const username = normalizeUsername(rawUsername);
  const dataKey = newDataKey();
  const data: VaultData = { connections: [] };
  const user = await makeUser(username, password, dataKey, now, cost);
  return {
    file: { version: 1, users: [user], data: sealData(dataKey, data) },
    dataKey,
    data,
    username,
  };
};

export const unlock = async (
  file: VaultFile,
  rawUsername: string,
  password: string,
  now: Date,
): Promise<Session> => {
  const username = normalizeUsername(rawUsername);
  const user = file.users.find((u) => u.username === username);
  if (!user || isPast(user.removes_at, now)) {
    // Spend the same time as a real attempt so usernames can't be probed by timing.
    await deriveKey(password, user?.kdf ?? newKdf(file.users[0]?.kdf ?? DEFAULT_COST));
    throw new VaultError(WRONG);
  }
  let dataKey: Buffer;
  try {
    dataKey = open(await deriveKey(password, user.kdf), user.wrapped_key);
  } catch (e) {
    if (e instanceof OpenError) throw new VaultError(WRONG);
    throw e;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(open(dataKey, file.data).toString("utf8"));
  } catch {
    throw new VaultError("The vault is damaged.");
  }
  if (!isVaultData(parsed)) throw new VaultError("The vault is damaged.");
  return { file, dataKey, data: parsed, username };
};

export const recordSignIn = (session: Session, now: Date): Session => ({
  ...session,
  file: {
    ...session.file,
    users: session.file.users.map((u) =>
      u.username === session.username
        ? { ...u, last_sign_in: now.toISOString(), removes_at: addDays(now, MAX_AGE_DAYS) }
        : u,
    ),
  },
});

// Every save drops last-used entries for connections or app users that are gone.
export const saveData = (session: Session, data: VaultData): Session => {
  const pruned = pruneLastUsed(
    data,
    session.file.users.map((u) => u.username),
  );
  return {
    ...session,
    data: pruned,
    file: { ...session.file, data: sealData(session.dataKey, pruned) },
  };
};

export const addUser = async (
  session: Session,
  rawUsername: string,
  password: string,
  now: Date,
  cost: Cost = DEFAULT_COST,
): Promise<Session> => {
  const username = normalizeUsername(rawUsername);
  if (session.file.users.some((u) => u.username === username)) {
    throw new VaultError(`App user ${username} already exists.`);
  }
  const user = await makeUser(username, password, session.dataKey, now, cost);
  return { ...session, file: { ...session.file, users: [...session.file.users, user] } };
};

export const removeUser = (session: Session, rawUsername: string): Session => {
  const username = normalizeUsername(rawUsername);
  if (!session.file.users.some((u) => u.username === username)) {
    throw new VaultError(`No app user named ${username}.`);
  }
  if (session.file.users.length === 1) throw new VaultError("The last app user can't be removed.");
  const next = {
    ...session,
    file: { ...session.file, users: session.file.users.filter((u) => u.username !== username) },
  };
  return saveData(next, next.data);
};

export const newConnection = (
  fields: Pick<Connection, "name" | "region" | "client_id" | "client_secret">,
  now: Date,
): Connection => ({
  id: crypto.randomUUID(),
  ...fields,
  added_at: now.toISOString(),
  removes_at: addDays(now, MAX_AGE_DAYS),
});

export const expiredConnections = (data: VaultData, now: Date): Connection[] =>
  data.connections.filter((c) => isPast(c.removes_at, now));

export const removeExpiredUsers = (
  session: Session,
  now: Date,
): { session: Session; removed: string[] } => {
  const removed = session.file.users
    .filter((u) => isPast(u.removes_at, now))
    .map((u) => u.username);
  const next = {
    ...session,
    file: {
      ...session.file,
      users: session.file.users.filter((u) => !removed.includes(u.username)),
    },
  };
  return { removed, session: removed.length > 0 ? saveData(next, next.data) : next };
};

export const refresh = (session: Session, file: VaultFile, now: Date): Session => {
  const user = file.users.find((u) => u.username === session.username);
  if (!user || isPast(user.removes_at, now)) throw new VaultError("Your app user was removed.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(open(session.dataKey, file.data).toString("utf8"));
  } catch {
    throw new VaultError("The vault was replaced. Sign in again.");
  }
  if (!isVaultData(parsed)) throw new VaultError("The vault is damaged.");
  return { ...session, file, data: parsed };
};

// Removes last-used entries that point at connections or app users that no longer exist.
export const pruneLastUsed = (data: VaultData, usernames: string[]): VaultData => {
  const ids = new Set(data.connections.map((c) => c.id));
  const last_used = Object.fromEntries(
    Object.entries(data.last_used ?? {}).filter(
      ([user, id]) => usernames.includes(user) && ids.has(id),
    ),
  );
  return { ...data, last_used };
};

export const setLastUsed = (session: Session, connectionId: string): Session =>
  saveData(session, {
    ...session.data,
    last_used: { ...session.data.last_used, [session.username]: connectionId },
  });
