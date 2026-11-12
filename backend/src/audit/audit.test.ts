import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Fetch } from "../veracode/oauth.js";
import {
  AuditLog,
  auditedFetch,
  classify,
  connectionRef,
  summarize,
  withAudit,
  withPurpose,
} from "./audit.js";

const NOW = new Date("2026-11-09T12:00:00Z");
const BASE = "https://api.veracode.com/api/authn";
const CONN = connectionRef({ name: "acme", region: "US", client_id: "vrc_1" });

let dir = "";
let log: AuditLog;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "audit-"));
  log = new AuditLog(join(dir, "nested", "audit.log"), () => NOW);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("classify", () => {
  it("names each Identity API call", () => {
    const cases: [string, string, string][] = [
      ["POST", "/api/authn/v2/oauth2/token", "auth.token"],
      ["DELETE", "/api/authn/v2/oauth2/client_credentials/abc/tokens", "auth.revoke_tokens"],
      ["DELETE", "/api/authn/v2/oauth2/client_credentials/abc", "auth.revoke_client"],
      ["GET", "/api/authn/v2/users?size=1", "user.list"],
      ["GET", "/api/authn/v2/users/search", "user.list"],
      ["GET", "/api/authn/v2/users/by_role/r1?page=0&size=100", "user.list"],
      ["POST", "/api/authn/v2/users", "user.create"],
      ["GET", "/api/authn/v2/users/u1", "user.read"],
      ["PUT", "/api/authn/v2/users/u1", "user.update"],
      ["DELETE", "/api/authn/v2/users/u1", "user.delete"],
      ["GET", "/api/authn/v2/roles", "role.list"],
      ["PATCH", "/api/authn/v2/users/u1", "api.patch"],
      ["GET", "/api/authn/v2/teams", "team.list"],
      ["GET", "/api/authn/v2/business_units", "api.get"],
    ];
    for (const [method, path, action] of cases) expect(classify(method, path)).toBe(action);
  });
});

describe("AuditLog", () => {
  it("appends JSON lines with who, on which connection and why, newest first", async () => {
    await log.record({ action: "a.one", outcome: "ok" });
    await withAudit({ actor: "yaakov", connection: CONN }, () =>
      withAudit({ reason: "test" }, () => log.record({ action: "a.two", outcome: "failed" })),
    );
    await log.record({ actor: "dana", action: "a.three", outcome: "ok" });
    const entries = await log.latest(10);
    expect(entries.map((e) => [e.action, e.actor])).toEqual([
      ["a.three", "dana"],
      ["a.two", "yaakov"],
      ["a.one", "system"],
    ]);
    expect(entries[1]).toEqual({
      time: NOW.toISOString(),
      actor: "yaakov",
      action: "a.two",
      outcome: "failed",
      connection: { name: "acme", region: "US", client_id: "vrc_1" },
      reason: "test",
    });
    expect((await log.latest(1)).map((e) => e.action)).toEqual(["a.three"]);
  });

  it("returns nothing for a missing file and skips damaged lines", async () => {
    expect(await log.latest(5)).toEqual([]);
    await log.record({ action: "kept", outcome: "ok" });
    const text = await readFile(log.path, "utf8");
    await writeFile(log.path, `${text}not json\n{"no":"fields"}\n`);
    expect((await log.latest(5)).map((e) => e.action)).toEqual(["kept"]);
  });
});

