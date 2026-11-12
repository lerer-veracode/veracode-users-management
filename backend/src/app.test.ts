import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import { AuditLog } from "./audit/audit.js";
import { isRegion } from "./regions.js";
import type { Fetch } from "./veracode/oauth.js";
import { readVault, writeVault } from "./vault/file.js";
import { addUser, createVault, newConnection, saveData, unlock } from "./vault/vault.js";

const CHEAP = { N: 2 ** 10, r: 8, p: 1 };
const PASSWORD = "correct horse battery";
const SECRET = "client-secret-value";
const START = new Date("2026-11-09T12:00:00Z");
const MIN = 60_000;
const DAY = 86_400_000;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const veracode = (usersStatus = 200) =>
  vi.fn<Fetch>(async (input, init) => {
    const url = String(input);
    if (url.endsWith("/oauth2/token")) return json(200, { access_token: "tok", expires_in: 3600 });
    if (url.includes("/v2/users?")) {
      return json(usersStatus, {
        _embedded: { users: [{ user_id: "u1", user_name: "jdoe", email_address: "j@x.com" }] },
        page: { total_pages: 1 },
      });
    }
    if (url.endsWith("/v2/users/u1")) {
      return json(usersStatus, {
        user_id: "u1",
        user_name: "jdoe",
        email_address: "j@x.com",
        roles: [{ role_name: "extseclead", role_description: "Security Lead" }],
      });
    }
    if (url.includes("/v2/users")) return json(usersStatus, {});
    if (url.includes("/v2/roles")) {
      return json(usersStatus, { _embedded: { roles: [{ role_name: "extseclead" }] } });
    }
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    return json(404, {});
  });

let dir = "";
let vaultPath = "";
let now = START;
let sleeps: number[] = [];
let audit: AuditLog;

const setup = async (fetchFn: ReturnType<typeof veracode> = veracode()) => {
  let session = await createVault("yaakov", PASSWORD, START, CHEAP);
  session = await addUser(session, "dana", "dana long password", START, CHEAP);
  session = saveData(session, {
    connections: [
      newConnection(
        { name: "acme", region: "eu", client_id: "vrc_acme", client_secret: SECRET },
        START,
      ),
    ],
  });
  await writeVault(vaultPath, session.file);
  audit = new AuditLog(join(dir, "audit.log"), () => now);
  const { app, sweep } = createApp({
    vaultPath,
    audit,
    fetch: fetchFn,
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { app, sweep, fetchFn };
};

type App = Awaited<ReturnType<typeof setup>>["app"];

const signIn = async (app: App, username = "yaakov", password = PASSWORD) => {
  const res = await app.request("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const cookie = res.headers.get("set-cookie")?.split(";")[0] ?? "";
  return { res, cookie };
};

const get = (app: App, path: string, cookie: string, method = "GET") =>
  app.request(path, { method, headers: { Cookie: cookie } });

const post = (app: App, path: string, cookie: string, body: unknown) =>
  app.request(path, {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "app-"));
  vaultPath = join(dir, "vault.json");
  now = START;
  sleeps = [];
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("open routes", () => {
  it("reports health and regions without signing in", async () => {
    const { app } = await setup();
    expect(await (await app.request("/api/health")).json()).toEqual({ status: "ok" });
    expect(await (await app.request("/api/regions")).json()).toEqual([
      { id: "us", label: "US" },
      { id: "eu", label: "EU" },
      { id: "fed", label: "US Federal" },
    ]);
    expect(isRegion("apac")).toBe(false);
  });
});

describe("sign-in", () => {
  it("signs in with an HttpOnly, SameSite=Strict cookie and extends the app user", async () => {
    const { app } = await setup();
    now = new Date(START.getTime() + 10 * DAY);
    const { res, cookie } = await signIn(app, " Yaakov ");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ username: "yaakov", notices: [] });
    expect(res.headers.get("set-cookie")).toMatch(/HttpOnly/);
    expect(res.headers.get("set-cookie")).toMatch(/SameSite=Strict/);
    expect(await (await get(app, "/api/session", cookie)).json()).toEqual({ username: "yaakov" });

    const file = await readVault(vaultPath);
    expect(file?.users.find((u) => u.username === "yaakov")?.last_sign_in).toBe(now.toISOString());
  });

  it("refuses wrong passwords, each one waiting longer", async () => {
    const { app } = await setup();
    expect((await signIn(app, "yaakov", "wrong password")).res.status).toBe(401);
    expect((await signIn(app, "yaakov", "wrong password")).res.status).toBe(401);
    const { res } = await signIn(app);
    expect(res.status).toBe(200);
    expect(sleeps).toEqual([0, 500, 1000]);
    await signIn(app);
    expect(sleeps.at(-1)).toBe(0);
  });

  it("explains a missing vault and a bad request", async () => {
    const { app } = await setup();
    const bad = await app.request("/api/session", { method: "POST", body: "nope" });
    expect(bad.status).toBe(400);
    await rm(vaultPath);
    const { res } = await signIn(app);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "No vault yet. Run npm run connect in a terminal to create it.",
    });
  });

  it("protects every other route, and signs out", async () => {
    const { app } = await setup();
    for (const path of ["/api/session", "/api/connections", "/api/app-users"]) {
      expect((await app.request(path)).status).toBe(401);
    }
    const { cookie } = await signIn(app);
    await signIn(app, "yaakov", "wrong password");
    expect((await get(app, "/api/session", cookie, "DELETE")).status).toBe(204);
    expect((await audit.latest(3)).map((e) => [e.action, e.outcome, e.actor])).toEqual([
      ["app.sign_out", "ok", "yaakov"],
      ["app.sign_in", "failed", "yaakov"],
      ["app.sign_in", "ok", "yaakov"],
    ]);
    expect((await get(app, "/api/session", cookie)).status).toBe(401);
  });

  it("signs out after 30 idle minutes", async () => {
    const { app } = await setup();
    const { cookie } = await signIn(app);
    now = new Date(START.getTime() + 29 * MIN);
    expect((await get(app, "/api/session", cookie)).status).toBe(200);
    now = new Date(START.getTime() + 60 * MIN);
    expect((await get(app, "/api/session", cookie)).status).toBe(401);
  });
});

