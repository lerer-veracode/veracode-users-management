import { afterEach, describe, expect, it, vi } from "vitest";
import { checkAccess, listRoles, listUsers, relationshipOf } from "./identity.js";
import { TokenCache, baseUrl, requestToken, revokeConnection, type Fetch } from "./oauth.js";

const CREDS = { region: "eu" as const, client_id: "vrc_id", client_secret: "top-secret" };
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const stubFetch = (...responses: (Response | Error)[]) => {
  const fn = vi.fn<Fetch>();
  for (const r of responses) {
    if (r instanceof Error) fn.mockRejectedValueOnce(r);
    else fn.mockResolvedValueOnce(r);
  }
  return fn;
};

describe("requestToken", () => {
  it("posts client credentials with Basic auth to the region's token URL", async () => {
    const fetchFn = stubFetch(json(200, { access_token: "tok", expires_in: 3600 }));
    const token = await requestToken(CREDS, fetchFn, 1_000);
    expect(token).toEqual({ access_token: "tok", expires_at: 3_601_000 });
    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(url).toBe("https://api.veracode.eu/api/authn/v2/oauth2/token");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe("grant_type=client_credentials");
    expect(new Headers(init?.headers).get("Authorization")).toBe(
      `Basic ${Buffer.from("vrc_id:top-secret").toString("base64")}`,
    );
  });

  it("reports Veracode's message without the secret", async () => {
    const fetchFn = stubFetch(json(401, { error: "invalid_client" }));
    const err = await requestToken(CREDS, fetchFn, 0).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(String(err)).toContain("Getting a token failed (401): invalid_client");
    expect(String(err)).not.toContain("top-secret");
  });

  it("rejects a response without a token and defaults the lifetime", async () => {
    await expect(requestToken(CREDS, stubFetch(json(200, {})), 0)).rejects.toThrow(
      "no access_token",
    );
    const token = await requestToken(CREDS, stubFetch(json(200, { access_token: "t" })), 0);
    expect(token.expires_at).toBe(300_000);
  });

  it("falls back to the status text for non-JSON errors", async () => {
    const fetchFn = stubFetch(new Response("oops", { status: 500, statusText: "Server Error" }));
    await expect(requestToken(CREDS, fetchFn, 0)).rejects.toThrow("(500): Server Error");
  });
});

describe("TokenCache", () => {
  it("reuses a token until a minute before it expires", async () => {
    let now = 0;
    const fetchFn = stubFetch(
      json(200, { access_token: "first", expires_in: 300 }),
      json(200, { access_token: "second", expires_in: 300 }),
      json(200, { access_token: "third", expires_in: 300 }),
    );
    const cache = new TokenCache(fetchFn, () => now);
    expect(await cache.get(CREDS)).toBe("first");
    now = 239_000;
    expect(await cache.get(CREDS)).toBe("first");
    now = 240_000;
    expect(await cache.get(CREDS)).toBe("second");
    cache.drop(CREDS);
    expect(await cache.get(CREDS)).toBe("third");
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });
});

describe("checkAccess", () => {
  const token = () => json(200, { access_token: "tok", expires_in: 3600 });

  it("reads one user with the Bearer token", async () => {
    const fetchFn = stubFetch(token(), json(200, { _embedded: { users: [] } }));
    const result = await checkAccess(CREDS, new TokenCache(fetchFn), fetchFn);
    expect(result.ok).toBe(true);
    const [url, init] = fetchFn.mock.calls[1] ?? [];
    expect(url).toBe("https://api.veracode.eu/api/authn/v2/users?size=1");
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer tok");
  });

  it("explains a missing role, other errors and a failed token", async () => {
    let fetchFn = stubFetch(token(), json(403, {}));
    expect((await checkAccess(CREDS, new TokenCache(fetchFn), fetchFn)).message).toContain(
      "Admin API role",
    );
    fetchFn = stubFetch(token(), json(500, { message: "boom" }));
    expect((await checkAccess(CREDS, new TokenCache(fetchFn), fetchFn)).message).toContain("boom");
    fetchFn = stubFetch(new Error("network down"));
    expect(await checkAccess(CREDS, new TokenCache(fetchFn), fetchFn)).toEqual({
      ok: false,
      message: "network down",
    });
  });
});

