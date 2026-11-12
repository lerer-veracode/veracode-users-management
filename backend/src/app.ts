import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import {
  auditedFetch,
  connectionRef,
  withAudit,
  withPurpose,
  type AuditLog,
} from "./audit/audit.js";
import { REGIONS } from "./regions.js";
import { Sessions, Throttle, type ActiveSession } from "./sessions.js";
import {
  checkAccess,
  createUser,
  deleteUser,
  getUser,
  listRoles,
  listTeams,
  listUsers,
  updateUser,
  type VeracodeRole,
  type VeracodeTeam,
  type VeracodeUser,
} from "./veracode/identity.js";
import { describeCreate, describeDelete, describeUpdate } from "./veracode/describe.js";
import { TokenCache, VeracodeError, type Fetch } from "./veracode/oauth.js";
import {
  assignable,
  checkChanges,
  checkNewUser,
  isAdministratorRole,
  protectedReason,
  roleKind,
  type Org,
} from "./veracode/rules.js";
import { withoutHidden } from "./veracode/hidden.js";
import { cleanUp, type CleanupReport } from "./vault/cleanup.js";
import { readVault, writeVault } from "./vault/file.js";
import { MAX_AGE_DAYS, isPast } from "./vault/retention.js";
import {
  VaultError,
  recordSignIn,
  refresh,
  setLastUsed,
  unlock,
  type Connection,
  type Session,
} from "./vault/vault.js";

export type AppDeps = {
  vaultPath: string;
  fetch: Fetch;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  audit: AuditLog;
  // Permissions never sent to the dashboard (config/hidden-permissions.txt, docs/PLAN_ROLES.md).
  hiddenPermissions?: string[];
};

const COOKIE = "um_session";

const describeCleanup = (report: CleanupReport): string[] => [
  ...report.removedUsers.map((u) => `Removed app user ${u}: no sign-in for ${MAX_AGE_DAYS} days.`),
  ...report.revoked.map(({ connection, results }) =>
    results.every((r) => r.ok)
      ? `Removed ${connection.name} after ${MAX_AGE_DAYS} days and revoked it on Veracode.`
      : `Removed ${connection.name} after ${MAX_AGE_DAYS} days. Revoking it on Veracode failed; revoke it on the platform.`,
  ),
];

const readCredentials = (body: unknown): { username: string; password: string } | null =>
  typeof body === "object" &&
  body !== null &&
  "username" in body &&
  "password" in body &&
  typeof body.username === "string" &&
  typeof body.password === "string"
    ? { username: body.username, password: body.password }
    : null;

type Env = { Variables: { session: ActiveSession } };