describe("connections", () => {
  it("lists connections without secrets, tests and switches them", async () => {
    const { app, fetchFn } = await setup();
    const { cookie } = await signIn(app);
    const res = await get(app, "/api/connections", cookie);
    const text = await res.text();
    expect(text).not.toContain(SECRET);
    const body: unknown = JSON.parse(text);
    expect(body).toMatchObject({
      notices: [],
      connections: [
        { name: "acme", region: "EU", client_id: "vrc_acme", active: true, token_expires: null },
      ],
    });
    const id = (body as { connections: { id: string }[] }).connections[0]?.id ?? "";

    const test = await post(app, "/api/connections/test", cookie, { id });
    expect(await test.json()).toEqual({
      ok: true,
      message: "Connected: the credentials can read users.",
      token_expires: new Date(START.getTime() + 3600_000).toISOString(),
    });
    expect(String(fetchFn.mock.calls[1]?.[0])).toBe(
      "https://api.veracode.eu/api/authn/v2/users?size=1",
    );
    expect(await (await post(app, "/api/connections/use", cookie, { id })).json()).toEqual({
      name: "acme",
    });
    expect((await post(app, "/api/connections/test", cookie, { id: "nope" })).status).toBe(404);
    expect((await get(app, "/api/connections/use", cookie, "POST")).status).toBe(404);

    const log = (await (await post(app, "/api/audit/page", cookie, {})).json()).entries;
    expect(log.map((e: { action: string }) => e.action)).toEqual([
      "connection.selected",
      "auth.check",
      "user.list",
      "auth.token",
      "app.sign_in",
    ]);
    expect(log[0]).toMatchObject({ actor: "yaakov", connection: { name: "acme" } });
    expect(log[1]).toMatchObject({
      actor: "yaakov",
      outcome: "ok",
      reason: "test",
      connection: { name: "acme", region: "EU", client_id: "vrc_acme" },
      detail: "Connected: the credentials can read users.",
    });
    expect(JSON.stringify(log)).not.toContain(SECRET);
  });

  it("reports a connection that can't read users", async () => {
    const { app } = await setup(veracode(403));
    const { cookie } = await signIn(app);
    const list = (await (await get(app, "/api/connections", cookie)).json()) as {
      connections: { id: string }[];
    };
    const res = await post(app, "/api/connections/test", cookie, { id: list.connections[0]?.id });
    expect(await res.json()).toMatchObject({ ok: false });
  });

  it("picks up connections added with npm run connect while signed in", async () => {
    const { app } = await setup();
    const { cookie } = await signIn(app);
    const file = await readVault(vaultPath);
    if (!file) throw new Error("vault");
    const session = await unlock(file, "dana", "dana long password", START);
    const conn = newConnection(
      { name: "beta", region: "us", client_id: "vrc_beta", client_secret: "x" },
      START,
    );
    await writeVault(
      vaultPath,
      saveData(session, { connections: [...session.data.connections, conn] }).file,
    );
    const body = (await (await get(app, "/api/connections", cookie)).json()) as {
      connections: { name: string }[];
    };
    expect(body.connections.map((c) => c.name)).toEqual(["acme", "beta"]);
  });

  it("revokes and removes a connection after 30 days", async () => {
    const { app, fetchFn } = await setup();
    now = new Date(START.getTime() + 30 * DAY - 10 * MIN);
    const { cookie } = await signIn(app);
    now = new Date(START.getTime() + 30 * DAY);
    const body = await (await get(app, "/api/connections", cookie)).json();
    expect(body).toEqual({
      notices: [
        "Removed app user dana: no sign-in for 30 days.",
        "Removed acme after 30 days and revoked it on Veracode.",
      ],
      connections: [],
    });
    expect(fetchFn.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(2);
    const log = await audit.latest(10);
    expect(log.slice(0, 5).map((e) => [e.action, e.actor, e.reason])).toEqual([
      ["connection.expired", "yaakov", "expired"],
      ["auth.revoke_client", "yaakov", "expired"],
      ["auth.revoke_tokens", "yaakov", "expired"],
      ["auth.token", "yaakov", "expired"],
      ["app_user.expired", "yaakov", undefined],
    ]);
    expect((await readVault(vaultPath))?.data).toBeDefined();
  });

  it("removes idle app users at sign-in and lists the rest", async () => {
    const { app } = await setup();
    now = new Date(START.getTime() + 30 * DAY - MIN);
    await signIn(app);
    now = new Date(START.getTime() + 31 * DAY);
    const { res, cookie } = await signIn(app);
    expect((await res.json()).notices).toEqual([
      "Removed app user dana: no sign-in for 30 days.",
      "Removed acme after 30 days and revoked it on Veracode.",
    ]);
    const users = await (await get(app, "/api/app-users", cookie)).json();
    expect(users).toEqual([
      {
        username: "yaakov",
        added_at: START.toISOString(),
        last_sign_in: now.toISOString(),
        removes_at: new Date(now.getTime() + 30 * DAY).toISOString(),
      },
    ]);
  });

  it("signs out a session whose vault disappears, and the hourly sweep does too", async () => {
    const { app, sweep } = await setup();
    const first = await signIn(app);
    const second = await signIn(app);
    await rm(vaultPath);
    const res = await get(app, "/api/connections", first.cookie);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "The vault is gone. Run npm run connect." });
    expect((await get(app, "/api/session", first.cookie)).status).toBe(401);
    await sweep();
    expect((await get(app, "/api/session", second.cookie)).status).toBe(401);
  });
});

