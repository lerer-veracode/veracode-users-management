import type {
  AppUser,
  AuditEntry,
  Connection,
  NewUser,
  Permission,
  Role,
  Source,
  TeamOption,
  User,
  UserChanges,
} from "../types";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

type Json = Record<string, unknown>;

const isRecord = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const strOrNull = (v: unknown): string | null => (typeof v === "string" ? v : null);
const list = (v: unknown): Json[] => (Array.isArray(v) ? v.filter(isRecord) : []);
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

// Every request goes to one of these fixed URLs on this app's own backend. Nothing from data
// becomes part of a URL; connection ids travel in the request body (CWE-918).
const ROUTES = {
  session: "/api/session",
  connections: "/api/connections",
  useConnection: "/api/connections/use",
  testConnection: "/api/connections/test",
  appUsers: "/api/app-users",
  audit: "/api/audit/page",
  users: "/api/users",
  usersFresh: "/api/users?refresh=1",
  userDetails: "/api/users/details",
  roles: "/api/roles",
  rolesFresh: "/api/roles?refresh=1",
  teams: "/api/teams",
  teamsFresh: "/api/teams?refresh=1",
  createUser: "/api/users/create",
  updateUser: "/api/users/update",
  deleteUser: "/api/users/delete",
  resetMfa: "/api/users/reset-mfa",
  readUser: "/api/users/read",
  importUsers: "/api/import",
} as const;

type Route = keyof typeof ROUTES;