describe("revokeConnection", () => {
  it("revokes the tokens, then the client", async () => {
    const fetchFn = stubFetch(
      json(200, { access_token: "tok", expires_in: 60 }),
      new Response(null, { status: 204 }),
      new Response(null, { status: 204 }),
    );
    const results = await revokeConnection(CREDS, fetchFn, 0);
    expect(results.map((r) => r.ok)).toEqual([true, true]);
    expect(fetchFn.mock.calls.slice(1).map(([url, init]) => [init?.method, url])).toEqual([
      ["DELETE", "https://api.veracode.eu/api/authn/v2/oauth2/client_credentials/vrc_id/tokens"],
      ["DELETE", "https://api.veracode.eu/api/authn/v2/oauth2/client_credentials/vrc_id"],
    ]);
  });

  it("reports each failure without throwing", async () => {
    let results = await revokeConnection(CREDS, stubFetch(json(401, { error: "expired" })), 0);
    expect(results).toEqual([
      {
        step: "Get a token to revoke with",
        ok: false,
        message: "Getting a token failed (401): expired",
      },
    ]);
    results = await revokeConnection(
      CREDS,
      stubFetch(json(200, { access_token: "t" }), json(403, {}), new Error("offline")),
      0,
    );
    expect(results.map((r) => [r.ok, r.message])).toEqual([
      [false, "Revoke tokens failed (403): HTTP 403"],
      [false, "offline"],
    ]);
  });
});

describe("listUsers and listRoles", () => {
  const token = () => json(200, { access_token: "tok", expires_in: 3600 });
  const user = (n: number, extra: Record<string, unknown> = {}) => ({
    user_id: `u${n}`,
    user_name: `user${n}`,
    first_name: "First",
    last_name: `Last${n}`,
    email_address: `user${n}@example.com`,
    active: true,
    login_enabled: true,
    last_login: "2026-11-01T10:00:00Z",
    password: "never-copied",
    ...extra,
  });

  it("falls back to each user's record when the list's options are refused, keeping only the fields used", async () => {
    const basic = (n: number, extra: Record<string, unknown> = {}) => ({
      user_id: `u${n}`,
      user_name: `user${n}`,
      email_address: `user${n}@example.com`,
      active: true,
      ...extra,
    });
    const fetchFn = vi.fn<Fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith("/oauth2/token")) return token();
      if (url.includes("include_roles=true")) return json(400, { message: "Bad option" });
      if (url.endsWith("/v2/users?page=0&size=100")) {
        return json(200, {
          _embedded: { users: [basic(1), basic(2)] },
          page: { number: 0, total_pages: 2 },
        });
      }
      if (url.endsWith("/v2/users?page=1&size=100")) {
        return json(200, {
          _embedded: { users: [basic(3, { saml_user: true })] },
          page: { total_pages: 2 },
        });
      }
      if (url.endsWith("/v2/users/u1")) {
        return json(
          200,
          user(1, {
            roles: [{ role_name: "extseclead", role_description: "Security Lead" }],
            permissions: [{ permission_name: "viewReports" }],
            teams: [{ team_id: "t1", team_name: "Blue" }],
          }),
        );
      }
      if (url.endsWith("/v2/users/u2")) {
        return json(200, user(2, { api_user: true, active: false, last_login: null }));
      }
      return json(404, {});
    });
    const users = await listUsers(CREDS, new TokenCache(fetchFn), fetchFn);
    expect(users.map((u) => [u.user_name, u.user_type, u.active])).toEqual([
      ["user1", "UI", true],
      ["user2", "API", false],
      ["user3", "SAML", true],
    ]);
    expect(users[0]).toEqual({
      user_id: "u1",
      user_name: "user1",
      first_name: "First",
      last_name: "Last1",
      email_address: "user1@example.com",
      user_type: "UI",
      active: true,
      login_enabled: true,
      pin_required: false,
      last_login: "2026-11-01T10:00:00Z",
      roles: [{ role_name: "extseclead", role_description: "Security Lead" }],
      permissions: [{ permission_name: "viewReports", permission_description: "viewReports" }],
      teams: [{ team_id: "t1", team_name: "Blue", relationship: "MEMBER" }],
    });
    expect(users[1]?.last_login).toBeNull();
    expect(users[2]).toMatchObject({ user_id: "u3", roles: [], last_login: null });
    expect(JSON.stringify(users)).not.toContain("never-copied");
    const urls = fetchFn.mock.calls.map(([url]) => String(url)).filter((u) => !u.endsWith("token"));
    expect(urls.slice(0, 3)).toEqual([
      "https://api.veracode.eu/api/authn/v2/users?detailed=true&include_roles=true&include_teams=true&page=0&size=100",
      "https://api.veracode.eu/api/authn/v2/users?page=0&size=100",
      "https://api.veracode.eu/api/authn/v2/users?page=1&size=100",
    ]);
    expect(urls.slice(3).sort()).toEqual([
      "https://api.veracode.eu/api/authn/v2/users/u1",
      "https://api.veracode.eu/api/authn/v2/users/u2",
      "https://api.veracode.eu/api/authn/v2/users/u3",
    ]);
  });

  it("still reads pages when Veracode uses the spec's totalPages", async () => {
    const fetchFn = stubFetch(
      token(),
      json(200, { _embedded: { users: [] }, page: { totalPages: 2 } }),
      json(200, { _embedded: { users: [] }, page: { totalPages: 2 } }),
    );
    expect(await listUsers(CREDS, new TokenCache(fetchFn), fetchFn)).toEqual([]);
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it("reads roles with their permissions, and copes with an empty or odd page", async () => {
    const fetchFn = stubFetch(
      token(),
      json(200, {
        _embedded: {
          roles: [
            {
              role_id: "r1",
              role_name: "extseclead",
              role_description: "Security Lead",
              is_api: false,
              permissions: [
                { permission_name: "manageApps", permission_description: "Manage applications" },
              ],
            },
            { role_name: "uploadapi", is_api: true },
          ],
        },
      }),
    );
    expect(await listRoles(CREDS, new TokenCache(fetchFn), fetchFn)).toEqual([
      {
        role_id: "r1",
        role_name: "extseclead",
        role_description: "Security Lead",
        is_api: false,
        is_scan_type: false,
        permissions: [
          { permission_name: "manageApps", permission_description: "Manage applications" },
        ],
      },
      {
        role_id: "",
        role_name: "uploadapi",
        role_description: "uploadapi",
        is_api: true,
        is_scan_type: false,
        permissions: [],
      },
    ]);
    const empty = stubFetch(token(), json(200, []));
    expect(await listUsers(CREDS, new TokenCache(empty), empty)).toEqual([]);
  });

  it("reports Veracode's error", async () => {
    const fetchFn = stubFetch(token(), json(403, { message: "Forbidden" }));
    await expect(listUsers(CREDS, new TokenCache(fetchFn), fetchFn)).rejects.toThrow(
      "Reading users failed (403): Forbidden",
    );
  });
});

