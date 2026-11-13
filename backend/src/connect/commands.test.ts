import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuditLog } from "../audit/audit.js";
import type { Fetch } from "../veracode/oauth.js";
import { readVault } from "../vault/file.js";
import { HELP, runConnect, type Deps } from "./commands.js";
import { CancelledError } from "./prompt.js";

const PASSWORD = "correct horse battery";
const SECRET = "client-secret-value";
const DAY = 86_400_000;
const START = new Date("2026-11-09T12:00:00Z");

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

// Answers Veracode calls by URL: tokens always work, users answer with `usersStatus`.
const veracode = (usersStatus = 200) =>
  vi.fn<Fetch>(async (input, init) => {
    const url = String(input);
    if (url.endsWith("/oauth2/token")) return json(200, { access_token: "tok", expires_in: 3600 });
    if (url.includes("/v2/users")) return json(usersStatus, {});
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    return json(404, {});
  });

let dir = "";
let lines: string[] = [];
let now = START;
let audit: AuditLog;

const run = async (args: string[], answers: string[], fetchFn: Fetch = veracode()) => {
  const queue = [...answers];
  const next = async () => {
    const answer = queue.shift();
    if (answer === undefined) throw new CancelledError("Ran out of answers");
    return answer;
  };
  const deps: Deps = {
    prompt: { ask: next, askHidden: next },
    out: (line) => lines.push(line),
    fetch: fetchFn,
    now: () => now,
    vaultPath: join(dir, "vault.json"),
    audit,
    cost: { N: 2 ** 10, r: 8, p: 1 },
  };
  return runConnect(args, deps);
};

