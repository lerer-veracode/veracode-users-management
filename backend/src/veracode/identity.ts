import {
  VeracodeError,
  baseUrl,
  failure,
  type Credentials,
  type Fetch,
  type TokenCache,
} from "./oauth.js";
import { withPurpose } from "../audit/audit.js";
import type { NewUser, Relationship, TeamRef, UserChanges } from "./rules.js";

export type AccessCheck = { ok: boolean; message: string };

export const checkAccess = async (
  creds: Credentials,
  tokens: TokenCache,
  fetchFn: Fetch,
): Promise<AccessCheck> => {
  try {
    const token = await tokens.get(creds);
    const res = await fetchFn(`${baseUrl(creds.region)}/v2/users?size=1`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    if (res.ok) return { ok: true, message: "Connected: the credentials can read users." };
    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        message: `Signed in, but not allowed to read users (${res.status}). The account needs the Admin API role.`,
      };
    }
    return { ok: false, message: (await failure(res, "Reading users")).message };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
};

type Json = Record<string, unknown>;

const isRecord = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const records = (v: unknown): Json[] => (Array.isArray(v) ? v.filter(isRecord) : []);

export type Permission = { permission_name: string; permission_description: string };
export type RoleRef = { role_name: string; role_description: string };
export type Team = { team_id: string; team_name: string; relationship: Relationship };

export type VeracodeUser = {
  user_id: string;
  user_name: string;
  first_name: string;
  last_name: string;
  email_address: string;
  user_type: "UI" | "API" | "SAML";
  active: boolean;
  login_enabled: boolean;
  // "Require MFA": Veracode's pin_required, a code from an authenticator at sign-in.
  pin_required: boolean;
  last_login: string | null;
  roles: RoleRef[];
  permissions: Permission[];
  teams: Team[];
  // Set on the first view of the list, before last login, type and MFA are read (docs/PLAN_CACHE.md, phase 6).
  details_pending?: true;
};

export type VeracodeRole = RoleRef & {
  role_id: string;
  is_api: boolean;
  is_scan_type: boolean;
  permissions: Permission[];
};

const PAGE_SIZE = 100;
const MAX_PAGES = 100;