const call = async (route: Route, method = "GET", body?: unknown): Promise<unknown> => {
  const res = await fetch(ROUTES[route], {
    method,
    credentials: "same-origin",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return null;
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const message = isRecord(data) ? str(data.error) : "";
    throw new ApiError(message || `Request failed (${res.status}).`, res.status);
  }
  return data;
};

export type SignedIn = { username: string; notices: string[] };

const toSignedIn = (data: unknown): SignedIn => {
  const d = isRecord(data) ? data : {};
  return { username: str(d.username), notices: strings(d.notices) };
};

export const getSession = async (): Promise<SignedIn | null> => {
  try {
    return toSignedIn(await call("session"));
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return null;
    throw e;
  }
};

export const signIn = async (username: string, password: string): Promise<SignedIn> =>
  toSignedIn(await call("session", "POST", { username, password }));

export const signOut = async (): Promise<void> => {
  await call("session", "DELETE");
};

export type ConnectionList = { connections: Connection[]; notices: string[] };

export const getConnections = async (): Promise<ConnectionList> => {
  const data = await call("connections");
  const d = isRecord(data) ? data : {};
  return {
    notices: strings(d.notices),
    connections: list(d.connections).map((c) => ({
      id: str(c.id),
      name: str(c.name),
      region: str(c.region),
      client_id: str(c.client_id),
      added_at: str(c.added_at),
      removes_at: str(c.removes_at),
      token_expires: strOrNull(c.token_expires),
      active: c.active === true,
    })),
  };
};

export const selectConnection = async (id: string): Promise<void> => {
  await call("useConnection", "POST", { id });
};

export type TestResult = { ok: boolean; message: string };

export const testConnection = async (id: string): Promise<TestResult> => {
  const data = await call("testConnection", "POST", { id });
  const d = isRecord(data) ? data : {};
  return { ok: d.ok === true, message: str(d.message) };
};

export const getAppUsers = async (): Promise<AppUser[]> =>
  list(await call("appUsers")).map((u) => ({
    username: str(u.username),
    added_at: str(u.added_at),
    last_sign_in: str(u.last_sign_in),
    removes_at: str(u.removes_at),
  }));

const describeRequest = (e: Json): string | null => {
  const method = str(e.method);
  if (!method) return null;
  const status = typeof e.status === "number" ? ` -> ${e.status}` : "";
  return `${method} ${str(e.path)}${status}`;
};

export type AuditPage = { entries: AuditEntry[]; total: number };

export const getAudit = async (
  page: number,
  size: number,
  failedOnly: boolean,
): Promise<AuditPage> => {
  const data = await call("audit", "POST", { page, size, failed_only: failedOnly });
  const d = isRecord(data) ? data : {};
  return {
    total: typeof d.total === "number" ? d.total : 0,
    entries: list(d.entries).map((e) => {
      const conn = isRecord(e.connection) ? e.connection : null;
      return {
        time: str(e.time),
        actor: str(e.actor),
        action: str(e.action),
        outcome: e.outcome === "ok" ? "ok" : "failed",
        connection: conn ? `${str(conn.name)} (${str(conn.region)})` : null,
        reason: strOrNull(e.reason),
        purpose: strOrNull(e.purpose),
        request: describeRequest(e),
        ms: typeof e.ms === "number" ? e.ms : null,
        result: strOrNull(e.result),
        detail: strOrNull(e.detail),
        target: isRecord(e.target) ? str(e.target.user_name) || null : null,
        changes: list(e.changes).map((c) => ({
          field: str(c.field),
          from: strOrNull(c.from),
          to: strOrNull(c.to),
        })),
      };
    }),
  };
};

const toPermissions = (v: unknown): Permission[] =>
  list(v).map((p) => ({
    permission_name: str(p.permission_name),
    permission_description: str(p.permission_description),
  }));

const USER_TYPES = ["UI", "API", "SAML"] as const;
const ROLE_KINDS = ["plain", "scan_type", "any_scan", "needs_scan_type", "team_admin"] as const;

const toSource = (data: Json): Source => {
  const s = isRecord(data.connection) ? data.connection : {};
  return { id: str(s.id), name: str(s.name), region: str(s.region) };
};

export type UsersAnswer = { source: Source; users: User[]; complete: boolean };

const toUsersAnswer = (data: unknown): UsersAnswer => {
  const d = isRecord(data) ? data : {};
  return { source: toSource(d), users: list(d.users).map(toUser), complete: d.complete !== false };
};

// The first view of the users: complete is false while last login, type and MFA are still
// being read; getUserDetails then waits for them.
export const getUsers = async (fresh = false): Promise<UsersAnswer> =>
  toUsersAnswer(await call(fresh ? "usersFresh" : "users"));

export const getUserDetails = async (): Promise<UsersAnswer> =>
  toUsersAnswer(await call("userDetails"));

const toUser = (u: Json): User => ({
  user_id: str(u.user_id),
  user_name: str(u.user_name),
  first_name: str(u.first_name),
  last_name: str(u.last_name),
  email_address: str(u.email_address),
  user_type: USER_TYPES.find((t) => t === u.user_type) ?? "UI",
  active: u.active === true,
  login_enabled: u.login_enabled === true,
  pin_required: u.pin_required === true,
  last_login: strOrNull(u.last_login),
  roles: list(u.roles).map((r) => ({
    role_name: str(r.role_name),
    role_description: str(r.role_description),
  })),
  permissions: toPermissions(u.permissions),
  teams: list(u.teams).map((x) => ({
    team_id: str(x.team_id),
    team_name: str(x.team_name),
    relationship: x.relationship === "ADMIN" ? "ADMIN" : "MEMBER",
  })),
  details_pending: u.details_pending === true,
  // A user the backend doesn't vouch for is treated as locked.
  locked: "locked" in u ? strOrNull(u.locked) : "Unknown whether this user may be changed.",
  mfa_locked:
    "mfa_locked" in u ? strOrNull(u.mfa_locked) : "Unknown whether this user's MFA may be reset.",
});

// Changes go to fixed URLs; the connection shown, and the user, travel in the body. The
// backend refuses a change if the connection in use is no longer the one shown.
export const createUser = async (
  connectionId: string,
  user: NewUser,
): Promise<{ user_name: string }> => {
  const data = await call("createUser", "POST", { connection_id: connectionId, user });
  return { user_name: isRecord(data) ? str(data.user_name) : user.email_address };
};

export const updateUser = async (
  connectionId: string,
  id: string,
  changes: UserChanges,
): Promise<void> => {
  await call("updateUser", "POST", { connection_id: connectionId, id, changes });
};

// One user's record, read afresh from Veracode.
export const readUser = async (connectionId: string, id: string): Promise<User> => {
  const data = await call("readUser", "POST", { connection_id: connectionId, id });
  const user = isRecord(data) ? data.user : null;
  return toUser(isRecord(user) ? user : {});
};

// A CSV import (docs/PLAN_CSV.md, phase 2): the users to create, and what happened to each.
export type ImportUser = {
  line: number;
  email_address: string;
  user_name: string;
  first_name: string;
  last_name: string;
  roles: string[];
};
export type ImportResult = {
  line: number;
  user_name: string;
  status: "created" | "failed";
  error: string;
};

export const importUsers = async (
  connectionId: string,
  users: ImportUser[],
): Promise<ImportResult[]> => {
  const data = await call("importUsers", "POST", { connection_id: connectionId, users });
  return list(isRecord(data) ? data.results : null).map((r) => ({
    line: typeof r.line === "number" ? r.line : 0,
    user_name: str(r.user_name),
    status: r.status === "created" ? "created" : "failed",
    error: str(r.error),
  }));
};

export const deleteUser = async (
  connectionId: string,
  id: string,
  confirm: string,
): Promise<void> => {
  await call("deleteUser", "POST", { connection_id: connectionId, id, confirm });
};

export const resetMfa = async (
  connectionId: string,
  id: string,
  confirm: string,
): Promise<void> => {
  await call("resetMfa", "POST", { connection_id: connectionId, id, confirm });
};

export const getRoles = async (fresh = false): Promise<{ source: Source; roles: Role[] }> => {
  const data = await call(fresh ? "rolesFresh" : "roles");
  const d = isRecord(data) ? data : {};
  return {
    source: toSource(d),
    roles: list(d.roles).map((r) => ({
      role_name: str(r.role_name),
      role_description: str(r.role_description),
      is_api: r.is_api === true,
      permissions: toPermissions(r.permissions),
      assignable: r.assignable === true,
      kind: ROLE_KINDS.find((k) => k === r.kind) ?? "plain",
      no_team_restriction: r.no_team_restriction === true,
    })),
  };
};

export const getTeams = async (fresh = false): Promise<{ source: Source; teams: TeamOption[] }> => {
  const data = await call(fresh ? "teamsFresh" : "teams");
  const d = isRecord(data) ? data : {};
  return {
    source: toSource(d),
    teams: list(d.teams).map((t) => ({ team_id: str(t.team_id), team_name: str(t.team_name) })),
  };
};