const output = () => lines.join("\n");
const signIn = ["yaakov", PASSWORD];
const firstRun = () => run([], ["yaakov", PASSWORD, PASSWORD, "acme", "eu", "vrc_acme", SECRET]);

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "connect-"));
  lines = [];
  now = START;
  audit = new AuditLog(join(dir, "audit.log"), () => now);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("npm run connect", () => {
  it("prints help, and refuses unknown commands", async () => {
    expect(await run(["help"], [])).toBe(0);
    expect(output()).toBe(HELP);
    expect(await run(["nope"], [])).toBe(1);
    expect(output()).toContain("Unknown command: nope");
  });

  it("creates the vault on the first run and saves a tested connection", async () => {
    const fetchFn = veracode();
    expect(
      await run([], ["yaakov", PASSWORD, PASSWORD, "acme", "eu", "vrc_acme", SECRET], fetchFn),
    ).toBe(0);
    expect(output()).toContain("Vault created");
    expect(output()).toContain("OK  Connected");
    expect(output()).toContain("Saved acme. It will be removed on 9 Dec 2026 (30 days).");
    const log = await audit.latest(10);
    expect(log.map((e) => [e.action, e.actor])).toEqual([
      ["connection.added", "yaakov"],
      ["auth.check", "yaakov"],
      ["user.list", "yaakov"],
      ["auth.token", "yaakov"],
      ["app_user.added", "yaakov"],
    ]);
    expect(log[1]).toMatchObject({ reason: "add", connection: { name: "acme", region: "EU" } });
    expect(await readFile(join(dir, "audit.log"), "utf8")).not.toContain(SECRET);
    expect(String(fetchFn.mock.calls[0]?.[0])).toContain("api.veracode.eu");

    const text = await readFile(join(dir, "vault.json"), "utf8");
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(PASSWORD);
    expect(output()).not.toContain(SECRET);
    expect(output()).not.toContain(PASSWORD);

    lines = [];
    expect(await run(["list"], signIn)).toBe(0);
    expect(output()).toMatch(/acme {2}EU {2}vrc_acme {2}added 9 Nov 2026 {2}30 days left/);
    expect(output()).toContain("yaakov  last sign-in 9 Nov 2026  30 days left");
  });

  it("asks before saving a connection that fails its test", async () => {
    await run([], ["yaakov", PASSWORD, PASSWORD, "acme", "", "vrc", SECRET, "n"], veracode(403));
    expect(output()).toContain("FAILED  Signed in, but not allowed to read users (403)");
    expect(output()).toContain("Not saved.");
    lines = [];
    await run(["add"], [...signIn, "acme", "us", "vrc", SECRET, "y"], veracode(403));
    expect(output()).toContain("Saved acme.");
  });

  it("refuses bad input with a clear message", async () => {
    expect(await run([], ["yaakov", PASSWORD, "different password"])).toBe(1);
    expect(output()).toContain("The passwords don't match.");
    expect(await run([], ["yaakov", "short", "short"])).toBe(1);
    expect(output()).toContain("at least 12 characters");

    await firstRun();
    lines = [];
    expect(await run(["add"], [...signIn, "ACME"])).toBe(1);
    expect(output()).toContain("A connection named ACME already exists.");
    expect(await run(["add"], [...signIn, ""])).toBe(1);
    expect(await run(["add"], [...signIn, "x", "mars"])).toBe(1);
    expect(output()).toContain("Region must be one of: us, eu, fed.");
    expect(await run(["add"], [...signIn, "x", "us", "", ""])).toBe(1);
    expect(output()).toContain("The client ID and secret are required.");
    expect(await run(["list"], ["yaakov", "wrong password!"])).toBe(1);
    expect(output()).toContain("Wrong username or password.");
    expect((await audit.latest(1))[0]).toMatchObject({ action: "app.sign_in", outcome: "failed" });
    expect(await run(["list"], ["yaakov"])).toBe(1);
    expect(output()).toContain("Ran out of answers");
  });

  it("removes a connection and revokes it on Veracode", async () => {
    await firstRun();
    const fetchFn = veracode();
    lines = [];
    expect(await run(["remove", "acme"], [...signIn, "n"], fetchFn)).toBe(0);
    expect(output()).toContain("Nothing removed.");
    expect(await run(["remove"], [...signIn, "acme", "y"], fetchFn)).toBe(0);
    expect(output()).toContain("OK  Revoke tokens: Done");
    expect(output()).toContain("OK  Revoke client: Done");
    expect(output()).toContain("Removed acme.");
    const [removed] = await audit.latest(1);
    expect(removed).toMatchObject({
      action: "connection.removed",
      actor: "yaakov",
      outcome: "ok",
      reason: "removed",
      connection: { name: "acme", region: "EU", client_id: "vrc_acme" },
    });
    expect(await run(["remove", "acme"], signIn)).toBe(1);
    expect(output()).toContain("No connection named acme.");
  });

  it("adds and removes app users, but never the last one", async () => {
    await firstRun();
    expect(
      await run(["add-user"], [...signIn, "Dana", "dana long password", "dana long password"]),
    ).toBe(0);
    expect(output()).toContain("Added app user dana.");
    lines = [];
    expect(await run(["list"], ["dana", "dana long password"])).toBe(0);
    expect(output()).toContain("Signed in as dana.");

    expect(await run(["remove-user", "dana"], [...signIn, "n"])).toBe(0);
    expect(output()).toContain("Nothing removed.");
    expect(await run(["remove-user"], [...signIn, "dana", "y"])).toBe(0);
    expect(output()).toContain("Removed app user dana.");
    expect((await audit.latest(1))[0]).toMatchObject({ action: "app_user.removed" });
    expect(await run(["remove-user", "yaakov"], signIn)).toBe(1);
    expect(output()).toContain("The last app user can't be removed.");
  });

  it("revokes and removes connections after 30 days, and idle app users", async () => {
    await firstRun();
    await run(["add-user"], [...signIn, "dana", "dana long password", "dana long password"]);
    now = new Date(START.getTime() + 20 * DAY);
    await run(["list"], signIn);

    now = new Date(START.getTime() + 31 * DAY);
    lines = [];
    const fetchFn = veracode();
    expect(await run(["list"], signIn, fetchFn)).toBe(0);
    expect(output()).toContain("Removed app user dana: no sign-in for 30 days.");
    expect(output()).toContain("Connection acme is 30 days old. Revoked it on Veracode:");
    expect(output()).toContain("OK  Revoke client: Done");
    expect(output()).toMatch(/Connections:\n {2}none/);

    const file = await readVault(join(dir, "vault.json"));
    expect(file?.users.map((u) => u.username)).toEqual(["yaakov"]);
  });

  it("reports a revoke that fails and still removes the connection", async () => {
    await firstRun();
    now = new Date(START.getTime() + 20 * DAY);
    await run(["list"], signIn);
    now = new Date(START.getTime() + 30 * DAY);
    lines = [];
    const failing = vi.fn<Fetch>(async () => json(401, { error: "invalid_client" }));
    expect(await run(["list"], signIn, failing)).toBe(0);
    expect(output()).toContain("FAILED  Get a token to revoke with");
    expect(output()).toContain("revoke it there if it's still active");
    expect(output()).toMatch(/Connections:\n {2}none/);
  });
});