describe("auditedFetch", () => {
  it("logs each call's action, path and status, never headers or bodies", async () => {
    const inner = vi.fn<Fetch>(async () => new Response("{}", { status: 200 }));
    const veracode = auditedFetch(inner, log);
    await withAudit({ actor: "yaakov", connection: CONN }, async () => {
      await veracode(`${BASE}/v2/oauth2/token`, {
        method: "post",
        headers: { Authorization: "Basic c2VjcmV0" },
        body: "grant_type=client_credentials&client_secret=top-secret",
      });
      await veracode(new Request(`${BASE}/v2/users/u1`, { method: "DELETE" }));
    });
    const [deleted, token] = await log.latest(5);
    expect(token).toMatchObject({
      actor: "yaakov",
      action: "auth.token",
      outcome: "ok",
      method: "POST",
      path: "api.veracode.com/api/authn/v2/oauth2/token",
      status: 200,
      connection: { name: "acme" },
    });
    expect(deleted).toMatchObject({ action: "user.delete", method: "DELETE", status: 200 });
    const text = await readFile(log.path, "utf8");
    expect(text).not.toContain("top-secret");
    expect(text).not.toContain("c2VjcmV0");
  });

  it("logs refused calls and network failures", async () => {
    const inner = vi
      .fn<Fetch>()
      .mockResolvedValueOnce(new Response("{}", { status: 403 }))
      .mockRejectedValueOnce(new Error("offline"));
    const veracode = auditedFetch(inner, log);
    await veracode(`${BASE}/v2/users?size=1`);
    await expect(veracode(`${BASE}/v2/users`, { method: "POST" })).rejects.toThrow("offline");
    const [failed, refused] = await log.latest(5);
    expect(refused).toMatchObject({ action: "user.list", outcome: "failed", status: 403 });
    expect(failed).toMatchObject({ action: "user.create", outcome: "failed", detail: "offline" });
  });

  it("logs why each call was made, how long it took and counts of what came back", async () => {
    const users = [{ user_id: "u1", user_name: "secret.person@x.com" }];
    const inner = vi.fn<Fetch>(async (input) =>
      String(input).includes("token")
        ? new Response(JSON.stringify({ access_token: "tok-secret" }), { status: 200 })
        : new Response(
            JSON.stringify({ _embedded: { users }, page: { number: 0, total_pages: 2 } }),
          ),
    );
    const veracode = auditedFetch(inner, log);
    await withAudit({ purpose: "Load the users list" }, () =>
      withPurpose("users of a role", async () => {
        await veracode(`${BASE}/v2/oauth2/token`, { method: "POST" });
        await veracode(`${BASE}/v2/users/by_role/r1`);
      }),
    );
    const [list, token] = await log.latest(5);
    expect(list).toMatchObject({
      purpose: "Load the users list: users of a role",
      result: "1 users (page 1 of 2)",
    });
    expect(typeof list?.ms).toBe("number");
    expect(token).toMatchObject({
      purpose: "Get an access token, for: Load the users list: users of a role",
      result: "1 token",
    });
    const text = await readFile(log.path, "utf8");
    expect(text).not.toContain("secret.person");
    expect(text).not.toContain("tok-secret");
  });
});

describe("summarize", () => {
  it("gives counts only", () => {
    expect(summarize("")).toBe("no content");
    expect(summarize("not json")).toBeUndefined();
    expect(
      summarize(JSON.stringify({ _embedded: { roles: [{}, {}] }, page: { total_pages: 1 } })),
    ).toBe("2 roles");
    expect(summarize(JSON.stringify({ page: { number: 0, total_pages: 0 } }))).toBe("none");
    expect(summarize(JSON.stringify({ user_id: "u1", roles: [] }))).toBe("1 user, with roles");
    expect(summarize(JSON.stringify({ user_id: "u1" }))).toBe("1 user");
    expect(summarize(JSON.stringify({ team_id: "t1" }))).toBe("1 team");
    expect(summarize(JSON.stringify({ ok: true }))).toBe("1 record");
  });
});

describe("summarize", () => {
  it("gives counts only, never the records or a token", () => {
    expect(summarize("")).toBe("no content");
    expect(summarize("not json")).toBeUndefined();
    expect(
      summarize(
        JSON.stringify({ _embedded: { users: [{}, {}] }, page: { number: 0, total_pages: 1 } }),
      ),
    ).toBe("2 users");
    expect(
      summarize(
        JSON.stringify({ _embedded: { roles: [{}] }, page: { number: 1, total_pages: 3 } }),
      ),
    ).toBe("1 roles (page 2 of 3)");
    expect(summarize(JSON.stringify({ page: { number: 0, total_pages: 0 } }))).toBe("none");
    expect(summarize(JSON.stringify({ access_token: "secret-token" }))).toBe("1 token");
    expect(summarize(JSON.stringify({ user_id: "u1", user_name: "jdoe", roles: [] }))).toBe(
      "1 user, with roles",
    );
    expect(summarize(JSON.stringify({ user_id: "u1" }))).toBe("1 user");
    expect(summarize(JSON.stringify({ team_id: "t1" }))).toBe("1 team");
  });
});

describe("purpose and timing", () => {
  it("logs why each call was made, how long it took and what came back", async () => {
    const inner = vi.fn<Fetch>(async (input) =>
      String(input).endsWith("/token")
        ? new Response(JSON.stringify({ access_token: "secret-token" }), { status: 200 })
        : new Response(JSON.stringify({ _embedded: { users: [{ user_name: "jdoe" }] } }), {
            status: 200,
          }),
    );
    const veracode = auditedFetch(inner, log);
    await withAudit({ purpose: "Load the users list" }, async () => {
      await veracode(`${BASE}/v2/oauth2/token`, { method: "POST" });
      await withPurpose("users of a role", () => veracode(`${BASE}/v2/users/by_role/r1`));
    });
    const [byRole, token] = await log.latest(5);
    expect(token).toMatchObject({
      purpose: "Get an access token, for: Load the users list",
      result: "1 token",
    });
    expect(byRole).toMatchObject({
      purpose: "Load the users list: users of a role",
      result: "1 users",
    });
    expect(typeof byRole?.ms).toBe("number");
    const text = await readFile(log.path, "utf8");
    expect(text).not.toContain("secret-token");
    expect(text).not.toContain("jdoe");
  });
});