describe("users and roles", () => {
  it("reads the real users and roles of the connection in use, and logs it", async () => {
    const { app, fetchFn } = await setup();
    const { cookie } = await signIn(app);
    const users = await (await get(app, "/api/users", cookie)).json();
    expect(users.connection).toEqual({ id: expect.any(String), name: "acme", region: "EU" });
    expect(users.users).toMatchObject([
      {
        user_id: "u1",
        user_name: "jdoe",
        user_type: "UI",
        roles: [{ role_name: "extseclead", role_description: "Security Lead" }],
      },
    ]);
    const roles = await (await get(app, "/api/roles", cookie)).json();
    expect(roles.connection).toMatchObject({ name: "acme" });
    expect(roles.roles).toMatchObject([
      { role_name: "extseclead", role_description: "extseclead" },
    ]);
    const log = await audit.latest(10);
    const reads = ["user.list", "user.read", "role.list"];
    // Newest first. The roles are read once, to tell API roles, and kept for /api/roles. This
    // stub ignores the list's options (no roles in it), so each user's record is read.
    expect(log.filter((e) => reads.includes(e.action))).toEqual([
      expect.objectContaining({ action: "user.read", actor: "yaakov", outcome: "ok" }),
      expect.objectContaining({ action: "user.list", actor: "yaakov", outcome: "ok" }),
      expect.objectContaining({ action: "user.list", actor: "yaakov", outcome: "ok" }),
      expect.objectContaining({
        action: "role.list",
        actor: "yaakov",
        connection: expect.objectContaining({ name: "acme" }),
      }),
    ]);

    // Kept for 15 minutes, unless refreshed. A read here is the list with its options, the plain
    // list (this stub ignores the options), and the user's record.
    const calls = fetchFn.mock.calls.length;
    await get(app, "/api/users", cookie);
    expect(fetchFn.mock.calls.length).toBe(calls);
    await get(app, "/api/users?refresh=1", cookie);
    expect(fetchFn.mock.calls.length).toBe(calls + 3);
    now = new Date(START.getTime() + 14 * MIN);
    await get(app, "/api/users", cookie);
    expect(fetchFn.mock.calls.length).toBe(calls + 3);
    now = new Date(START.getTime() + 16 * MIN);
    await get(app, "/api/users", cookie);
    expect(fetchFn.mock.calls.length).toBe(calls + 6);
  });

  it("explains a refused connection, other errors, and no connection", async () => {
    let { app } = await setup(veracode(403));
    let { cookie } = await signIn(app);
    let res = await get(app, "/api/users", cookie);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: "The acme connection is not allowed to do this (403). It needs the Admin API role.",
    });

    ({ app } = await setup(veracode(500)));
    ({ cookie } = await signIn(app));
    res = await get(app, "/api/roles", cookie);
    expect(res.status).toBe(502);
    expect((await res.json()).error).toContain("Reading roles failed (500)");

    ({ app } = await setup());
    now = new Date(START.getTime() + 30 * 86_400_000 - 60_000);
    ({ cookie } = await signIn(app));
    now = new Date(START.getTime() + 30 * 86_400_000);
    res = await get(app, "/api/users", cookie);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "No connection in use. Add one with npm run connect.",
    });
  });

  it("explains when Veracode can't be reached", async () => {
    const broken = vi.fn<Fetch>(async (input) =>
      String(input).endsWith("/oauth2/token")
        ? json(200, { access_token: "tok", expires_in: 3600 })
        : Promise.reject(new TypeError("network down")),
    );
    const { app } = await setup(broken);
    const { cookie } = await signIn(app);
    const res = await get(app, "/api/users", cookie);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "Could not reach Veracode: network down" });
  });
});

describe("choosing the connection", () => {
  const twoConnections = async () => {
    const { app } = await setup();
    const file = await readVault(vaultPath);
    if (!file) throw new Error("vault");
    const session = await unlock(file, "yaakov", PASSWORD, START);
    const beta = newConnection(
      { name: "beta", region: "us", client_id: "vrc_beta", client_secret: "x" },
      new Date(START.getTime() + 10 * DAY),
    );
    await writeVault(
      vaultPath,
      saveData(session, { ...session.data, connections: [...session.data.connections, beta] }).file,
    );
    return { app, betaId: beta.id };
  };
  const activeName = async (app: App, cookie: string) => {
    const body = (await (await get(app, "/api/connections", cookie)).json()) as {
      connections: { name: string; active: boolean }[];
    };
    return body.connections.find((c) => c.active)?.name ?? null;
  };

  it("uses the only connection without asking", async () => {
    const { app } = await setup();
    const { cookie } = await signIn(app);
    expect(await activeName(app, cookie)).toBe("acme");
    expect((await get(app, "/api/users", cookie)).status).toBe(200);
  });

  it("asks which one when there are several, and remembers the choice per app user", async () => {
    const { app, betaId } = await twoConnections();
    let { cookie } = await signIn(app);
    expect(await activeName(app, cookie)).toBeNull();
    const res = await get(app, "/api/users", cookie);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "Choose a connection first." });

    await post(app, "/api/connections/use", cookie, { id: betaId });
    expect((await (await get(app, "/api/users", cookie)).json()).connection.name).toBe("beta");

    // Remembered for yaakov after signing in again, but not for dana.
    ({ cookie } = await signIn(app));
    expect(await activeName(app, cookie)).toBe("beta");
    const dana = await signIn(app, "dana", "dana long password");
    expect(await activeName(app, dana.cookie)).toBeNull();

    // Stored in the encrypted part of the vault, not the readable header.
    const raw = await readFile(vaultPath, "utf8");
    expect(raw).not.toContain(betaId);
    const file = await readVault(vaultPath);
    if (!file) throw new Error("vault");
    expect((await unlock(file, "yaakov", PASSWORD, START)).data.last_used).toEqual({
      yaakov: betaId,
    });
  });

  it("forgets a last-used connection once it expires", async () => {
    const { app, betaId } = await twoConnections();
    const first = await signIn(app);
    await post(app, "/api/connections/use", first.cookie, { id: betaId });
    now = new Date(START.getTime() + 20 * DAY);
    await signIn(app);
    now = new Date(START.getTime() + 40 * DAY - MIN);
    const { cookie } = await signIn(app);
    expect(await activeName(app, cookie)).toBe("beta");
    now = new Date(START.getTime() + 40 * DAY);
    expect(await activeName(app, cookie)).toBeNull();
    const file = await readVault(vaultPath);
    if (!file) throw new Error("vault");
    expect((await unlock(file, "yaakov", PASSWORD, now)).data.last_used).toEqual({});
  });
});