describe("npm run connect -- inspect", () => {
  it("prints the structure of Veracode's answers and never their values", async () => {
    await firstRun();
    lines = [];
    const fetchFn = vi.fn<Fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith("/oauth2/token")) {
        return json(200, { access_token: "tok", expires_in: 3600 });
      }
      if (url.includes("/v2/roles")) return new Response("<html>", { status: 200 });
      if (url.includes("fields_to_return")) return json(400, { message: "Bad field list" });
      return json(200, {
        _embedded: { users: [{ user_name: "secret-person", roles: [{ role_name: "x" }] }] },
        page: { total_pages: 1, total_elements: 1 },
        deep: { a: { b: { c: { d: { e: 1 } } } } },
        empty: [],
        none: null,
      });
    });
    expect(await run(["inspect"], signIn, fetchFn)).toBe(0);
    expect(output()).toContain("Inspecting acme (EU). Structure only, no values.");
    expect(output()).toContain("GET /v2/users?size=2 -> 200 application/json");
    expect(output()).toContain('"user_name": "string"');
    expect(output()).toContain('"array(1)"');
    expect(output()).toContain('"empty": "array(0)"');
    expect(output()).toContain('"none": "null"');
    expect(output()).toContain('"c": "object"');
    expect(output()).toContain("total_elements: 1");
    expect(output()).toContain("GET /v2/users/{userId} -> skipped: no id from an earlier answer");
    expect(output()).toContain("not JSON (6 characters)");
    expect(output()).toContain(
      "GET /v2/users/search?size=2&fields_to_return=roles,teams,last_login,pin_required,permissions -> 400",
    );
    expect(output()).toContain("  message: Bad field list");
    expect(output()).toContain(
      "GET /v2/users?detailed=true&include_roles=true&include_teams=true&size=2 -> 200",
    );
    expect(output()).toContain('  first of a user\'s roles: {"role_name":"string"}');
    expect(output()).toContain("GET /v2/teams?size=2 -> 200 application/json");
    expect(output()).toContain("GET /v2/teams/{teamId} -> skipped: no id from an earlier answer");
    expect(output()).not.toContain("secret-person");
    const logged = await audit.latest(20);
    expect(logged).toContainEqual(
      expect.objectContaining({ action: "role.list", reason: "inspect" }),
    );
    expect(logged).toContainEqual(
      expect.objectContaining({ action: "team.list", reason: "inspect" }),
    );
    // Every probe only reads.
    expect(
      fetchFn.mock.calls.every(
        ([u, i]) => String(u).endsWith("/oauth2/token") || !i?.method || i.method === "GET",
      ),
    ).toBe(true);
  });

  it("probes a team the inspected user is in, so it has a member", async () => {
    await firstRun();
    lines = [];
    const fetchFn = vi.fn<Fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith("/oauth2/token")) {
        return json(200, { access_token: "tok", expires_in: 3600 });
      }
      if (url.includes("/v2/users/u1")) return json(200, { teams: [{ team_id: "team-9" }] });
      if (url.includes("/v2/teams?")) {
        return json(200, { _embedded: { teams: [{ team_id: "empty-team" }] } });
      }
      return json(200, { _embedded: { users: [{ user_id: "u1" }] } });
    });
    expect(await run(["inspect"], signIn, fetchFn)).toBe(0);
    const urls = fetchFn.mock.calls.map(([u]) => String(u));
    expect(urls.some((u) => u.endsWith("/v2/teams/team-9"))).toBe(true);
    expect(urls.some((u) => u.includes("team_id=team-9"))).toBe(true);
    expect(urls.some((u) => u.includes("empty-team"))).toBe(false);
  });

  it("inspect-user prints users' records with secrets hidden, and what create doesn't send", async () => {
    await firstRun();
    lines = [];
    const fetchFn = vi.fn<Fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith("/oauth2/token")) {
        return json(200, { access_token: "tok", expires_in: 3600 });
      }
      if (url.includes("/v2/users?page=0")) {
        return json(200, {
          _embedded: {
            users: [
              { user_id: "u1", user_name: "Jane.Doe" },
              { user_id: "u2", user_name: "bad" },
            ],
          },
          page: { total_pages: 2 },
        });
      }
      if (url.includes("/v2/users?page=1")) {
        return json(200, { _embedded: { users: [] }, page: { total_pages: 2 } });
      }
      if (url.endsWith("/v2/users/u2")) return json(500, {});
      return json(200, {
        user_id: "u1",
        user_name: "Jane.Doe",
        email_address: "jane@example.com",
        user_type: "VOSP",
        saml_user: false,
        login_question: "first pet?",
        login_answer: "rex",
        phone: "",
        roles: [{ role_name: "extcreator" }],
        permissions: [{ permission_name: "humanUser" }],
        teams: [
          { team_name: "Blue", relationship: "MEMBER" },
          { team_name: "Red", relationship: { name: "ADMIN", display_name: "Team Admin" } },
        ],
        _links: { self: { href: "x" } },
      });
    });
    expect(
      await run(
        ["inspect-user", "jane.doe", "bad", "ghost", "--connection", "ACME"],
        signIn,
        fetchFn,
      ),
    ).toBe(0);
    const text = output();
    expect(text).toContain("Reading from acme (EU). Read only; sign-in secrets hidden.");
    expect(text).toContain("  user_type: VOSP");
    expect(text).toContain("  saml_user: false");
    expect(text).toContain("  roles: extcreator");
    expect(text).toContain("  permissions: humanUser");
    expect(text).toContain("  teams: Blue (MEMBER), Red (ADMIN)");
    expect(text).toContain("  login_answer: (hidden)");
    expect(text).toContain("  phone: (empty)");
    expect(text).not.toContain("rex");
    expect(text).not.toContain("first pet");
    expect(text).not.toContain("_links");
    expect(text).toContain("bad: Reading the record failed (500): HTTP 500");
    expect(text).toContain("ghost: not found in the users list.");
    expect(text).toMatch(/doesn't send:\n {2}permissions, saml_user, user_id, user_type/);
    expect((await audit.latest(1))[0]).toMatchObject({
      action: "user.read",
      reason: "inspect-user",
    });

    // A refused users list ends with Veracode's message, not a crash.
    lines = [];
    const refused = vi.fn<Fetch>(async (input) =>
      String(input).endsWith("/oauth2/token")
        ? json(200, { access_token: "tok", expires_in: 3600 })
        : json(400, { message: "Invalid page size" }),
    );
    expect(await run(["inspect-user", "jane.doe"], signIn, refused)).toBe(1);
    expect(output()).toContain("Reading the users list failed (400): Invalid page size");

    expect(await run(["inspect-user"], signIn, fetchFn)).toBe(1);
    expect(output()).toContain("Say which users");
    expect(await run(["inspect-user", "x", "--connection", "nope"], signIn, fetchFn)).toBe(1);
    expect(output()).toContain("No connection named nope.");
  });

  it("inspect-user --email shows every user with that email address", async () => {
    await firstRun();
    lines = [];
    const users = [
      { user_id: "a", user_name: "one", email_address: "Shared@Example.com" },
      { user_id: "b", user_name: "two", email_address: "shared@example.com" },
      { user_id: "c", user_name: "three", email_address: "other@example.com" },
    ];
    const fetchFn = vi.fn<Fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith("/oauth2/token")) {
        return json(200, { access_token: "tok", expires_in: 3600 });
      }
      if (url.includes("/v2/users?page=")) {
        return json(200, { _embedded: { users }, page: { total_pages: 1 } });
      }
      const id = url.split("/").pop();
      return json(200, { ...users.find((u) => u.user_id === id), okta_user_id: "00u-secret" });
    });
    expect(
      await run(
        ["inspect-user", "--email", "shared@example.com", "--email", "nobody@example.com"],
        signIn,
        fetchFn,
      ),
    ).toBe(0);
    const text = output();
    expect(text).toMatch(/\none\n {2}email_address: Shared@Example.com/);
    expect(text).toMatch(/\ntwo\n {2}email_address: shared@example.com/);
    expect(text).not.toContain("\nthree\n");
    expect(text).toContain("  okta_user_id: (hidden)");
    expect(text).not.toContain("00u-secret");
    expect(text).toContain("Users with email nobody@example.com: not found in the users list.");
  });

  it("explains a missing connection", async () => {
    await firstRun();
    expect(await run(["inspect", "nope"], signIn)).toBe(1);
    expect(output()).toContain("No connection named nope.");
    await run(["remove", "acme"], [...signIn, "y"]);
    expect(await run(["inspect"], signIn)).toBe(1);
    expect(output()).toContain("No connections yet.");
  });
});