const bodyField = (body: unknown, key: string): unknown =>
  typeof body === "object" && body !== null
    ? Object.getOwnPropertyDescriptor(body, key)?.value
    : undefined;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const listOf = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export const createApp = (deps: AppDeps) => {
  const sessions = new Sessions();
  const throttle = new Throttle();
  const { audit } = deps;
  // Every call to Veracode goes through this, so every call is in the audit log.
  const veracode = auditedFetch(deps.fetch, audit);
  const tokens = new TokenCache(veracode, () => deps.now().getTime());
  const ref = (conn: Connection) => connectionRef({ ...conn, region: REGIONS[conn.region].label });
  const app = new Hono<Env>().basePath("/api");

  // Re-reads the vault so changes made with npm run connect show up, and runs the clean-up.
  const sync = async (session: ActiveSession): Promise<string[]> => {
    const file = await readVault(deps.vaultPath);
    if (!file) throw new VaultError("The vault is gone. Run npm run connect.");
    const now = deps.now();
    const { session: vault, report } = await cleanUp(
      refresh(session.vault, file, now),
      now,
      veracode,
      audit,
    );
    if (report.removedUsers.length > 0 || report.revoked.length > 0) {
      await writeVault(deps.vaultPath, vault.file);
      for (const { connection } of report.revoked) tokens.drop(connection);
    }
    session.vault = vault;
    session.activeConnectionId = chooseActive(vault, session.activeConnectionId);
    return describeCleanup(report);
  };

  const liveIn = (vault: Session): Connection[] =>
    vault.data.connections.filter((c) => !isPast(c.removes_at, deps.now()));
  const live = (session: ActiveSession): Connection[] => liveIn(session.vault);

  // The connection in use: the current one if it's still valid, else the app user's last-used
  // one, else the only connection if there is just one. With several and no choice yet: none.
  const chooseActive = (vault: Session, current: string | null): string | null => {
    const ids = liveIn(vault).map((c) => c.id);
    const last = vault.data.last_used?.[vault.username] ?? null;
    if (current && ids.includes(current)) return current;
    if (last && ids.includes(last)) return last;
    return ids.length === 1 ? (ids[0] ?? null) : null;
  };

  app.get("/health", (c) => c.json({ status: "ok" }));

  app.get("/regions", (c) =>
    c.json(Object.entries(REGIONS).map(([id, { label }]) => ({ id, label }))),
  );

  app.post("/session", async (c) => {
    const creds = readCredentials(await c.req.json().catch(() => null));
    if (!creds) return c.json({ error: "Enter a username and password." }, 400);
    const file = await readVault(deps.vaultPath);
    if (!file) {
      return c.json(
        { error: "No vault yet. Run npm run connect in a terminal to create it." },
        409,
      );
    }
    const key = creds.username.trim().toLowerCase();
    await deps.sleep(throttle.delayFor(key));
    const now = deps.now();
    let vault;
    try {
      vault = recordSignIn(await unlock(file, creds.username, creds.password, now), now);
    } catch (e) {
      if (!(e instanceof VaultError)) throw e;
      throttle.fail(key);
      await audit.record({
        actor: key,
        action: "app.sign_in",
        outcome: "failed",
        detail: e.message,
      });
      return c.json({ error: e.message }, 401);
    }
    throttle.succeed(key);
    // Each sign-in reads roles and teams afresh, the first time they're needed.
    keptRoles.clear();
    keptTeams.clear();
    const signedIn = vault;
    await audit.record({ actor: signedIn.username, action: "app.sign_in", outcome: "ok" });
    const cleaned = await withAudit(
      { actor: signedIn.username, purpose: "Sign-in: remove connections past their time" },
      () => cleanUp(signedIn, now, veracode, audit),
    );
    await writeVault(deps.vaultPath, cleaned.session.file);
    const session = sessions.create(
      cleaned.session,
      now.getTime(),
      chooseActive(cleaned.session, null),
    );
    setCookie(c, COOKIE, session.id, { httpOnly: true, sameSite: "Strict", path: "/api" });
    return c.json({ username: session.vault.username, notices: describeCleanup(cleaned.report) });
  });

  app.use("*", async (c, next) => {
    const session = sessions.get(getCookie(c, COOKIE), deps.now().getTime());
    if (!session) return c.json({ error: "Sign in first." }, 401);
    c.set("session", session);
    await withAudit({ actor: session.vault.username }, () => next());
  });

  app.onError((err, c) => {
    if (err instanceof VaultError) {
      sessions.delete(getCookie(c, COOKIE));
      return c.json({ error: err.message }, 401);
    }
    throw err;
  });

  app.get("/session", (c) => c.json({ username: c.var.session.vault.username }));

  app.delete("/session", async (c) => {
    await audit.record({ action: "app.sign_out", outcome: "ok" });
    sessions.delete(c.var.session.id);
    deleteCookie(c, COOKIE, { path: "/api" });
    return c.body(null, 204);
  });

  app.get("/connections", async (c) => {
    const session = c.var.session;
    const notices = await sync(session);
    return c.json({
      notices,
      connections: live(session).map((conn) => ({
        id: conn.id,
        name: conn.name,
        region: REGIONS[conn.region].label,
        client_id: conn.client_id,
        added_at: conn.added_at,
        removes_at: conn.removes_at,
        token_expires: tokens.expiresAt(conn),
        active: conn.id === session.activeConnectionId,
      })),
    });
  });

  // The connection id comes in the body, so the dashboard's request URLs are all fixed (CWE-918).
  const find = async (c: { req: { json: () => Promise<unknown> } }, session: ActiveSession) => {
    const body: unknown = await c.req.json().catch(() => null);
    const id = typeof body === "object" && body !== null && "id" in body ? body.id : null;
    return live(session).find((conn) => conn.id === id);
  };

  app.post("/connections/use", async (c) => {
    const conn = await find(c, c.var.session);
    if (!conn) return c.json({ error: "No such connection." }, 404);
    const session = c.var.session;
    session.activeConnectionId = conn.id;
    // Remember it as this app user's last-used connection, on a fresh copy of the vault.
    const file = await readVault(deps.vaultPath);
    if (!file) throw new VaultError("The vault is gone. Run npm run connect.");
    session.vault = setLastUsed(refresh(session.vault, file, deps.now()), conn.id);
    await writeVault(deps.vaultPath, session.vault.file);
    await audit.record({ action: "connection.selected", outcome: "ok", connection: ref(conn) });
    return c.json({ name: conn.name });
  });

  app.post("/connections/test", async (c) => {
    const conn = await find(c, c.var.session);
    if (!conn) return c.json({ error: "No such connection." }, 404);
    const audited = { connection: ref(conn), reason: "test", purpose: "Test the connection" };
    const result = await withAudit(audited, async () => {
      const check = await checkAccess(conn, tokens, veracode);
      await audit.record({
        action: "auth.check",
        outcome: check.ok ? "ok" : "failed",
        detail: check.message,
      });
      return check;
    });
    return c.json({ ...result, token_expires: tokens.expiresAt(conn) });
  });

  // Reads from the connection in use. Veracode errors become a clear message, not a crash.
  // The users are kept for 15 minutes per connection, and patched after each change made here
  // (docs/PLAN_CACHE.md, phase 4). ?refresh=1 reads afresh.
  const cache = new Map<string, { at: number; value: unknown }>();
  const CACHE_MS = 15 * 60 * 1000;
  const loading = new Map<string, Promise<unknown>>();
  // Counts the changes made to each connection's users, so a read that a change overtook isn't kept.
  const versions = new Map<string, number>();
  // When each kept user was last read from Veracode, beyond the list's own time. A user read
  // within RECENT_MS isn't read again when their details or the edit form open.
  const readAt = new Map<string, number>();
  const RECENT_MS = 60 * 1000;
  // What each list is read for, in the activity log.
  const PURPOSES: Record<string, string> = {
    users: "Load the users list",
    roles: "Load the roles",
    teams: "Load the teams",
  };

  const inUse = (session: ActiveSession) =>
    live(session).find((x) => x.id === session.activeConnectionId);

  // Veracode errors become a clear message, not a crash.
  const veracodeFailure = (c: Context<Env>, conn: Connection, e: unknown) => {
    if (!(e instanceof VeracodeError)) {
      const reason = e instanceof Error ? e.message : String(e);
      return c.json({ error: `Could not reach Veracode: ${reason}` }, 502);
    }
    const denied = e.status === 401 || e.status === 403;
    const error = denied
      ? `The ${conn.name} connection is not allowed to do this (${e.status}). It needs the Admin API role.`
      : e.message;
    return c.json({ error }, 502);
  };

  // Roles and teams change only on the Platform, never through this app. Each connection's are
  // read once and kept until an app user signs in or asks for a refresh (docs/PLAN_CACHE.md,
  // phase 3). No time limit and no schedule.
  const keptRoles = new Map<string, VeracodeRole[]>();
  const keptTeams = new Map<string, VeracodeTeam[]>();
  // A read already under way is shared: at page load the users list and the roles page both
  // ask for the roles at the same moment, and one call answers both.
  const kept = <T>(store: Map<string, T>, read: (conn: Connection) => Promise<T>) => {
    const reading = new Map<string, Promise<T>>();
    return async (conn: Connection, fresh = false): Promise<T> => {
      const hit = store.get(conn.id);
      if (hit && !fresh) return hit;
      let running = reading.get(conn.id);
      if (!running) {
        running = read(conn).then((value) => {
          store.set(conn.id, value);
          return value;
        });
        reading.set(conn.id, running);
        const done = () => reading.delete(conn.id);
        void running.then(done, done);
      }
      return running;
    };
  };
  const rolesOf = kept(keptRoles, (conn) => listRoles(conn, tokens, veracode));
  const teamsOf = kept(keptTeams, (conn) => listTeams(conn, tokens, veracode));

  // The connection in use, and how answers name it, or the answer to give when there's none.
  // Every answer names the connection it came from, so lists from two organizations can't be mixed up.
  const connOf = (c: Context<Env>) => {
    const session = c.var.session;
    const conn = inUse(session);
    if (!conn) {
      const error =
        live(session).length > 1
          ? "Choose a connection first."
          : "No connection in use. Add one with npm run connect.";
      return c.json({ error }, 409);
    }
    return { conn, from: { id: conn.id, name: conn.name, region: REGIONS[conn.region].label } };
  };

  // kept: the read keeps its own copy (roles, teams), so the short cache isn't used.
  const readFromVeracode =
    <T>(name: string, read: (conn: Connection, fresh: boolean) => Promise<T>, kept = false) =>
    async (c: Context<Env>) => {
      const found = connOf(c);
      if (found instanceof Response) return found;
      const { conn, from } = found;
      const key = `${name}:${conn.id}`;
      const hit = cache.get(key);
      const now = deps.now().getTime();
      const fresh = c.req.query("refresh") === "1";
      if (!kept && hit && now - hit.at < CACHE_MS && !fresh) {
        return c.json({ connection: from, [name]: hit.value });
      }
      try {
        // A read already under way for this connection is shared, not started again: reading
        // users can take a while, and a Refresh meanwhile would double it.
        // A change made while it runs makes its result out of date: it's shown, not kept.
        const version = versions.get(key) ?? 0;
        let running = loading.get(key);
        if (!running) {
          const purpose = `${fresh ? "Refresh: " : ""}${PURPOSES[name] ?? name}`;
          running = withAudit({ connection: ref(conn), purpose }, () => read(conn, fresh));
          loading.set(key, running);
          void running.then(
            () => loading.delete(key),
            () => loading.delete(key),
          );
        }
        const value = (await running) as T;
        if (!kept && (versions.get(key) ?? 0) === version) cache.set(key, { at: now, value });
        return c.json({ connection: from, [name]: value });
      } catch (e) {
        return veracodeFailure(c, conn, e);
      }
    };

  // Each user says whether this app may change them, and why not; each role whether it may be given.
  const hidden = deps.hiddenPermissions ?? [];
  const withLock = (u: VeracodeUser) => ({
    ...withoutHidden(hidden, u),
    locked: protectedReason(u),
  });

  // The users load in two steps (docs/PLAN_CACHE.md, phase 6). The first view is the bulk list,
  // sent as soon as it's read; the role reads that add last login, type and MFA carry on, and
  // GET /users/details waits for them. Only the complete list is kept. A user on the first view
  // is locked until their details are in, unless they're an administrator.
  type Listed = ReturnType<typeof withLock>;
  type UsersLoad = { first: Promise<Listed[]>; full: Promise<Listed[]> };
  const usersLoading = new Map<string, UsersLoad>();
  const PENDING = "This user's details are still being read from Veracode. Try again in a moment.";
  const firstView = (u: VeracodeUser) => ({
    ...withoutHidden(hidden, u),
    locked: u.roles.some(isAdministratorRole) ? protectedReason(u) : PENDING,
  });

  const loadUsers = (conn: Connection, fresh: boolean): UsersLoad => {
    const key = `users:${conn.id}`;
    const running = usersLoading.get(key);
    if (running) return running;
    const version = versions.get(key) ?? 0;
    const at = deps.now().getTime();
    let showFirst: (users: Listed[]) => void = () => undefined;
    const early = new Promise<Listed[]>((resolve) => (showFirst = resolve));
    const purpose = `${fresh ? "Refresh: " : ""}Load the users list`;
    const full = withAudit({ connection: ref(conn), purpose }, async () => {
      // The roles and the users list are read at the same time (docs/PLAN_CACHE.md, phase 6).
      const users = await listUsers(conn, tokens, veracode, rolesOf(conn), (first) =>
        showFirst(first.map(firstView)),
      );
      return users.map(withLock);
    });
    // Without a first view (the bulk list didn't work), the complete list is the first view.
    const load = { first: Promise.race([early, full]), full };
    usersLoading.set(key, load);
    void full
      .then((value) => {
        // A change made while it ran makes it out of date: it's shown, not kept.
        if ((versions.get(key) ?? 0) === version) cache.set(key, { at, value });
      })
      .catch(() => undefined)
      .finally(() => usersLoading.delete(key));
    return load;
  };
  const keptUsers = (conn: Connection): Listed[] | undefined => {
    const hit = cache.get(`users:${conn.id}`);
    return hit && deps.now().getTime() - hit.at < CACHE_MS && Array.isArray(hit.value)
      ? (hit.value as Listed[])
      : undefined;
  };

  app.get("/users", async (c) => {
    const found = connOf(c);
    if (found instanceof Response) return found;
    const { conn, from } = found;
    const fresh = c.req.query("refresh") === "1";
    const hit = fresh ? undefined : keptUsers(conn);
    if (hit) return c.json({ connection: from, users: hit, complete: true });
    try {
      const users = await loadUsers(conn, fresh).first;
      const complete = !users.some((u) => u.details_pending);
      return c.json({ connection: from, users, complete });
    } catch (e) {
      return veracodeFailure(c, conn, e);
    }
  });

  // The complete list: last login, type and MFA included. Waits for a load under way.
  app.get("/users/details", async (c) => {
    const found = connOf(c);
    if (found instanceof Response) return found;
    const { conn, from } = found;
    const running = usersLoading.get(`users:${conn.id}`);
    const hit = running ? undefined : keptUsers(conn);
    if (hit) return c.json({ connection: from, users: hit, complete: true });
    try {
      const users = await (running ?? loadUsers(conn, false)).full;
      return c.json({ connection: from, users, complete: true });
    } catch (e) {
      return veracodeFailure(c, conn, e);
    }
  });
  app.get(
    "/roles",
    readFromVeracode(
      "roles",
      async (conn, fresh) => {
        const roles = await rolesOf(conn, fresh);
        const ok = new Set(assignable(roles).map((r) => r.role_name));
        return roles.map((r) => ({
          ...withoutHidden(hidden, r),
          assignable: ok.has(r.role_name),
          kind: roleKind(r),
        }));
      },
      true,
    ),
  );

  app.get(
    "/teams",
    readFromVeracode("teams", (conn, fresh) => teamsOf(conn, fresh), true),
  );

  // The kept roles and teams, to check a change against. A change naming a role or team that
  // isn't in them reads that list again once, so one just made on the Platform still works.
  const readOrg = async (conn: Connection, wanted: unknown): Promise<Org> => {
    const asked = isRecord(wanted) ? wanted : {};
    const roleNames = listOf(asked.roles).filter((r): r is string => typeof r === "string");
    const teamIds = listOf(asked.teams)
      .map((t) => (isRecord(t) ? t.team_id : undefined))
      .filter((t): t is string => typeof t === "string");
    let [roles, teams] = await Promise.all([rolesOf(conn), teamsOf(conn)]);
    if (roleNames.some((n) => !roles.some((r) => r.role_name === n))) {
      roles = await withPurpose("a role named isn't known yet, so read the roles again", () =>
        rolesOf(conn, true),
      );
    }
    if (teamIds.some((id) => !teams.some((t) => t.team_id === id))) {
      teams = await withPurpose("a team named isn't known yet, so read the teams again", () =>
        teamsOf(conn, true),
      );
    }
    return { roles, teams };
  };

  // Changes to users. The dashboard sends the connection it shows; a change is refused unless
  // that is still the connection in use, so it can't land in another organization. The user is
  // read afresh from Veracode before any change, and the rules in rules.ts are checked here
  // whatever the dashboard allowed.
  type Target = { conn: Connection; body: unknown };
  const target = async (c: Context<Env>): Promise<Target | Response> => {
    const body: unknown = await c.req.json().catch(() => null);
    const conn = inUse(c.var.session);
    if (!conn || bodyField(body, "connection_id") !== conn.id) {
      return c.json({ error: "The connection changed. Refresh and try again." }, 409);
    }
    return { conn, body };
  };

  // Before any change, the user is read as Veracode has them now: this is what stops a change to
  // an Administrator, whatever the list or the dashboard said.
  const loadTarget = async (
    conn: Connection,
    body: unknown,
    step = "safety check, read the user",
  ) => {
    const id = bodyField(body, "id");
    if (typeof id !== "string" || !id) return null;
    return withPurpose(step, () => getUser(conn, tokens, veracode, id));
  };

  // After a change, the kept users are patched rather than read again: the changed user is put
  // in (or taken out), keeping their last login, which a user's own record doesn't have
  // (docs/REALITY.md, entry 39). With no user to put in, the list is dropped and read next time.
  const changed = (conn: Connection, id: string, user: VeracodeUser | null | "deleted") => {
    const key = `users:${conn.id}`;
    versions.set(key, (versions.get(key) ?? 0) + 1);
    const hit = cache.get(key);
    if (user === null || user === "deleted") readAt.delete(`${conn.id}:${id}`);
    else readAt.set(`${conn.id}:${id}`, deps.now().getTime());
    if (!hit || !Array.isArray(hit.value)) return;
    if (user === null) return cache.delete(key);
    const list = hit.value as Listed[];
    const old = list.find((u) => u.user_id === id);
    const rest = list.filter((u) => u.user_id !== id);
    const value =
      user === "deleted"
        ? rest
        : [...rest, withLock({ ...user, last_login: user.last_login ?? old?.last_login ?? null })];
    cache.set(key, { at: hit.at, value });
  };
  // The kept copy of one user, if any.
  const keptUser = (conn: Connection, id: string): Listed | undefined => {
    const hit = cache.get(`users:${conn.id}`);
    return Array.isArray(hit?.value)
      ? (hit.value as Listed[]).find((u) => u.user_id === id)
      : undefined;
  };
  // The kept copy of one user, if it was read from Veracode within the last RECENT_MS.
  const recentUser = (conn: Connection, id: string): Listed | undefined => {
    const hit = cache.get(`users:${conn.id}`);
    const at = Math.max(hit?.at ?? 0, readAt.get(`${conn.id}:${id}`) ?? 0);
    return deps.now().getTime() - at < RECENT_MS ? keptUser(conn, id) : undefined;
  };

  app.post("/users/create", async (c) => {
    const t = await target(c);
    if (t instanceof Response) return t;
    const { conn, body } = t;
    try {
      return await withAudit({ connection: ref(conn), purpose: "Create a user" }, async () => {
        const org = await readOrg(conn, bodyField(body, "user"));
        const checked = checkNewUser(bodyField(body, "user"), org);
        if (!checked.ok) return c.json({ error: checked.error }, 400);
        const user = checked.value;
        const audited = {
          reason: `create ${user.user_name}`,
          target: { user_name: user.user_name },
          changes: describeCreate(user, org),
        };
        const created = await withAudit(audited, () => createUser(conn, tokens, veracode, user));
        changed(conn, created?.user_id ?? "", created);
        return c.json({ user: created && withLock(created), user_name: user.user_name });
      });
    } catch (e) {
      return veracodeFailure(c, conn, e);
    }
  });

  app.post("/users/update", async (c) => {
    const t = await target(c);
    if (t instanceof Response) return t;
    const { conn, body } = t;
    try {
      return await withAudit({ connection: ref(conn), purpose: "Change a user" }, async () => {
        const current = await loadTarget(conn, body);
        if (!current) return c.json({ error: "Say which user to change." }, 400);
        const locked = protectedReason(current);
        if (locked) return c.json({ error: locked }, 403);
        const org = await readOrg(conn, bodyField(body, "changes"));
        const checked = checkChanges(bodyField(body, "changes"), current, org);
        if (!checked.ok) return c.json({ error: checked.error }, 400);
        const fields = Object.keys(checked.value).join(", ");
        const audited = {
          reason: `update ${current.user_name}: ${fields}`,
          target: { user_id: current.user_id, user_name: current.user_name },
          changes: describeUpdate(current, checked.value, org),
        };
        const saved = await withAudit(audited, () =>
          withPurpose("save", () =>
            updateUser(conn, tokens, veracode, current.user_id, checked.value),
          ),
        );
        // Veracode's reply is used when it holds the whole user; otherwise the user is read.
        const fresh =
          saved ??
          (await withPurpose("read the saved user (the save reply didn't hold it)", () =>
            getUser(conn, tokens, veracode, current.user_id),
          ));
        changed(conn, current.user_id, fresh);
        return c.json({ user: keptUser(conn, current.user_id) ?? withLock(fresh) });
      });
    } catch (e) {
      return veracodeFailure(c, conn, e);
    }
  });

  // One user's record, read afresh when their details or the edit form open, so a change starts
  // from what Veracode has now. The kept list is patched with it. A user read in the last minute
  // (the list, or this user alone) isn't read again: the safety check before a change still is.
  app.post("/users/read", async (c) => {
    const t = await target(c);
    if (t instanceof Response) return t;
    const { conn, body } = t;
    try {
      const id = bodyField(body, "id");
      const recent = typeof id === "string" ? recentUser(conn, id) : undefined;
      if (recent) return c.json({ user: recent });
      const purpose = "Open a user's details or edit form";
      return await withAudit({ connection: ref(conn), purpose }, async () => {
        const fresh = await loadTarget(conn, body, "read the user");
        if (!fresh) return c.json({ error: "Say which user to read." }, 400);
        changed(conn, fresh.user_id, fresh);
        return c.json({ user: keptUser(conn, fresh.user_id) ?? withLock(fresh) });
      });
    } catch (e) {
      return veracodeFailure(c, conn, e);
    }
  });

  app.post("/users/delete", async (c) => {
    const t = await target(c);
    if (t instanceof Response) return t;
    const { conn, body } = t;
    try {
      return await withAudit({ connection: ref(conn), purpose: "Delete a user" }, async () => {
        const current = await loadTarget(conn, body);
        if (!current) return c.json({ error: "Say which user to delete." }, 400);
        const locked = protectedReason(current);
        if (locked) return c.json({ error: locked }, 403);
        // The administrator types the user name to confirm; it must match the user on Veracode.
        if (bodyField(body, "confirm") !== current.user_name) {
          return c.json({ error: "Type the user name exactly to confirm." }, 400);
        }
        const audited = {
          reason: `delete ${current.user_name}`,
          target: { user_id: current.user_id, user_name: current.user_name },
          changes: describeDelete(current),
        };
        await withAudit(audited, () => deleteUser(conn, tokens, veracode, current.user_id));
        changed(conn, current.user_id, "deleted");
        return c.json({ deleted: current.user_name });
      });
    } catch (e) {
      return veracodeFailure(c, conn, e);
    }
  });

  app.get("/app-users", async (c) => {
    await sync(c.var.session);
    return c.json(
      c.var.session.vault.file.users.map(({ username, added_at, last_sign_in, removes_at }) => ({
        username,
        added_at,
        last_sign_in,
        removes_at,
      })),
    );
  });

  // The page to show comes in the body, so the dashboard's request URL stays fixed (CWE-918).
  const AUDIT_SIZES = [50, 100, 500];
  app.post("/audit/page", async (c) => {
    const body: unknown = await c.req.json().catch(() => null);
    const field = (key: string): unknown =>
      typeof body === "object" && body !== null && key in body
        ? Object.getOwnPropertyDescriptor(body, key)?.value
        : undefined;
    const rawPage = field("page");
    const rawSize = field("size");
    const page = typeof rawPage === "number" && rawPage >= 1 ? Math.floor(rawPage) : 1;
    const size = typeof rawSize === "number" && AUDIT_SIZES.includes(rawSize) ? rawSize : 50;
    const result = await audit.page(page, size, field("failed_only") === true);
    return c.json({ ...result, page, size });
  });

  const sweep = async () => {
    for (const session of sessions.all()) {
      try {
        await withAudit({ actor: "system", purpose: "Scheduled clean-up" }, () => sync(session));
      } catch {
        sessions.delete(session.id);
      }
    }
  };

  return { app, sweep };
};