describe("baseUrl", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses the region's address, or a local fake for tests only", () => {
    expect(baseUrl("us")).toBe("https://api.veracode.com/api/authn");
    vi.stubEnv("VERACODE_API_BASE", "http://localhost:8789/api/authn/");
    expect(baseUrl("eu")).toBe("http://localhost:8789/api/authn");
    vi.stubEnv("VERACODE_API_BASE", "https://evil.example.com/api/authn");
    expect(baseUrl("eu")).toBe("https://api.veracode.eu/api/authn");
    vi.stubEnv("VERACODE_API_BASE", "http://localhost.evil.com:80/x");
    expect(baseUrl("fed")).toBe("https://api.veracode.us/api/authn");
  });
});

describe("listUsers in bulk (PLAN_CACHE phase 4)", () => {
  // 250 users. Reviewer (r1) is held by users 0-199, Submitter (r2) by 150-248, Upload API (r3,
  // an API role) by every 50th; user 249 has no role. Each in team Blue, managed by every 10th.
  const role = (id: string) =>
    ({
      r1: { role_id: "r1", role_name: "extreviewer", role_description: "Reviewer" },
      r2: { role_id: "r2", role_name: "extsubmitter", role_description: "Submitter" },
      r3: { role_id: "r3", role_name: "uploadapi", role_description: "Upload API" },
    })[id];
  const rolesOf = (i: number) =>
    [i < 200 && "r1", i >= 150 && i < 249 && "r2", i % 50 === 0 && "r3"].filter(
      (r): r is string => typeof r === "string",
    );
  const listed = (i: number) => ({
    user_id: `u${i}`,
    user_name: `user${i}`,
    first_name: "F",
    last_name: `L${i}`,
    email_address: `u${i}@x.com`,
    active: true,
    login_enabled: true,
    roles: rolesOf(i).map(role),
    teams: [
      {
        team_id: "t1",
        team_name: "Blue",
        relationship: { name: i % 10 === 0 ? "ADMIN" : "MEMBER", display_name: "x" },
      },
    ],
  });
  // by_role's full records: no teams, but last login, MFA and permissions.
  const record = (i: number) => {
    const { teams, ...rest } = listed(i);
    void teams;
    return { ...rest, last_login: `2026-11-0${(i % 9) + 1}T10:00:00Z`, pin_required: i % 2 === 0 };
  };
  const page = (items: unknown[], url: URL) => {
    const p = Number(url.searchParams.get("page") ?? 0);
    return json(200, {
      _embedded: { users: items.slice(p * 100, p * 100 + 100) },
      page: { total_pages: Math.ceil(items.length / 100) },
    });
  };
  const all = Array.from({ length: 250 }, (_, i) => i);
  // hidden: users by_role never returns, as API accounts may not be.
  const stub = (byRoleStatus = 200, hidden: (i: number) => boolean = () => false) =>
    vi.fn<Fetch>(async (input) => {
      const url = new URL(String(input));
      const path = url.pathname.replace("/api/authn", "");
      if (path === "/v2/oauth2/token") return json(200, { access_token: "tok", expires_in: 3600 });
      if (path === "/v2/users") return page(all.map(listed), url);
      const byRole = /^\/v2\/users\/by_role\/(r\d)$/.exec(path);
      if (byRole) {
        if (byRoleStatus !== 200) return json(byRoleStatus, { message: "Nope" });
        const holders = all.filter((i) => rolesOf(i).includes(byRole[1] ?? "") && !hidden(i));
        return page(holders.map(record), url);
      }
      const one = /^\/v2\/users\/u(\d+)$/.exec(path);
      if (one) return json(200, { ...record(Number(one[1])), teams: listed(Number(one[1])).teams });
      return json(404, {});
    });
  const known = [
    { role_id: "r3", role_name: "uploadapi", role_description: "Upload API", is_api: true },
  ].map((r) => ({ ...r, is_scan_type: false, permissions: [] }));
  const paths = (fetchFn: ReturnType<typeof stub>) =>
    fetchFn.mock.calls
      .map(([u]) => new URL(String(u)))
      .filter((u) => !u.pathname.endsWith("/token"))
      .map((u) => `${u.pathname.replace("/api/authn", "")}?page=${u.searchParams.get("page")}`);

  it("reads users with roles, teams, last login and MFA in a few calls, with no record each", async () => {
    const fetchFn = stub();
    const users = await listUsers(CREDS, new TokenCache(fetchFn), fetchFn, known);
    expect(users).toHaveLength(250);
    // The list's 3 pages; Reviewer's 2 pages cover 0-199, Submitter's 1 page covers the rest
    // with a role; user 249, with no role, is read on their own.
    // Reviewer and Submitter run at once (their order varies); Upload API isn't read, as its
    // holders are all covered.
    expect(paths(fetchFn).sort()).toEqual([
      "/v2/users/by_role/r1?page=0",
      "/v2/users/by_role/r1?page=1",
      "/v2/users/by_role/r2?page=0",
      "/v2/users/u249?page=null",
      "/v2/users?page=0",
      "/v2/users?page=1",
      "/v2/users?page=2",
    ]);
    expect(users[10]).toMatchObject({
      user_id: "u10",
      last_login: "2026-11-02T10:00:00Z",
      pin_required: true,
      roles: [{ role_name: "extreviewer", role_description: "Reviewer" }],
      teams: [{ team_id: "t1", team_name: "Blue", relationship: "ADMIN" }],
    });
    expect(users[11]?.teams[0]?.relationship).toBe("MEMBER");
    // Upload API is an API role: the organization's roles say so, the list's roles don't.
    expect(users[50]?.user_type).toBe("API");
    expect(users[51]?.user_type).toBe("UI");
    expect(users[249]).toMatchObject({ roles: [], last_login: "2026-11-07T10:00:00Z" });
  });

  it("reads the list while the roles are still being read", async () => {
    const fetchFn = stub();
    let giveRoles: (roles: typeof known) => void = () => undefined;
    const roles = new Promise<typeof known>((resolve) => (giveRoles = resolve));
    const listing = listUsers(CREDS, new TokenCache(fetchFn), fetchFn, roles);
    await vi.waitFor(() => expect(paths(fetchFn)).toContain("/v2/users?page=0"));
    giveRoles(known);
    const users = await listing;
    expect(users[50]?.user_type).toBe("API");
  });

  it("fails with the list's error when the roles fail too", async () => {
    const fetchFn = stub();
    fetchFn.mockImplementation(async () => new Response("{}", { status: 403 }));
    const roles = Promise.reject(new Error("roles failed"));
    const error: unknown = await listUsers(CREDS, new TokenCache(fetchFn), fetchFn, roles).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain("roles failed");
  });

  it("doesn't read every role for users by_role never returns", async () => {
    // Every 50th user (the API ones) is missing from by_role's answers.
    const fetchFn = stub(200, (i) => i % 50 === 0);
    const users = await listUsers(CREDS, new TokenCache(fetchFn), fetchFn, known);
    const p = paths(fetchFn);
    expect(p.filter((x) => x.includes("by_role")).sort()).toEqual([
      "/v2/users/by_role/r1?page=0",
      "/v2/users/by_role/r1?page=1",
      "/v2/users/by_role/r2?page=0",
    ]);
    // The 5 hidden users and the one with no role are read on their own.
    expect(p.filter((x) => /\/v2\/users\/u\d+/.test(x)).sort()).toEqual(
      ["u0", "u100", "u150", "u200", "u249", "u50"].map((u) => `/v2/users/${u}?page=null`),
    );
    expect(users[50]?.user_type).toBe("API");
  });

  it("reads each remaining user's record when by_role fails", async () => {
    const fetchFn = stub(500);
    const users = await listUsers(CREDS, new TokenCache(fetchFn), fetchFn, known);
    expect(users).toHaveLength(250);
    const p = paths(fetchFn);
    // One failed round of by_role, then no more: every user's record instead.
    expect(p.filter((x) => x.includes("by_role")).sort()).toEqual([
      "/v2/users/by_role/r1?page=0",
      "/v2/users/by_role/r2?page=0",
    ]);
    expect(p.filter((x) => /\/v2\/users\/u\d+/.test(x))).toHaveLength(250);
    expect(users[10]).toMatchObject({
      pin_required: true,
      teams: [{ team_id: "t1", relationship: "ADMIN" }],
    });
  });
});