describe("npm run connect -- permissions", () => {
  it("lists each permission of the organization's roles once, sorted, read only", async () => {
    await firstRun();
    lines = [];
    const perm = (permission_name: string, permission_description: string) => ({
      permission_name,
      permission_description,
    });
    const fetchFn = vi.fn<Fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith("/oauth2/token"))
        return json(200, { access_token: "tok", expires_in: 3600 });
      if (url.includes("/v2/roles")) {
        return json(200, {
          _embedded: {
            roles: [
              {
                role_name: "a",
                permissions: [perm("viewReports", "View reports"), perm("vsa", "Manage VSA")],
              },
              { role_name: "b", permissions: [perm("viewReports", "View reports")] },
            ],
          },
          page: { total_pages: 1 },
        });
      }
      return json(404, {});
    });
    expect(await run(["permissions"], signIn, fetchFn)).toBe(0);
    expect(lines).toEqual([
      "Signed in as yaakov.",
      "2 permissions in acme (EU), read only:",
      "",
      "Manage VSA  (vsa)",
      "View reports  (viewReports)",
    ]);
    expect(fetchFn.mock.calls.filter(([u]) => !String(u).endsWith("/oauth2/token"))).toHaveLength(
      1,
    );
    expect(await audit.latest(5)).toContainEqual(
      expect.objectContaining({ action: "role.list", reason: "permissions" }),
    );
    lines = [];
    expect(await run(["permissions", "nope"], signIn, fetchFn)).toBe(1);
    expect(output()).toContain("No connection named nope.");
  });

  it("lists the roles with how the app groups them, read only", async () => {
    await firstRun();
    lines = [];
    const fetchFn = vi.fn<Fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith("/oauth2/token"))
        return json(200, { access_token: "tok", expires_in: 3600 });
      if (url.includes("/v2/roles")) {
        return json(200, {
          _embedded: {
            roles: [
              { role_name: "extreviewer", role_description: "Reviewer" },
              {
                role_name: "noteamrestrictionapi",
                role_description: "No Team Restriction API",
                is_api: true,
                ignore_team_restrictions: true,
              },
              {
                role_name: "custom-elearningadmin",
                role_description: "ELearning Admin",
                child_roles: [{ role_name: "elearning" }],
              },
              {
                role_name: "extsubmitstaticscan",
                role_description: "Static Scan",
                is_scan_type: true,
              },
            ],
          },
          page: { total_pages: 1 },
        });
      }
      return json(404, {});
    });
    expect(await run(["roles"], signIn, fetchFn)).toBe(0);
    expect(lines).toEqual([
      "Signed in as yaakov.",
      "4 roles in acme (EU), read only:",
      "",
      "ELearning Admin  (custom-elearningadmin)  [custom]  includes: elearning",
      "No Team Restriction API  (noteamrestrictionapi)  [API, all teams, team setting]",
      "Reviewer  (extreviewer)",
      "Static Scan  (extsubmitstaticscan)  [scan type]",
    ]);
    expect(fetchFn.mock.calls.filter(([u]) => !String(u).endsWith("/oauth2/token"))).toHaveLength(
      1,
    );
    expect(await audit.latest(5)).toContainEqual(
      expect.objectContaining({ action: "role.list", reason: "roles" }),
    );
  });
});