describe("changing users", () => {
  type Rec = Record<string, unknown>;
  // A stubbed organization: an ordinary user, an administrator and an API account.
  const org = () => {
    const users: Rec[] = [
      {
        user_id: "u1",
        user_name: "jdoe",
        first_name: "Jane",
        last_name: "Doe",
        email_address: "j@x.com",
        roles: [
          { role_name: "extseclead", role_description: "Security Lead" },
          { role_name: "extsubmitanyscan", role_description: "Any Scan" },
        ],
        teams: [{ team_id: "t1", team_name: "Blue" }],
      },
      {
        user_id: "u2",
        user_name: "boss",
        first_name: "Big",
        last_name: "Boss",
        email_address: "boss@x.com",
        roles: [{ role_name: "extadmin", role_description: "Administrator" }],
      },
      {
        user_id: "u3",
        user_name: "api_ci",
        first_name: "CI",
        last_name: "Bot",
        email_address: "ci@x.com",
        roles: [{ role_name: "uploadapi", role_description: "Upload API", is_api: true }],
      },
    ];
    const roles = [
      { role_name: "extseclead", role_description: "Security Lead" },
      { role_name: "extreviewer", role_description: "Reviewer" },
      { role_name: "extsubmitter", role_description: "Submitter" },
      { role_name: "extcreator", role_description: "Creator" },
      { role_name: "extsubmitanyscan", role_description: "Any Scan" },
      { role_name: "extsubmitstaticscan", role_description: "Static Scan" },
      { role_name: "extsubmitcontainerscan", role_description: "Container Scan" },
      { role_name: "teamAdmin", role_description: "Team Admin" },
      { role_name: "extadmin", role_description: "Administrator" },
      { role_name: "uploadapi", role_description: "Upload API", is_api: true },
    ];
    const teams = [
      { team_id: "t2", team_name: "Red" },
      { team_id: "t1", team_name: "Blue" },
    ];
    const fetchFn = vi.fn<Fetch>(async (input, init) => {
      const url = new URL(String(input));
      const path = url.pathname.replace("/api/authn", "");
      const method = init?.method ?? "GET";
      if (path === "/v2/oauth2/token") return json(200, { access_token: "tok", expires_in: 3600 });
      if (path === "/v2/roles")
        return json(200, { _embedded: { roles }, page: { total_pages: 1 } });
      if (path === "/v2/teams")
        return json(200, { _embedded: { teams }, page: { total_pages: 1 } });
      if (path === "/v2/users" && method === "GET") {
        return json(200, { _embedded: { users }, page: { total_pages: 1 } });
      }
      if (path === "/v2/users" && method === "POST") {
        const body = JSON.parse(String(init?.body)) as Rec;
        // A user name can be used only once; an email address can be shared.
        if (users.some((u) => u.user_name === body.user_name)) {
          return json(400, { message: "User already exists" });
        }
        const user = { ...body, user_id: `u${users.length + 1}` };
        users.push(user);
        return json(200, user);
      }
      const i = users.findIndex((u) => path === `/v2/users/${String(u.user_id)}`);
      if (i < 0) return json(404, { message: "No such user" });
      if (method === "GET") return json(200, users[i]);
      if (method === "PUT") {
        users[i] = { ...users[i], ...(JSON.parse(String(init?.body)) as Rec) };
        return json(200, users[i]);
      }
      if (method === "DELETE") {
        users.splice(i, 1);
        return new Response(null, { status: 204 });
      }
      return json(405, {});
    });
    return { fetchFn, users, teams };
  };

  const ready = async () => {
    const stub = org();
    const { app } = await setup(stub.fetchFn);
    const { cookie } = await signIn(app);
    const list = (await (await get(app, "/api/connections", cookie)).json()) as {
      connections: { id: string }[];
    };
    const connection_id = list.connections[0]?.id ?? "";
    const writes = () =>
      stub.fetchFn.mock.calls
        .filter(([, init]) => ["POST", "PUT", "DELETE"].includes(init?.method ?? "GET"))
        .filter(([url]) => !String(url).endsWith("/oauth2/token"))
        .map(
          ([url, init]) =>
            `${init?.method} ${new URL(String(url)).pathname}${new URL(String(url)).search}`,
        );
    return { app, cookie, connection_id, writes, ...stub };
  };

  it("marks administrators and API accounts as locked, and which roles may be given", async () => {
    const { app, cookie } = await ready();
    const users = (await (await get(app, "/api/users", cookie)).json()).users as Rec[];
    expect(users.map((u) => [u.user_name, u.locked])).toEqual([
      ["jdoe", null],
      [
        "boss",
        "boss has the Administrator role. This app never changes or deletes administrators.",
      ],
      ["api_ci", "api_ci is an API account. This app changes only UI users."],
    ]);
    const roles = (await (await get(app, "/api/roles", cookie)).json()).roles as Rec[];
    expect(roles.map((r) => [r.role_name, r.assignable, r.kind])).toEqual([
      ["extseclead", true, "needs_scan_type"],
      ["extreviewer", true, "plain"],
      ["extsubmitter", true, "needs_scan_type"],
      ["extcreator", true, "needs_scan_type"],
      ["extsubmitanyscan", true, "any_scan"],
      ["extsubmitstaticscan", true, "scan_type"],
      ["extsubmitcontainerscan", true, "scan_type"],
      ["teamAdmin", true, "team_admin"],
      ["extadmin", false, "plain"],
      ["uploadapi", false, "plain"],
    ]);
    const teams = (await (await get(app, "/api/teams", cookie)).json()).teams as Rec[];
    expect(teams).toEqual([
      { team_id: "t1", team_name: "Blue" },
      { team_id: "t2", team_name: "Red" },
    ]);
    expect(users[0]?.teams).toEqual([{ team_id: "t1", team_name: "Blue", relationship: "MEMBER" }]);
  });

  it("needs a scan type for Security Lead, Creator and Submitter, and teams for Team Admin", async () => {
    const { app, cookie, connection_id, fetchFn, writes } = await ready();
    const base = { email_address: "n@x.com", first_name: "N", last_name: "P" };
    const tries: [unknown, string][] = [
      [
        { ...base, roles: ["extsubmitter"] },
        "Security Lead, Creator and Submitter need a scan type: All scan types, or at least one specific type.",
      ],
      [
        { ...base, roles: ["extsubmitter", "extsubmitanyscan", "extsubmitstaticscan"] },
        "Choose All scan types or specific scan types, not both.",
      ],
      [{ ...base, roles: ["teamAdmin"] }, "Team Admin needs at least one team to manage."],
      [
        { ...base, roles: ["teamAdmin"], teams: [{ team_id: "t1", relationship: "MEMBER" }] },
        "Team Admin needs at least one team to manage.",
      ],
      [
        { ...base, roles: ["extreviewer"], teams: [{ team_id: "t1", relationship: "ADMIN" }] },
        "Only a Team Admin can manage a team.",
      ],
      [
        { ...base, roles: ["extreviewer"], teams: [{ team_id: "nope" }] },
        "nope isn't a team in this organization.",
      ],
      [
        { ...base, roles: ["extreviewer"], teams: [{ team_id: "t1", relationship: "OWNER" }] },
        "Each team needs a team_id and a relationship, ADMIN or MEMBER.",
      ],
      [
        { ...base, roles: ["extreviewer"], teams: [{ team_id: "t1" }, { team_id: "t1" }] },
        "Each team can be listed only once.",
      ],
      [{ ...base, roles: ["extreviewer"], teams: "t1" }, "Teams must be a list."],
      [
        { ...base, roles: ["extsubmitter", "extsubmitanyscan"] },
        "This combination of roles requires the user to be in at least one team: choose one under Member of teams.",
      ],
      [
        { ...base, roles: ["extcreator", "extsubmitanyscan"] },
        "This combination of roles requires the user to be in at least one team: choose one under Member of teams.",
      ],
    ];
    for (const [user, error] of tries) {
      const res = await post(app, "/api/users/create", cookie, { connection_id, user });
      expect([res.status, (await res.json()).error]).toEqual([400, error]);
    }
    expect(writes()).toEqual([]);

    const user = {
      ...base,
      roles: ["extsubmitter", "extsubmitstaticscan", "teamAdmin"],
      pin_required: true,
      teams: [
        { team_id: "t1", relationship: "ADMIN" },
        { team_id: "t2", relationship: "MEMBER" },
      ],
    };
    const res = await post(app, "/api/users/create", cookie, { connection_id, user });
    expect(res.status).toBe(200);
    const sent = fetchFn.mock.calls.find(
      ([url, i]) => i?.method === "POST" && String(url).endsWith("/v2/users"),
    );
    expect(JSON.parse(String(sent?.[1]?.body))).toMatchObject({
      pin_required: true,
      roles: [
        { role_name: "extsubmitter" },
        { role_name: "extsubmitstaticscan" },
        { role_name: "teamAdmin" },
      ],
      teams: [
        { team_id: "t1", relationship: "ADMIN" },
        { team_id: "t2", relationship: "MEMBER" },
      ],
    });

    // Changing only teams is checked against the user's roles: jdoe isn't a Team Admin.
    const manage = await post(app, "/api/users/update", cookie, {
      connection_id,
      id: "u1",
      changes: { teams: [{ team_id: "t1", relationship: "ADMIN" }] },
    });
    expect(await manage.json()).toEqual({ error: "Only a Team Admin can manage a team." });
    const dropScan = await post(app, "/api/users/update", cookie, {
      connection_id,
      id: "u1",
      changes: { roles: ["extseclead"] },
    });
    expect((await dropScan.json()).error).toMatch(/need a scan type/);
    const join = await post(app, "/api/users/update", cookie, {
      connection_id,
      id: "u1",
      changes: {
        teams: [
          { team_id: "t1", relationship: "MEMBER" },
          { team_id: "t2", relationship: "MEMBER" },
        ],
      },
    });
    expect(join.status).toBe(200);
    const put = fetchFn.mock.calls.find(([, i]) => i?.method === "PUT");
    expect(JSON.parse(String(put?.[1]?.body))).toEqual({
      teams: [
        { team_id: "t1", relationship: "MEMBER" },
        { team_id: "t2", relationship: "MEMBER" },
      ],
    });
  });

  it("creates a UI user with the chosen roles, and logs it", async () => {
    const { app, cookie, connection_id, fetchFn, writes } = await ready();
    const user = {
      email_address: "new@x.com",
      first_name: "New",
      last_name: "Person",
      roles: ["extreviewer"],
    };
    const res = await post(app, "/api/users/create", cookie, { connection_id, user });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      user_name: "new@x.com",
      user: { user_id: "u4", user_name: "new@x.com", locked: null },
    });
    expect(writes()).toEqual(["POST /api/authn/v2/users"]);
    const [, init] =
      fetchFn.mock.calls.find(
        ([, i]) =>
          i?.method === "POST" && i.body !== undefined && !String(i.body).includes("grant_type"),
      ) ?? [];
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer tok");
    expect(JSON.parse(String(init?.body))).toEqual({
      user_name: "new@x.com",
      email_address: "new@x.com",
      first_name: "New",
      last_name: "Person",
      active: true,
      login_enabled: true,
      pin_required: false,
      roles: [{ role_name: "extreviewer" }],
      teams: [],
    });
    const created = (await audit.latest(5)).find((e) => e.action === "user.create");
    expect(created).toMatchObject({
      actor: "yaakov",
      outcome: "ok",
      reason: "create new@x.com",
      connection: { name: "acme" },
    });
    // The entry keeps who was created and every field set, never a token or secret.
    expect(created?.target).toEqual({ user_name: "new@x.com" });
    expect(created?.changes).toEqual([
      { field: "User name", from: null, to: "new@x.com" },
      { field: "First name", from: null, to: "New" },
      { field: "Last name", from: null, to: "Person" },
      { field: "Email", from: null, to: "new@x.com" },
      { field: "Status", from: null, to: "Active" },
      { field: "Login", from: null, to: "Enabled" },
      { field: "MFA", from: null, to: "Not required" },
      { field: "Roles", from: null, to: "Reviewer" },
      { field: "Scan types", from: null, to: "None" },
      { field: "Member of teams", from: null, to: "None" },
      { field: "Manages teams", from: null, to: "None" },
    ]);
    // Only the create call itself carries the change, not the reads or the token around it.
    const others = (await audit.latest(20)).filter((e) => e.action !== "user.create");
    expect(others.some((e) => e.changes !== undefined || e.target !== undefined)).toBe(false);
    expect(JSON.stringify(await audit.latest(20))).not.toContain("Bearer");
  });

  it("never gives the Administrator role or an API role, and checks the details", async () => {
    const { app, cookie, connection_id, writes } = await ready();
    const base = { email_address: "n@x.com", first_name: "N", last_name: "P" };
    const tries: [unknown, string][] = [
      [{ ...base, roles: ["extadmin"] }, "This app never gives the Administrator role."],
      [
        { ...base, roles: ["extreviewer", "EXTADMIN"] },
        "This app never gives the Administrator role.",
      ],
      [{ ...base, roles: ["uploadapi"] }, "uploadapi is an API role; this app adds UI users only."],
      [{ ...base, roles: ["nope"] }, "nope isn't a role in this organization."],
      [{ ...base, roles: [] }, "Choose at least one role."],
      [{ ...base, roles: "extreviewer" }, "Roles must be a list of role names."],
      [
        { ...base, email_address: "not an email", roles: ["extreviewer"] },
        "Enter a valid email address.",
      ],
      [{ ...base, first_name: " ", roles: ["extreviewer"] }, "Enter the first name."],
      [{ ...base, last_name: undefined, roles: ["extreviewer"] }, "Enter the last name."],
      [null, "Send the user's details."],
      [
        { ...base, user_name: " ", roles: ["extreviewer"] },
        "Enter the user name, or use the email address.",
      ],
      [
        { ...base, user_name: "two words", roles: ["extreviewer"] },
        "A user name can't contain spaces or be over 256 characters.",
      ],
    ];
    for (const [user, error] of tries) {
      const res = await post(app, "/api/users/create", cookie, { connection_id, user });
      expect([res.status, (await res.json()).error]).toEqual([400, error]);
    }
    expect(writes()).toEqual([]);
  });

  it("shares a users read already under way, as when Refresh is clicked during a load", async () => {
    const { app, cookie, fetchFn } = await ready();
    const [a, b] = await Promise.all([
      get(app, "/api/users", cookie),
      get(app, "/api/users?refresh=1", cookie),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect((await b.json()).users).toEqual((await a.json()).users);
    const lists = fetchFn.mock.calls.filter(([u]) => String(u).includes("/v2/users?detailed=true"));
    expect(lists).toHaveLength(1);
  });

  it("uses Veracode's save reply when it holds the whole user, and reads the user when not", async () => {
    const { app, cookie, connection_id, fetchFn } = await ready();
    await get(app, "/api/users", cookie);
    const userReads = () =>
      fetchFn.mock.calls.filter(
        ([url, init]) => (init?.method ?? "GET") === "GET" && String(url).includes("/v2/users/u1"),
      ).length;
    const change = (last_name: string) =>
      post(app, "/api/users/update", cookie, { connection_id, id: "u1", changes: { last_name } });

    // The reply holds the user: only the safety check reads them.
    let before = userReads();
    let res = await change("One");
    expect((await res.json()).user).toMatchObject({ last_name: "One" });
    expect(userReads() - before).toBe(1);

    // An empty reply: the saved user is read too.
    const answer = fetchFn.getMockImplementation();
    if (!answer) throw new Error("no stub");
    fetchFn.mockImplementation(async (input, init) => {
      const res = await answer(input, init);
      return init?.method === "PUT" ? new Response(null, { status: 204 }) : res;
    });
    before = userReads();
    res = await change("Two");
    expect((await res.json()).user).toMatchObject({ last_name: "Two" });
    expect(userReads() - before).toBe(2);

    // Each call in the log says why, how long it took and what came back.
    const entries = await audit.latest(10);
    const read = entries.find(
      (e) => e.purpose === "Change a user: read the saved user (the save reply didn't hold it)",
    );
    expect(read).toMatchObject({ action: "user.read", result: "1 user, with roles" });
    expect(typeof read?.ms).toBe("number");
    expect(entries.find((e) => e.action === "user.update")).toMatchObject({
      purpose: "Change a user: save",
      result: "no content",
      reason: "update jdoe: last_name",
    });
    expect(
      entries.find((e) => e.purpose === "Change a user: safety check, read the user")?.action,
    ).toBe("user.read");
  });

  it("patches the kept users after a change, with no new read of the list (PLAN_CACHE phase 4)", async () => {
    const { app, cookie, connection_id, fetchFn, users } = await ready();
    const u1 = users[0] as Rec;
    u1.last_login = "2026-11-01T10:00:00Z";
    const list = async () => (await (await get(app, "/api/users", cookie)).json()).users as Rec[];
    expect((await list()).find((u) => u.user_id === "u1")?.last_login).toBe("2026-11-01T10:00:00Z");
    // A user's own record has no last login (REALITY 39).
    delete u1.last_login;
    const count = () => fetchFn.mock.calls.length;

    // Opening a user just after the list was read: the kept copy, no call.
    let before = count();
    const kept = await post(app, "/api/users/read", cookie, { connection_id, id: "u1" });
    expect((await kept.json()).user).toMatchObject({ user_id: "u1", locked: null });
    expect(count()).toBe(before);

    // A minute later, reading one user afresh: one call, and the list is patched.
    now = new Date(now.getTime() + 2 * MIN);
    before = count();
    const read = await post(app, "/api/users/read", cookie, { connection_id, id: "u1" });
    expect((await read.json()).user).toMatchObject({ user_id: "u1", locked: null });
    expect(count() - before).toBe(1);

    const update = await post(app, "/api/users/update", cookie, {
      connection_id,
      id: "u1",
      changes: { last_name: "Changed" },
    });
    expect(update.status).toBe(200);
    before = count();
    const after = (await list()).find((u) => u.user_id === "u1");
    expect(count()).toBe(before);
    expect(after).toMatchObject({ last_name: "Changed", last_login: "2026-11-01T10:00:00Z" });

    const created = await post(app, "/api/users/create", cookie, {
      connection_id,
      user: { email_address: "n@x.com", first_name: "N", last_name: "P", roles: ["extreviewer"] },
    });
    expect(created.status).toBe(200);
    before = count();
    expect((await list()).map((u) => u.user_name)).toContain("n@x.com");
    expect(count()).toBe(before);

    const del = await post(app, "/api/users/delete", cookie, {
      connection_id,
      id: "u1",
      confirm: "jdoe",
    });
    expect(del.status).toBe(200);
    before = count();
    expect((await list()).map((u) => u.user_id)).not.toContain("u1");
    expect(count()).toBe(before);
  });

  it("keeps roles and teams per connection until a refresh or a new sign-in (PLAN_CACHE phase 3)", async () => {
    const { app, cookie, connection_id, fetchFn, teams } = await ready();
    const reads = (path: string) =>
      fetchFn.mock.calls.filter(([u]) => new URL(String(u)).pathname.endsWith(path)).length;
    // Opening the form twice and making two changes.
    for (let i = 0; i < 2; i++) {
      await get(app, "/api/roles", cookie);
      await get(app, "/api/teams", cookie);
    }
    for (const last_name of ["One", "Two"]) {
      const res = await post(app, "/api/users/update", cookie, {
        connection_id,
        id: "u1",
        changes: { last_name },
      });
      expect(res.status).toBe(200);
    }
    const created = await post(app, "/api/users/create", cookie, {
      connection_id,
      user: { email_address: "k@x.com", first_name: "K", last_name: "P", roles: ["extreviewer"] },
    });
    expect(created.status).toBe(200);
    expect([reads("/v2/roles"), reads("/v2/teams")]).toEqual([1, 1]);

    // A refresh reads again.
    await get(app, "/api/roles?refresh=1", cookie);
    await get(app, "/api/teams?refresh=1", cookie);
    expect([reads("/v2/roles"), reads("/v2/teams")]).toEqual([2, 2]);

    // A team made on the Platform since: the change reads the teams once more, then succeeds.
    teams.push({ team_id: "t3", team_name: "Green" });
    const join = await post(app, "/api/users/update", cookie, {
      connection_id,
      id: "u1",
      changes: { teams: [{ team_id: "t3", relationship: "MEMBER" }] },
    });
    expect(join.status).toBe(200);
    expect(reads("/v2/teams")).toBe(3);
    // A team that doesn't exist: read once more, then refused.
    const nope = await post(app, "/api/users/update", cookie, {
      connection_id,
      id: "u1",
      changes: { teams: [{ team_id: "nope", relationship: "MEMBER" }] },
    });
    expect(await nope.json()).toEqual({ error: "nope isn't a team in this organization." });
    expect(reads("/v2/teams")).toBe(4);
    expect(reads("/v2/roles")).toBe(2);

    // A new sign-in reads them afresh.
    const again = await signIn(app);
    await get(app, "/api/roles", again.cookie);
    await get(app, "/api/teams", again.cookie);
    expect([reads("/v2/roles"), reads("/v2/teams")]).toEqual([3, 5]);
  });

  it("lets a Security Lead have no team, with or without Creator and Submitter (REALITY 37)", async () => {
    const { app, cookie, connection_id, writes } = await ready();
    const base = { first_name: "L", last_name: "P" };
    for (const [email_address, roles] of [
      ["lead@x.com", ["extseclead", "extsubmitanyscan"]],
      ["all@x.com", ["extseclead", "extcreator", "extsubmitter", "extsubmitanyscan"]],
    ] as const) {
      const user = { ...base, email_address, roles };
      const res = await post(app, "/api/users/create", cookie, { connection_id, user });
      expect(res.status).toBe(200);
    }
    expect(writes()).toEqual(["POST /api/authn/v2/users", "POST /api/authn/v2/users"]);
  });

  it("reads a managed team as Veracode returns it, and keeps it on an edit (REALITY 38)", async () => {
    const { app, cookie, connection_id, fetchFn, users } = await ready();
    users.push({
      user_id: "u9",
      user_name: "lead",
      first_name: "Team",
      last_name: "Lead",
      email_address: "lead@x.com",
      roles: [{ role_name: "teamAdmin", role_description: "Team Admin" }],
      teams: [
        {
          team_id: "t1",
          team_name: "Blue",
          relationship: { name: "ADMIN", display_name: "Team Admin" },
        },
      ],
    });
    const listed = (await (await get(app, "/api/users", cookie)).json()).users as Rec[];
    expect(listed.find((u) => u.user_id === "u9")?.teams).toEqual([
      { team_id: "t1", team_name: "Blue", relationship: "ADMIN" },
    ]);
    // Sending the same managed team again is no change, so the relationship was read right.
    const same = await post(app, "/api/users/update", cookie, {
      connection_id,
      id: "u9",
      changes: { roles: ["teamAdmin"], teams: [{ team_id: "t1", relationship: "ADMIN" }] },
    });
    expect(await same.json()).toEqual({ error: "Nothing to change." });
    // Joining Red Team: Blue Team stays managed.
    const res = await post(app, "/api/users/update", cookie, {
      connection_id,
      id: "u9",
      changes: {
        teams: [
          { team_id: "t1", relationship: "ADMIN" },
          { team_id: "t2", relationship: "MEMBER" },
        ],
      },
    });
    expect(res.status).toBe(200);
    const put = fetchFn.mock.calls.find(([, i]) => i?.method === "PUT");
    expect(JSON.parse(String(put?.[1]?.body))).toEqual({
      teams: [
        { team_id: "t1", relationship: "ADMIN" },
        { team_id: "t2", relationship: "MEMBER" },
      ],
    });
  });

  it("refuses an edit that leaves Creator or Submitter with no team, before Veracode (REALITY 37)", async () => {
    const { app, cookie, connection_id, writes } = await ready();
    const update = async (changes: Rec) =>
      post(app, "/api/users/update", cookie, { connection_id, id: "u1", changes });
    const message =
      "This combination of roles requires the user to be in at least one team: choose one under Member of teams.";
    // jdoe is a Security Lead in team Blue.
    for (const changes of [
      // Swapping Security Lead for Submitter, with no team.
      { roles: ["extsubmitter", "extsubmitanyscan"], teams: [] },
      { roles: ["extcreator", "extsubmitanyscan"], teams: [] },
    ]) {
      const res = await update(changes);
      expect([res.status, (await res.json()).error]).toEqual([400, message]);
    }
    expect(writes()).toEqual([]);
    // Still a Security Lead: leaving every team, then adding Submitter, is allowed.
    expect((await update({ teams: [] })).status).toBe(200);
    expect(
      (await update({ roles: ["extseclead", "extsubmitter", "extsubmitanyscan"] })).status,
    ).toBe(200);
    // Then dropping Security Lead, with no team left, is refused.
    const drop = await update({ roles: ["extsubmitter", "extsubmitanyscan"] });
    expect((await drop.json()).error).toBe(message);
    // With a team, it's fine.
    const withTeam = await update({
      roles: ["extsubmitter", "extsubmitanyscan"],
      teams: [{ team_id: "t2", relationship: "MEMBER" }],
    });
    expect(withTeam.status).toBe(200);
    expect(writes()).toEqual([
      "PUT /api/authn/v2/users/u1?partial=true",
      "PUT /api/authn/v2/users/u1?partial=true",
      "PUT /api/authn/v2/users/u1?partial=true",
    ]);
  });

  it("creates a user with a user name other than the email address", async () => {
    const { app, cookie, connection_id, fetchFn } = await ready();
    const user = {
      user_name: "n.person",
      // jdoe's email: several users may share one.
      email_address: "j@x.com",
      first_name: "N",
      last_name: "P",
      roles: ["extreviewer"],
    };
    const res = await post(app, "/api/users/create", cookie, { connection_id, user });
    expect(await res.json()).toMatchObject({ user_name: "n.person" });
    const sent = fetchFn.mock.calls.find(
      ([url, i]) => i?.method === "POST" && String(url).endsWith("/v2/users"),
    );
    expect(JSON.parse(String(sent?.[1]?.body))).toMatchObject({
      user_name: "n.person",
      // jdoe's email: several users may share one.
      email_address: "j@x.com",
    });
    const entry = (await audit.latest(5)).find((e) => e.action === "user.create");
    expect(entry?.target).toEqual({ user_name: "n.person" });
    expect(entry?.changes?.slice(0, 1)).toEqual([
      { field: "User name", from: null, to: "n.person" },
    ]);
  });

  it("logs Veracode's reason when it refuses a change", async () => {
    const { app, cookie, connection_id } = await ready();
    const user = {
      user_name: "jdoe",
      email_address: "j@x.com",
      first_name: "Jane",
      last_name: "Again",
      roles: ["extreviewer"],
    };
    const res = await post(app, "/api/users/create", cookie, { connection_id, user });
    expect([res.status, (await res.json()).error]).toEqual([
      502,
      "Creating the user failed (400): User already exists",
    ]);
    expect((await audit.latest(5)).find((e) => e.action === "user.create")).toMatchObject({
      outcome: "failed",
      status: 400,
      detail: "Veracode: User already exists",
      target: { user_name: "jdoe" },
    });
  });

  it("refuses a change for a connection other than the one in use", async () => {
    const { app, cookie, writes } = await ready();
    for (const path of ["/api/users/create", "/api/users/update", "/api/users/delete"]) {
      const res = await post(app, path, cookie, { connection_id: "other", id: "u1" });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: "The connection changed. Refresh and try again." });
    }
    expect(writes()).toEqual([]);
  });

  it("changes only what differs, with a partial update, and logs which fields", async () => {
    const { app, cookie, connection_id, fetchFn, writes } = await ready();
    const changes = {
      first_name: "Jane",
      last_name: "Smith",
      email_address: "j@x.com",
      roles: ["extseclead", "extsubmitanyscan", "extreviewer"],
      active: false,
    };
    const res = await post(app, "/api/users/update", cookie, { connection_id, id: "u1", changes });
    expect(res.status).toBe(200);
    expect((await res.json()).user).toMatchObject({ user_id: "u1", last_name: "Smith" });
    expect(writes()).toEqual(["PUT /api/authn/v2/users/u1?partial=true"]);
    const put = fetchFn.mock.calls.find(([, i]) => i?.method === "PUT");
    expect(JSON.parse(String(put?.[1]?.body))).toEqual({
      last_name: "Smith",
      active: false,
      roles: [
        { role_name: "extseclead" },
        { role_name: "extsubmitanyscan" },
        { role_name: "extreviewer" },
      ],
    });
    expect((await audit.latest(10)).find((e) => e.action === "user.update")).toMatchObject({
      outcome: "ok",
      reason: "update jdoe: last_name, active, roles",
      target: { user_id: "u1", user_name: "jdoe" },
      changes: [
        { field: "Last name", from: "Doe", to: "Smith" },
        { field: "Status", from: "Active", to: "Inactive" },
        { field: "Roles", from: "Security Lead", to: "Reviewer, Security Lead" },
      ],
    });

    // Login and MFA are changed like any other field.
    const login = await post(app, "/api/users/update", cookie, {
      connection_id,
      id: "u1",
      changes: { login_enabled: false, pin_required: true },
    });
    expect(login.status).toBe(200);
    const puts = fetchFn.mock.calls.filter(([, i]) => i?.method === "PUT");
    expect(JSON.parse(String(puts.at(-1)?.[1]?.body))).toEqual({
      login_enabled: false,
      pin_required: true,
    });
    expect((await audit.latest(10)).find((e) => e.action === "user.update")).toMatchObject({
      reason: "update jdoe: login_enabled, pin_required",
      changes: [
        { field: "Login", from: "Enabled", to: "Disabled" },
        { field: "MFA", from: "Not required", to: "Required" },
      ],
    });
    const bad = await post(app, "/api/users/update", cookie, {
      connection_id,
      id: "u1",
      changes: { login_enabled: "no" },
    });
    expect((await bad.json()).error).toBe("Login enabled must be true or false.");

    const same = await post(app, "/api/users/update", cookie, {
      connection_id,
      id: "u1",
      changes: { last_name: "Smith" },
    });
    expect(await same.json()).toEqual({ error: "Nothing to change." });
  });

  it("never changes or deletes an administrator or an API account, nor makes anyone admin", async () => {
    const { app, cookie, connection_id, writes } = await ready();
    for (const [id, message] of [
      ["u2", "boss has the Administrator role. This app never changes or deletes administrators."],
      ["u3", "api_ci is an API account. This app changes only UI users."],
    ]) {
      const upd = await post(app, "/api/users/update", cookie, {
        connection_id,
        id,
        changes: { last_name: "X" },
      });
      expect([upd.status, (await upd.json()).error]).toEqual([403, message]);
      const del = await post(app, "/api/users/delete", cookie, {
        connection_id,
        id,
        confirm: id === "u2" ? "boss" : "api_ci",
      });
      expect([del.status, (await del.json()).error]).toEqual([403, message]);
    }
    const promote = await post(app, "/api/users/update", cookie, {
      connection_id,
      id: "u1",
      changes: { roles: ["extseclead", "extsubmitanyscan", "extadmin"] },
    });
    expect([promote.status, (await promote.json()).error]).toEqual([
      400,
      "This app never gives the Administrator role.",
    ]);
    const bad = await post(app, "/api/users/update", cookie, { connection_id, changes: {} });
    expect((await bad.json()).error).toBe("Say which user to change.");
    expect(writes()).toEqual([]);
  });

  it("deletes a user only when the name typed matches, and logs it", async () => {
    const { app, cookie, connection_id, writes, users } = await ready();
    const wrong = await post(app, "/api/users/delete", cookie, {
      connection_id,
      id: "u1",
      confirm: "jdo",
    });
    expect([wrong.status, (await wrong.json()).error]).toEqual([
      400,
      "Type the user name exactly to confirm.",
    ]);
    expect(writes()).toEqual([]);
    const res = await post(app, "/api/users/delete", cookie, {
      connection_id,
      id: "u1",
      confirm: "jdoe",
    });
    expect(await res.json()).toEqual({ deleted: "jdoe" });
    expect(writes()).toEqual(["DELETE /api/authn/v2/users/u1"]);
    expect(users.map((u) => u.user_id)).toEqual(["u2", "u3"]);
    expect((await audit.latest(5)).find((e) => e.action === "user.delete")).toMatchObject({
      outcome: "ok",
      reason: "delete jdoe",
      status: 204,
      target: { user_id: "u1", user_name: "jdoe" },
    });
    const deleted = (await audit.latest(10)).find((e) => e.action === "user.delete");
    expect(deleted?.changes).toContainEqual({ field: "User name", from: "jdoe", to: null });
    expect(deleted?.changes).toContainEqual({ field: "Last name", from: "Doe", to: null });
    expect(deleted?.changes).toContainEqual({ field: "Scan types", from: "Any Scan", to: null });
    expect(deleted?.changes).toContainEqual({ field: "Member of teams", from: "Blue", to: null });
    // The list is read afresh after a change.
    const list = (await (await get(app, "/api/users", cookie)).json()).users as Rec[];
    expect(list.map((u) => u.user_name)).toEqual(["boss", "api_ci"]);
    const gone = await post(app, "/api/users/delete", cookie, {
      connection_id,
      id: "u1",
      confirm: "jdoe",
    });
    expect([gone.status, (await gone.json()).error]).toEqual([
      502,
      "Reading the user failed (404): No such user",
    ]);
  });
});