describe("a team's relationship", () => {
  it("reads Veracode's { name } object and the plain string (REALITY 38)", () => {
    expect(relationshipOf({ name: "ADMIN", display_name: "Team Admin" })).toBe("ADMIN");
    expect(relationshipOf({ name: "admin" })).toBe("ADMIN");
    expect(relationshipOf({ name: "MEMBER", display_name: "Member" })).toBe("MEMBER");
    expect(relationshipOf("ADMIN")).toBe("ADMIN");
    expect(relationshipOf("MEMBER")).toBe("MEMBER");
    expect(relationshipOf(undefined)).toBe("MEMBER");
    expect(relationshipOf({})).toBe("MEMBER");
  });
});

describe("API user detection", () => {
  const token = () => json(200, { access_token: "tok", expires_in: 3600 });
  const typeOf = async (record: Record<string, unknown>) => {
    const fetchFn = vi.fn<Fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith("/oauth2/token")) return token();
      if (url.includes("/v2/users?")) {
        return json(200, { _embedded: { users: [{ user_id: "u1" }] }, page: { total_pages: 1 } });
      }
      return json(200, { user_id: "u1", ...record });
    });
    return (await listUsers(CREDS, new TokenCache(fetchFn), fetchFn))[0]?.user_type;
  };

  it("finds API users by any sign the record carries", async () => {
    expect(await typeOf({})).toBe("UI");
    expect(await typeOf({ saml_user: true })).toBe("SAML");
    expect(await typeOf({ api_user: true })).toBe("API");
    expect(await typeOf({ permissions: [{ permission_name: "apiUser" }] })).toBe("API");
    expect(await typeOf({ user_type: "API" })).toBe("API");
    expect(await typeOf({ account_type: "api_service" })).toBe("API");
    expect(await typeOf({ roles: [{ role_name: "adminapi", is_api: true }] })).toBe("API");
    expect(await typeOf({ roles: [{ role_name: "extseclead", is_api: false }] })).toBe("UI");
  });
});