// Reads every page of a HAL collection, such as _embedded.users. done, if given, is told each
// page's items and can end the reading early by answering true.
const readAll = async (
  creds: Credentials,
  tokens: TokenCache,
  fetchFn: Fetch,
  path: string,
  key: string,
  query: Record<string, string>,
  done?: (page: Json[]) => boolean,
): Promise<Json[]> => {
  const items: Json[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const token = await tokens.get(creds);
    const params = new URLSearchParams({ ...query, page: String(page), size: String(PAGE_SIZE) });
    const res = await fetchFn(`${baseUrl(creds.region)}${path}?${params}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    if (!res.ok) throw await failure(res, `Reading ${key}`);
    const body: unknown = await res.json();
    const embedded = isRecord(body) && isRecord(body._embedded) ? body._embedded[key] : [];
    const pageItems = records(embedded);
    items.push(...pageItems);
    if (done?.(pageItems)) break;
    // Veracode answers total_pages; the published spec says totalPages.
    const meta = isRecord(body) && isRecord(body.page) ? body.page : {};
    const total = meta.total_pages ?? meta.totalPages;
    const totalPages = typeof total === "number" ? total : 1;
    if (page + 1 >= totalPages) break;
  }
  return items;
};

const toPermission = (p: Json): Permission => ({
  permission_name: str(p.permission_name),
  permission_description: str(p.permission_description) || str(p.permission_name),
});

// The real records don't set the spec's api_user flag, so any of these marks an API user:
// the flag, an apiUser permission, a user or account type naming API, or an API role.
const isApiUser = (u: Json): boolean =>
  u.api_user === true ||
  records(u.permissions).some((p) => str(p.permission_name).toLowerCase() === "apiuser") ||
  /api/i.test(str(u.user_type)) ||
  /api/i.test(str(u.account_type)) ||
  records(u.roles).some((r) => r.is_api === true);

const toUser = (u: Json): VeracodeUser => ({
  user_id: str(u.user_id),
  user_name: str(u.user_name),
  first_name: str(u.first_name),
  last_name: str(u.last_name),
  email_address: str(u.email_address),
  user_type: isApiUser(u) ? "API" : u.saml_user === true ? "SAML" : "UI",
  active: u.active !== false,
  login_enabled: u.login_enabled !== false,
  pin_required: u.pin_required === true,
  last_login: str(u.last_login) || null,
  roles: records(u.roles).map((r) => ({
    role_name: str(r.role_name),
    role_description: str(r.role_description) || str(r.role_name),
  })),
  permissions: records(u.permissions).map(toPermission),
  // A team without a relationship is taken as plain membership.
  teams: records(u.teams).map((t) => ({
    team_id: str(t.team_id),
    team_name: str(t.team_name),
    relationship: relationshipOf(t.relationship),
  })),
});

// Veracode reads a team's relationship back as { name, display_name } (docs/REALITY.md, entry
// 38), though the spec and our requests use the plain string. Either form is accepted.
export const relationshipOf = (v: unknown): "ADMIN" | "MEMBER" => {
  const name = isRecord(v) ? v.name : v;
  return typeof name === "string" && name.toUpperCase() === "ADMIN" ? "ADMIN" : "MEMBER";
};

const DETAIL_CONCURRENCY = 8;

const readUser = async (
  creds: Credentials,
  tokens: TokenCache,
  fetchFn: Fetch,
  id: string,
): Promise<Json | null> => {
  const token = await tokens.get(creds);
  const res = await fetchFn(`${baseUrl(creds.region)}/v2/users/${encodeURIComponent(id)}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (!res.ok) return null;
  const body: unknown = await res.json();
  return isRecord(body) ? body : null;
};

// Reads these users' own records, a few at a time, into records. A record that can't be read is
// left out, and the user keeps what the list gave.
const readEach = async (
  creds: Credentials,
  tokens: TokenCache,
  fetchFn: Fetch,
  ids: string[],
  into: Map<string, Json>,
): Promise<void> => {
  let next = 0;
  const worker = async () => {
    while (next < ids.length) {
      const id = ids[next++] ?? "";
      const detail = await readUser(creds, tokens, fetchFn, id);
      if (detail) into.set(id, detail);
    }
  };
  await Promise.all(Array.from({ length: DETAIL_CONCURRENCY }, worker));
};

// With these options the list carries each user's roles and teams (docs/REALITY.md, entry 1);
// adding inactive empties it.
const LIST_OPTIONS = { detailed: "true", include_roles: "true", include_teams: "true" };

// Each by_role call takes seconds on Veracode (2026-11-10), so a few run at once.
const BY_ROLE_CONCURRENCY = 4;

// Full records from GET /v2/users/by_role/{roleId} (entry 39) for the users in the list, into
// full. Roles are chosen greedily: each round takes the roles that cover the most users not yet
// covered. A role's holders count as covered once it's read, even those Veracode didn't return
// (API accounts may not be), so the number of calls stays near the fewest roles that cover
// everyone, and never reaches every role in use. A failing call ends it; whoever is left is
// read one by one by the caller.
const readByRole = async (
  creds: Credentials,
  tokens: TokenCache,
  fetchFn: Fetch,
  basics: Json[],
  full: Map<string, Json>,
): Promise<void> => {
  const listed = new Set(basics.map((u) => str(u.user_id)));
  const holders = new Map<string, string[]>();
  for (const u of basics) {
    for (const r of records(u.roles)) {
      const role = str(r.role_id);
      if (role) holders.set(role, [...(holders.get(role) ?? []), str(u.user_id)]);
    }
  }
  const uncovered = new Set([...holders.values()].flat());
  const covers = (role: string, left: Set<string>) =>
    (holders.get(role) ?? []).filter((id) => left.has(id)).length;
  while (uncovered.size > 0) {
    // This round's roles: each the best cover of what the ones before it leave.
    const left = new Set(uncovered);
    const round: string[] = [];
    while (round.length < BY_ROLE_CONCURRENCY && left.size > 0) {
      let best = "";
      let most = 0;
      for (const role of holders.keys()) {
        const n = covers(role, left);
        if (n > most) [best, most] = [role, n];
      }
      if (!best) break;
      round.push(best);
      for (const id of holders.get(best) ?? []) left.delete(id);
    }
    if (round.length === 0) break;
    const results = await Promise.allSettled(
      round.map((role) =>
        readAll(
          creds,
          tokens,
          fetchFn,
          `/v2/users/by_role/${encodeURIComponent(role)}`,
          "users",
          {},
        ),
      ),
    );
    for (const [i, result] of results.entries()) {
      if (result.status === "rejected") return;
      for (const u of result.value) {
        const id = str(u.user_id);
        if (listed.has(id) && !full.has(id)) full.set(id, u);
        uncovered.delete(id);
      }
      const role = round[i] ?? "";
      for (const id of holders.get(role) ?? []) uncovered.delete(id);
      holders.delete(role);
    }
  }
};

// Every user, in bulk (docs/PLAN_CACHE.md, phase 4):
// 1. The list with its options: names, status, roles and teams, one call per 100 users.
// 2. Last login, MFA, user type and permissions from by_role (readByRole above).
// 3. Anyone still not seen (no role, not returned by by_role, or a call failed) has their own
//    record read. That record has no last login.
// If the list's options don't work, every user's own record is read, one call each, as before.
// roles: the organization's roles, to tell API roles (the list's roles don't say). A promise is
// read alongside the list rather than before it, so the two Veracode waits overlap.
export const listUsers = async (
  creds: Credentials,
  tokens: TokenCache,
  fetchFn: Fetch,
  roles: VeracodeRole[] | Promise<VeracodeRole[]> = [],
  // Called with the bulk list as soon as it's read, before the role reads that add last login,
  // type and MFA, so the page can show users sooner. Not called when the bulk list doesn't work.
  onFirst?: (users: VeracodeUser[]) => void,
): Promise<VeracodeUser[]> => {
  const rolesRead = Promise.resolve(roles);
  // If the list fails first, the roles' failure is never awaited; this keeps it from going unhandled.
  rolesRead.catch(() => undefined);
  let known: VeracodeRole[] = [];
  const isApiRole = (name: string) => known.some((k) => k.role_name === name && k.is_api);
  const merge = (basic: Json, full?: Json): VeracodeUser => {
    // The full record wins, except for teams: by_role records have none, so the list's are kept.
    const merged: Json = { ...basic, ...full };
    if (Array.isArray(basic.teams)) merged.teams = basic.teams;
    if (Array.isArray(merged.roles)) {
      merged.roles = records(merged.roles).map((r) => ({
        ...r,
        is_api: r.is_api === true || isApiRole(str(r.role_name)),
      }));
    }
    return toUser(merged);
  };
  let basics: Json[] = [];
  let bulk = true;
  try {
    basics = await readAll(creds, tokens, fetchFn, "/v2/users", "users", LIST_OPTIONS);
    bulk = basics.length === 0 || basics.some((u) => Array.isArray(u.roles));
  } catch (e) {
    if (e instanceof VeracodeError && (e.status === 401 || e.status === 403)) throw e;
    bulk = false;
  }
  if (!bulk) basics = await readAll(creds, tokens, fetchFn, "/v2/users", "users", {});
  known = await rolesRead;

  if (bulk) onFirst?.(basics.map((b) => ({ ...merge(b), details_pending: true })));

  const ids = basics.map((u) => str(u.user_id));
  const full = new Map<string, Json>();
  if (bulk) {
    await withPurpose("users of a role, for last login and user type", () =>
      readByRole(creds, tokens, fetchFn, basics, full),
    );
  }
  await withPurpose(
    bulk ? "a user missing from the role lists" : "one user at a time (bulk list unavailable)",
    () =>
      readEach(
        creds,
        tokens,
        fetchFn,
        ids.filter((id) => !full.has(id)),
        full,
      ),
  );

  return basics.map((basic) => merge(basic, full.get(str(basic.user_id))));
};

const userUrl = (creds: Credentials, id: string, query = "") =>
  `${baseUrl(creds.region)}/v2/users/${encodeURIComponent(id)}${query}`;

const send = async (
  creds: Credentials,
  tokens: TokenCache,
  fetchFn: Fetch,
  what: string,
  url: string,
  method: string,
  body?: unknown,
): Promise<Json | null> => {
  const token = await tokens.get(creds);
  const res = await fetchFn(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw await failure(res, what);
  const text = await res.text();
  if (!text) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

// One user's full record, read afresh. Fails if it can't be read, unlike the list's reads.
export const getUser = async (
  creds: Credentials,
  tokens: TokenCache,
  fetchFn: Fetch,
  id: string,
): Promise<VeracodeUser> => {
  const body = await send(creds, tokens, fetchFn, "Reading the user", userUrl(creds, id), "GET");
  if (!body) throw new VeracodeError("Reading the user failed: no user in the response", 502);
  return toUser(body);
};

const roleRefs = (names: string[]) => names.map((role_name) => ({ role_name }));
const teamRefs = (teams: TeamRef[]) =>
  teams.map(({ team_id, relationship }) => ({ team_id, relationship }));

export const createUser = async (
  creds: Credentials,
  tokens: TokenCache,
  fetchFn: Fetch,
  user: NewUser,
): Promise<VeracodeUser | null> => {
  const body = await send(
    creds,
    tokens,
    fetchFn,
    "Creating the user",
    `${baseUrl(creds.region)}/v2/users`,
    "POST",
    {
      ...user,
      active: true,
      login_enabled: true,
      roles: roleRefs(user.roles),
      teams: teamRefs(user.teams),
    },
  );
  return body && str(body.user_id) ? toUser(body) : null;
};

// partial=true: Veracode changes only the fields sent. Roles, when sent, replace the user's roles.
export const updateUser = async (
  creds: Credentials,
  tokens: TokenCache,
  fetchFn: Fetch,
  id: string,
  changes: UserChanges,
): Promise<VeracodeUser | null> => {
  const { roles, teams, ...rest } = changes;
  const reply = await send(
    creds,
    tokens,
    fetchFn,
    "Changing the user",
    userUrl(creds, id, "?partial=true"),
    "PUT",
    { ...rest, ...(roles && { roles: roleRefs(roles) }), ...(teams && { teams: teamRefs(teams) }) },
  );
  // The saved user, if Veracode's reply holds the whole record (user, roles and teams), so it
  // needn't be read again. Otherwise null, and the caller reads it (docs/REALITY.md, entry 23).
  const whole =
    reply &&
    typeof reply.user_id === "string" &&
    Array.isArray(reply.roles) &&
    Array.isArray(reply.teams);
  return whole ? toUser(reply) : null;
};

export const deleteUser = async (
  creds: Credentials,
  tokens: TokenCache,
  fetchFn: Fetch,
  id: string,
): Promise<void> => {
  await send(creds, tokens, fetchFn, "Deleting the user", userUrl(creds, id), "DELETE");
};

export const listRoles = async (
  creds: Credentials,
  tokens: TokenCache,
  fetchFn: Fetch,
): Promise<VeracodeRole[]> =>
  (await readAll(creds, tokens, fetchFn, "/v2/roles", "roles", {})).map((r) => ({
    role_id: str(r.role_id),
    role_name: str(r.role_name),
    role_description: str(r.role_description) || str(r.role_name),
    is_api: r.is_api === true,
    is_scan_type: r.is_scan_type === true,
    permissions: records(r.permissions).map(toPermission),
  }));

export type VeracodeTeam = { team_id: string; team_name: string };

export const listTeams = async (
  creds: Credentials,
  tokens: TokenCache,
  fetchFn: Fetch,
): Promise<VeracodeTeam[]> =>
  (await readAll(creds, tokens, fetchFn, "/v2/teams", "teams", {}))
    .map((t) => ({ team_id: str(t.team_id), team_name: str(t.team_name) }))
    .sort((a, b) => a.team_name.localeCompare(b.team_name));