describe("activity log paging", () => {
  it("pages the log newest first, 50 by default, and filters to failures", async () => {
    const { app } = await setup();
    for (let i = 0; i < 120; i++) {
      await audit.record({ action: `test.${i}`, outcome: i % 10 === 0 ? "failed" : "ok" });
    }
    const { cookie } = await signIn(app);
    const page = async (body: unknown) =>
      (await post(app, "/api/audit/page", cookie, body)).json() as Promise<{
        entries: { action: string }[];
        total: number;
        page: number;
        size: number;
      }>;

    const first = await page({});
    expect([first.page, first.size, first.total, first.entries.length]).toEqual([1, 50, 121, 50]);
    expect(first.entries[0]?.action).toBe("app.sign_in");
    expect(first.entries[1]?.action).toBe("test.119");

    const third = await page({ page: 3, size: 50 });
    expect(third.entries.map((e) => e.action)).toEqual(
      Array.from({ length: 21 }, (_, i) => `test.${20 - i}`),
    );
    expect((await page({ size: 500 })).entries).toHaveLength(121);
    expect((await page({ size: 7, page: -2 })).size).toBe(50);
    expect((await page({ size: 7, page: -2 })).page).toBe(1);

    const failed = await page({ failed_only: true, size: 100 });
    expect(failed.total).toBe(12);
    expect(failed.entries[0]?.action).toBe("test.110");
  });
});
