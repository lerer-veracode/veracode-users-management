import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { ROLES, TEAMS, USERS } from "./mock/data";
import type { Connection, User } from "./types";

const NOW = new Date("2026-11-09T12:00:00Z");
const PASSWORD = "correct horse battery";
const inDays = (days: number) => new Date(NOW.getTime() + days * 86_400_000).toISOString();

type FakeEntry = Record<string, unknown> & { outcome: "ok" | "failed" };

const AUDIT: FakeEntry[] = [
  {
    time: NOW.toISOString(),
    actor: "yaakov",
    action: "auth.check",
    outcome: "ok",
    connection: { name: "acme", region: "US", client_id: "vrc_acme" },
    reason: "test",
    detail: "Connected: the credentials can read users.",
  },
  {
    time: inDays(-1),
    actor: "yaakov",
    action: "auth.token",
    outcome: "failed",
    connection: { name: "beta", region: "EU", client_id: "vrc_beta" },
    method: "POST",
    path: "api.veracode.eu/api/authn/v2/oauth2/token",
    status: 401,
  },
  { time: inDays(-2), actor: "dana", action: "app.sign_in", outcome: "ok" },
];

type FakeState = {
  audit: FakeEntry[];
  signedIn: boolean;
  notices: string[];
  usersError: string;
  connections: Connection[];
  users: User[];
  teams: typeof TEAMS;
  // The users read afresh with /api/users/read.
  reads: string[];
  // Set: /api/users sends a first view without details, and /api/users/details answers once
  // this promise settles (PLAN_CACHE phase 6).
  detailsGate: Promise<void> | null;
  // What the dashboard sent to each change route, and an error to answer with.
  sent: { path: string; body: unknown }[];
  changeError: string;
};

// An in-memory stand-in for the backend's /api routes.
const fakeBackend = () => {
  const state: FakeState = {
    audit: [...AUDIT],
    signedIn: false,
    notices: [],
    usersError: "",
    users: [...USERS],
    teams: [...TEAMS],
    reads: [],
    detailsGate: null,
    sent: [],
    changeError: "",
    connections: [
      {
        id: "c1",
        name: "acme",
        region: "US",
        client_id: "vrc_acme",
        added_at: inDays(-7),
        removes_at: inDays(23),
        token_expires: null,
        active: true,
      },
      {
        id: "c2",
        name: "beta",
        region: "EU",
        client_id: "vrc_beta",
        added_at: inDays(-27),
        removes_at: inDays(3),
        token_expires: null,
        active: false,
      },
    ],
  };
  const reply = (status: number, body?: unknown) =>
    new Response(body === undefined ? null : JSON.stringify(body), { status });

  const handler = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).split("?")[0] ?? "";
    const method = init?.method ?? "GET";
    if (path === "/api/session" && method === "POST") {
      const body: unknown = JSON.parse(String(init?.body));
      const ok =
        typeof body === "object" &&
        body !== null &&
        "password" in body &&
        body.password === PASSWORD;
      if (!ok) return reply(401, { error: "Wrong username or password." });
      state.signedIn = true;
      return reply(200, { username: "yaakov", notices: state.notices });
    }
    if (!state.signedIn) return reply(401, { error: "Sign in first." });
    if (path === "/api/session" && method === "DELETE") {
      state.signedIn = false;
      return reply(204);
    }
    if (path === "/api/session") return reply(200, { username: "yaakov", notices: [] });
    if (path === "/api/connections") {
      return reply(200, { connections: state.connections, notices: [] });
    }
    if (path === "/api/app-users") {
      return reply(200, [
        {
          username: "yaakov",
          added_at: inDays(-60),
          last_sign_in: NOW.toISOString(),
          removes_at: inDays(30),
        },
        {
          username: "dana",
          added_at: inDays(-24),
          last_sign_in: inDays(-24),
          removes_at: inDays(6),
        },
      ]);
    }
    const bodyId = (): unknown => {
      const body: unknown = JSON.parse(String(init?.body));
      return typeof body === "object" && body !== null && "id" in body ? body.id : null;
    };
    if (path === "/api/connections/use") {
      const target = bodyId();
      for (const c of state.connections) c.active = c.id === target;
      return reply(200, {});
    }
    if (path === "/api/connections/test") {
      const target = bodyId();
      const conn = state.connections.find((c) => c.id === target);
      if (conn?.name === "acme") {
        conn.token_expires = inDays(0.04);
        return reply(200, { ok: true, message: "Connected: the credentials can read users." });
      }
      return reply(200, { ok: false, message: "Signed in, but not allowed to read users (403)." });
    }
    if (path === "/api/users/details") {
      await state.detailsGate;
      const active = state.connections.find((c) => c.active);
      const connection = { id: active?.id, name: active?.name, region: active?.region };
      return reply(200, { connection, users: state.users, complete: true });
    }
    if (path === "/api/users" || path === "/api/roles" || path === "/api/teams") {
      if (state.usersError) return reply(502, { error: state.usersError });
      const active = state.connections.find((c) => c.active);
      if (!active) return reply(409, { error: "Choose a connection first." });
      const connection = { id: active.id, name: active.name, region: active.region };
      // Each connection has its own users; beta has only the first three.
      const users = active.name === "acme" ? state.users : state.users.slice(0, 3);
      return reply(
        200,
        path === "/api/users"
          ? state.detailsGate
            ? {
                connection,
                complete: false,
                users: users.map((u) => ({
                  ...u,
                  details_pending: true,
                  last_login: null,
                  locked: u.locked ?? "Details still loading.",
                })),
              }
            : { connection, users }
          : path === "/api/teams"
            ? { connection, teams: state.teams }
            : { connection, roles: ROLES },
      );
    }
    if (path === "/api/users/read") {
      const body: unknown = JSON.parse(String(init?.body));
      const id = typeof body === "object" && body !== null && "id" in body ? body.id : null;
      state.reads.push(String(id));
      const user = state.users.find((u) => u.user_id === id);
      return user ? reply(200, { user }) : reply(502, { error: "No such user" });
    }
    if (path.startsWith("/api/users/")) {
      const body: unknown = JSON.parse(String(init?.body));
      state.sent.push({ path, body });
      if (state.changeError) return reply(502, { error: state.changeError });
      const get = (k: string): unknown =>
        typeof body === "object" && body !== null
          ? Object.getOwnPropertyDescriptor(body, k)?.value
          : undefined;
      const id = get("id");
      if (path === "/api/users/delete") {
        state.users = state.users.filter((u) => u.user_id !== id);
        return reply(200, { deleted: "x" });
      }
      if (path === "/api/users/create") {
        const user = get("user");
        const email =
          typeof user === "object" && user !== null && "email_address" in user
            ? String(user.email_address)
            : "";
        return reply(200, { user_name: email });
      }
      return reply(200, {});
    }
    if (path === "/api/audit/page") {
      const body: unknown = JSON.parse(String(init?.body));
      const get = (k: string): unknown =>
        typeof body === "object" && body !== null
          ? Object.getOwnPropertyDescriptor(body, k)?.value
          : undefined;
      const page = Number(get("page"));
      const size = Number(get("size"));
      const all = state.audit.filter((e) => get("failed_only") !== true || e.outcome === "failed");
      return reply(200, { entries: all.slice((page - 1) * size, page * size), total: all.length });
    }
    return reply(404, { error: "Not found" });
  });
  return { state, handler };
};

let backend = fakeBackend();

const signIn = async () => {
  await userEvent.type(await screen.findByLabelText("Username"), "yaakov");
  await userEvent.click(screen.getByRole("button", { name: "Next" }));
  await userEvent.type(screen.getByLabelText("Password"), PASSWORD);
  await userEvent.click(screen.getByRole("button", { name: "Sign In" }));
  await screen.findByRole("button", { name: "Sign out" });
};

const go = async (hash: string) => {
  window.location.hash = hash;
  render(<App now={NOW} />);
  await signIn();
};

const navigate = (hash: string) => {
  window.location.hash = hash;
  window.dispatchEvent(new HashChangeEvent("hashchange"));
};

const orgName = (name: string) => screen.findByText(name, { selector: ".topbar-tools span" });

const tableRows = () => within(screen.getByRole("region", { name: "Users" })).getAllByRole("row");

beforeEach(() => {
  window.location.hash = "";
  backend = fakeBackend();
  vi.stubGlobal("fetch", backend.handler);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const openUser = async (user: ReturnType<typeof userEvent.setup>, name: string) => {
  await user.clear(screen.getByRole("textbox", { name: "Search users" }));
  await user.type(screen.getByRole("textbox", { name: "Search users" }), name);
  await user.click(screen.getByRole("button", { name }));
  return screen.getByRole("dialog", { name });
};

describe("changing users", () => {
  it("adds a user after a review, offering no Administrator or API role", async () => {
    const user = userEvent.setup();
    await go("#/users");
    await screen.findByText("1-10 of 23");
    await user.click(screen.getByRole("button", { name: "Add New User" }));
    const form = screen.getByRole("dialog", { name: "Add New User" });
    expect(within(form).getByText("acme (US)")).toBeInTheDocument();
    const roles = within(form).getByRole("group", { name: "Roles" });
    expect(within(roles).queryByRole("checkbox", { name: "Administrator" })).toBeNull();
    expect(within(roles).queryByRole("checkbox", { name: "Admin API" })).toBeNull();
    expect(within(roles).getByRole("checkbox", { name: "Reviewer" })).toBeInTheDocument();

    await user.click(within(form).getByRole("button", { name: "Review" }));
    expect(within(form).getByRole("alert")).toHaveTextContent("Enter a valid email address.");
    await user.type(within(form).getByLabelText("Email"), "new@example.com");
    await user.click(within(form).getByRole("button", { name: "Review" }));
    expect(within(form).getByRole("alert")).toHaveTextContent("Enter the first name.");
    await user.type(within(form).getByLabelText("First name"), "New");
    await user.click(within(form).getByRole("button", { name: "Review" }));
    expect(within(form).getByRole("alert")).toHaveTextContent("Enter the last name.");
    await user.type(within(form).getByLabelText("Last name"), "Person");
    await user.click(within(form).getByRole("button", { name: "Review" }));
    expect(within(form).getByRole("alert")).toHaveTextContent("Choose at least one role.");
    await user.click(within(roles).getByRole("checkbox", { name: "Reviewer" }));
    await user.click(within(roles).getByRole("checkbox", { name: "Creator" }));
    await user.click(within(roles).getByRole("checkbox", { name: "Creator" }));
    await user.click(within(form).getByRole("button", { name: "Review" }));

    const review = screen.getByRole("dialog", { name: "Add New User" });
    expect(within(review).getByText("acme (US)")).toBeInTheDocument();
    expect(within(review).getByRole("row", { name: "Roles Reviewer" })).toBeInTheDocument();
    expect(backend.state.sent).toEqual([]);
    await user.click(within(review).getByRole("button", { name: "Back" }));
    await user.click(screen.getByRole("button", { name: "Review" }));
    await user.click(screen.getByRole("button", { name: "Create user" }));

    expect(await screen.findByText("Created new@example.com in acme.")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(backend.state.sent).toEqual([
      {
        path: "/api/users/create",
        body: {
          connection_id: "c1",
          user: {
            email_address: "new@example.com",
            first_name: "New",
            last_name: "Person",
            roles: ["extreviewer"],
            teams: [],
            pin_required: true,
          },
        },
      },
    ]);
  });

  it("asks for scan types with Security Lead, Creator or Submitter, and teams for Team Admin", async () => {
    const user = userEvent.setup();
    await go("#/users");
    await screen.findByText("1-10 of 23");
    await user.click(screen.getByRole("button", { name: "Add New User" }));
    const form = screen.getByRole("dialog", { name: "Add New User" });
    await user.type(within(form).getByLabelText("Email"), "lead@example.com");
    await user.type(within(form).getByLabelText("First name"), "Lead");
    await user.type(within(form).getByLabelText("Last name"), "Person");
    // MFA is on by default for a new user.
    expect(within(form).getByRole("checkbox", { name: "Require MFA" })).toBeChecked();
    // Scan types are not among the roles, and show up once a role needs them.
    const roles = within(form).getByRole("group", { name: "Roles" });
    expect(within(roles).queryByRole("checkbox", { name: "Any Scan" })).toBeNull();
    expect(within(form).queryByRole("group", { name: "Scan types" })).toBeNull();
    await user.click(within(roles).getByRole("checkbox", { name: "Submitter" }));
    const scans = within(form).getByRole("group", { name: "Scan types" });
    await user.click(within(form).getByRole("button", { name: "Review" }));
    expect(within(form).getByRole("alert")).toHaveTextContent(/need a scan type/);

    await user.click(within(scans).getByRole("radio", { name: "Specific scan types" }));
    expect(within(scans).getByRole("checkbox", { name: "Container Scan" })).toBeInTheDocument();
    await user.click(within(scans).getByRole("checkbox", { name: "Static Scan" }));
    await user.click(within(scans).getByRole("checkbox", { name: "Dynamic Scan" }));
    await user.click(within(scans).getByRole("radio", { name: "All scan types" }));
    expect(within(scans).queryByRole("checkbox", { name: "Static Scan" })).toBeNull();
    await user.click(within(scans).getByRole("radio", { name: "Specific scan types" }));
    await user.click(within(scans).getByRole("checkbox", { name: "Static Scan" }));
    await user.click(within(scans).getByRole("checkbox", { name: "Container Scan" }));
    await user.click(within(form).getByRole("button", { name: "Review" }));
    expect(within(form).getByRole("alert")).toHaveTextContent(
      "This combination of roles requires the user to be in at least one team: choose one under Member of teams.",
    );

    // Member of teams: a dropdown of checkboxes.
    await user.click(within(form).getByRole("button", { name: "Member of teams" }));
    const memberOf = within(form).getByRole("group", { name: "Member of teams" });
    await user.click(within(memberOf).getByRole("checkbox", { name: "Red Team" }));
    await user.click(within(memberOf).getByRole("checkbox", { name: "Green Team" }));
    await user.keyboard("{Escape}");
    expect(within(form).queryByRole("group", { name: "Member of teams" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Add New User" })).toBeInTheDocument();
    expect(within(form).getByRole("button", { name: "Member of teams" })).toHaveTextContent(
      "Red Team, Green Team",
    );

    // Team Admin: managing teams is its own choice, and needs at least one.
    expect(within(form).queryByRole("button", { name: /Manages teams/ })).toBeNull();
    await user.click(within(roles).getByRole("checkbox", { name: "Team Admin" }));
    await user.click(within(form).getByRole("button", { name: "Review" }));
    expect(within(form).getByRole("alert")).toHaveTextContent(
      "Team Admin needs at least one team to manage.",
    );
    await user.click(within(form).getByRole("button", { name: /Manages teams/ }));
    const manages = within(form).getByRole("group", { name: /Manages teams/ });
    await user.click(within(manages).getByRole("checkbox", { name: "Blue Team" }));
    await user.click(within(manages).getByRole("checkbox", { name: "Green Team" }));
    // A managed team leaves the plain memberships.
    await user.click(within(form).getByRole("heading", { name: "Add New User" }));
    expect(within(form).getByRole("button", { name: "Member of teams" })).toHaveTextContent(
      "Red Team",
    );
    await user.click(within(form).getByRole("button", { name: "Review" }));

    const review = screen.getByRole("dialog", { name: "Add New User" });
    expect(
      within(review).getByRole("row", { name: "Roles Submitter, Team Admin" }),
    ).toBeInTheDocument();
    expect(
      within(review).getByRole("row", { name: "Scan types Static Scan, Container Scan" }),
    ).toBeInTheDocument();
    expect(
      within(review).getByRole("row", { name: "Member of teams Red Team" }),
    ).toBeInTheDocument();
    expect(
      within(review).getByRole("row", { name: "Manages teams Blue Team, Green Team" }),
    ).toBeInTheDocument();
    expect(within(review).getByRole("row", { name: "MFA Required" })).toBeInTheDocument();
    await user.click(within(review).getByRole("button", { name: "Create user" }));
    expect(await screen.findByText("Created lead@example.com in acme.")).toBeInTheDocument();
    expect(backend.state.sent.at(-1)?.body).toMatchObject({
      user: {
        roles: ["extsubmitter", "extsubmitstaticscan", "extsubmitcontainerscan", "teamAdmin"],
        teams: [
          { team_id: "t-blue", relationship: "ADMIN" },
          { team_id: "t-green", relationship: "ADMIN" },
          { team_id: "t-red", relationship: "MEMBER" },
        ],
        pin_required: true,
      },
    });
  });

  it("uses the email as the user name, or a different one if chosen", async () => {
    const user = userEvent.setup();
    await go("#/users");
    await screen.findByText("1-10 of 23");
    await user.click(screen.getByRole("button", { name: "Add New User" }));
    const form = screen.getByRole("dialog", { name: "Add New User" });
    const names = within(form).getByRole("group", { name: "User name" });
    expect(within(names).getByRole("radio", { name: "Same as email" })).toBeChecked();
    expect(within(form).queryByRole("textbox", { name: "User name" })).toBeNull();
    await user.type(within(form).getByLabelText("Email"), "jane@example.com");
    await user.type(within(form).getByLabelText("First name"), "Jane");
    await user.type(within(form).getByLabelText("Last name"), "Roe");
    await user.click(within(form).getByRole("checkbox", { name: "Reviewer" }));

    await user.click(within(names).getByRole("radio", { name: "A different user name" }));
    const field = within(form).getByRole("textbox", { name: "User name" });
    await user.click(within(form).getByRole("button", { name: "Review" }));
    expect(within(form).getByRole("alert")).toHaveTextContent(
      "Enter the user name, or use the email address.",
    );
    await user.type(field, "jane roe");
    await user.click(within(form).getByRole("button", { name: "Review" }));
    expect(within(form).getByRole("alert")).toHaveTextContent(/can't contain spaces/);
    await user.clear(field);
    await user.type(field, "MWEBB@example.com");
    await user.click(within(form).getByRole("button", { name: "Review" }));
    expect(within(form).getByRole("alert")).toHaveTextContent(
      "MWEBB@example.com is already a user name in acme.",
    );
    await user.clear(field);
    await user.type(field, "jroe");
    // Several users may share an email address: another user's email is fine.
    await user.clear(within(form).getByLabelText("Email"));
    await user.type(within(form).getByLabelText("Email"), "mwebb@example.com");
    await user.click(within(form).getByRole("button", { name: "Review" }));

    const review = screen.getByRole("dialog", { name: "Add New User" });
    expect(within(review).getByRole("row", { name: "User name jroe" })).toBeInTheDocument();
    expect(
      within(review).getByRole("row", { name: "Email mwebb@example.com" }),
    ).toBeInTheDocument();
    await user.click(within(review).getByRole("button", { name: "Create user" }));
    await screen.findByText(/Created/);
    expect(backend.state.sent.at(-1)?.body).toMatchObject({
      user: { user_name: "jroe", email_address: "mwebb@example.com" },
    });
  });

  it("edits teams, login and MFA, showing only what changed", async () => {
    const user = userEvent.setup();
    await go("#/users");
    await screen.findByText("1-10 of 23");
    // Marcus Webb is in Red Team, with login enabled and no MFA.
    const details = await openUser(user, "mwebb@example.com");
    expect(within(details).getByText("Not required")).toBeInTheDocument();
    await user.click(within(details).getByRole("button", { name: "Edit" }));
    const form = screen.getByRole("dialog", { name: "Edit mwebb@example.com" });
    const teams = within(form).getByRole("button", { name: "Member of teams" });
    expect(teams).toHaveTextContent("Red Team");
    await user.click(teams);
    const group = within(form).getByRole("group", { name: "Member of teams" });
    await user.click(within(group).getByRole("checkbox", { name: "Red Team" }));
    await user.click(within(group).getByRole("checkbox", { name: "Green Team" }));
    await user.click(within(form).getByRole("checkbox", { name: "Login enabled" }));
    await user.click(within(form).getByRole("checkbox", { name: "Require MFA" }));
    await user.click(within(form).getByRole("button", { name: "Review" }));
    const review = screen.getByRole("dialog", { name: "Edit mwebb@example.com" });
    expect(within(review).getAllByRole("row")).toHaveLength(4);
    expect(within(review).getByRole("row", { name: "Login Enabled Disabled" })).toBeInTheDocument();
    expect(
      within(review).getByRole("row", { name: "MFA Not required Required" }),
    ).toBeInTheDocument();
    expect(
      within(review).getByRole("row", { name: "Member of teams Red Team Green Team" }),
    ).toBeInTheDocument();
    await user.click(within(review).getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText(/Saved the changes to mwebb/)).toBeInTheDocument();
    expect(backend.state.sent.at(-1)?.body).toMatchObject({
      changes: {
        login_enabled: false,
        pin_required: true,
        teams: [{ team_id: "t-green", relationship: "MEMBER" }],
      },
    });
  });

  it("won't send an edit that leaves a Submitter with no team, unless a Security Lead", async () => {
    const user = userEvent.setup();
    await go("#/users");
    await screen.findByText("1-10 of 23");
    // Marcus Webb is a Reviewer in Red Team.
    const details = await openUser(user, "mwebb@example.com");
    await user.click(within(details).getByRole("button", { name: "Edit" }));
    const form = screen.getByRole("dialog", { name: "Edit mwebb@example.com" });
    const roles = within(form).getByRole("group", { name: "Roles" });
    await user.click(within(roles).getByRole("checkbox", { name: "Submitter" }));
    const scans = within(form).getByRole("group", { name: "Scan types" });
    await user.click(within(scans).getByRole("radio", { name: "All scan types" }));
    await user.click(within(form).getByRole("button", { name: "Member of teams" }));
    const group = within(form).getByRole("group", { name: "Member of teams" });
    await user.click(within(group).getByRole("checkbox", { name: "Red Team" }));
    await user.keyboard("{Escape}");
    const sent = backend.state.sent.length;
    await user.click(within(form).getByRole("button", { name: "Review" }));
    expect(within(form).getByRole("alert")).toHaveTextContent(
      "This combination of roles requires the user to be in at least one team: choose one under Member of teams.",
    );
    expect(backend.state.sent).toHaveLength(sent);

    // A Security Lead needs no team (docs/REALITY.md, entry 37).
    await user.click(within(roles).getByRole("checkbox", { name: "Security Lead" }));
    await user.click(within(form).getByRole("button", { name: "Review" }));
    const review = screen.getByRole("dialog", { name: "Edit mwebb@example.com" });
    await user.click(within(review).getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText(/Saved the changes to mwebb/)).toBeInTheDocument();
    expect(backend.state.sent.at(-1)?.body).toMatchObject({ changes: { teams: [] } });
  });

  it("refreshes teams from the form, and a save doesn't read roles or teams again", async () => {
    const user = userEvent.setup();
    await go("#/users");
    await screen.findByText("1-10 of 23");
    const calls = () => backend.handler.mock.calls.map(([input]) => String(input));
    const details = await openUser(user, "mwebb@example.com");
    await user.click(within(details).getByRole("button", { name: "Edit" }));
    const form = screen.getByRole("dialog", { name: "Edit mwebb@example.com" });

    // A team made on the Platform since the page loaded.
    backend.state.teams.push({ team_id: "t-purple", team_name: "Purple Team" });
    await user.click(within(form).getByRole("button", { name: "Member of teams" }));
    expect(within(form).queryByRole("checkbox", { name: "Purple Team" })).toBeNull();
    await user.keyboard("{Escape}");
    await user.click(within(form).getByRole("button", { name: "↻ Refresh teams" }));
    expect(await within(form).findByText("Teams refreshed.")).toBeInTheDocument();
    expect(calls()).toContain("/api/teams?refresh=1");
    await user.click(within(form).getByRole("button", { name: "Member of teams" }));
    await user.click(within(form).getByRole("checkbox", { name: "Purple Team" }));
    await user.keyboard("{Escape}");

    const before = calls().length;
    await user.click(within(form).getByRole("button", { name: "Review" }));
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText(/Saved the changes to mwebb/)).toBeInTheDocument();
    await waitFor(() => expect(calls().slice(before)).toContain("/api/users"));
    const after = calls().slice(before);
    expect(after.filter((u) => u.includes("refresh=1"))).toEqual([]);
  });

  it("reads a user afresh when their details or the edit form open", async () => {
    const user = userEvent.setup();
    await go("#/users");
    await screen.findByText("1-10 of 23");
    // Changed on the Platform after the list was read.
    const i = backend.state.users.findIndex((u) => u.user_name === "mwebb@example.com");
    const was = backend.state.users[i];
    if (!was) throw new Error("no mwebb");
    backend.state.users[i] = { ...was, last_name: "Webb-Fresh" };

    const details = await openUser(user, "mwebb@example.com");
    expect(await within(details).findByText("Marcus Webb-Fresh")).toBeInTheDocument();
    expect(backend.state.reads).toEqual([was.user_id]);
    // Edit from the details: it already has the fresh copy.
    await user.click(within(details).getByRole("button", { name: "Edit" }));
    const form = screen.getByRole("dialog", { name: "Edit mwebb@example.com" });
    expect(within(form).getByLabelText("Last name")).toHaveValue("Webb-Fresh");
    expect(backend.state.reads).toHaveLength(1);
    await user.click(within(form).getByRole("button", { name: "Cancel" }));
    await user.keyboard("{Escape}");

    // Edit from the Actions menu reads the user first.
    await user.click(screen.getByRole("button", { name: "Actions for mwebb@example.com" }));
    await user.click(screen.getByRole("menuitem", { name: "Edit" }));
    const again = await screen.findByRole("dialog", { name: "Edit mwebb@example.com" });
    expect(within(again).getByLabelText("Last name")).toHaveValue("Webb-Fresh");
    expect(backend.state.reads).toHaveLength(2);
  });

  it("disables and enables login from the Actions menu, after a confirmation", async () => {
    const user = userEvent.setup();
    await go("#/users");
    await screen.findByText("1-10 of 23");
    await user.type(screen.getByRole("textbox", { name: "Search users" }), "mwebb");
    await user.click(screen.getByRole("button", { name: "Actions for mwebb@example.com" }));
    await user.click(screen.getByRole("menuitem", { name: "Disable login" }));
    const dialog = screen.getByRole("dialog", { name: "Disable login for mwebb@example.com" });
    expect(dialog).toHaveTextContent("won't be able to sign in to Veracode");
    expect(within(dialog).getByText("acme (US)")).toBeInTheDocument();
    expect(backend.state.sent).toEqual([]);
    backend.state.changeError = "Changing the user failed (500): Server error";
    await user.click(within(dialog).getByRole("button", { name: "Disable login" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Server error");
    backend.state.changeError = "";
    await user.click(within(dialog).getByRole("button", { name: "Disable login" }));
    expect(
      await screen.findByText("Disabled login for mwebb@example.com in acme."),
    ).toBeInTheDocument();
    expect(backend.state.sent.at(-1)).toEqual({
      path: "/api/users/update",
      body: { connection_id: "c1", id: USERS[3]?.user_id, changes: { login_enabled: false } },
    });

    // Tom Becker's login is disabled: the menu offers to enable it. Cancel changes nothing.
    await user.clear(screen.getByRole("textbox", { name: "Search users" }));
    await user.type(screen.getByRole("textbox", { name: "Search users" }), "tbecker");
    await user.click(screen.getByRole("button", { name: "Actions for tbecker@example.com" }));
    await user.click(screen.getByRole("menuitem", { name: "Enable login" }));
    const enable = screen.getByRole("dialog", { name: "Enable login for tbecker@example.com" });
    expect(enable).toHaveTextContent("will be able to sign in to Veracode again");
    await user.click(within(enable).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(backend.state.sent).toHaveLength(2);

    // The menu also opens Edit and Delete; for a locked user they're disabled.
    await user.click(screen.getByRole("button", { name: "Actions for tbecker@example.com" }));
    await user.click(screen.getByRole("menuitem", { name: "Edit" }));
    expect(screen.getByRole("dialog", { name: "Edit tbecker@example.com" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.click(screen.getByRole("button", { name: "Actions for tbecker@example.com" }));
    await user.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(screen.getByRole("dialog", { name: "Delete tbecker@example.com" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.clear(screen.getByRole("textbox", { name: "Search users" }));
    await user.type(screen.getByRole("textbox", { name: "Search users" }), "ylerer");
    await user.click(screen.getByRole("button", { name: "Actions for ylerer@example.com" }));
    for (const name of ["Edit", "Disable login", "Delete"]) {
      expect(screen.getByRole("menuitem", { name })).toBeDisabled();
    }
  });

  it("can't edit or delete an administrator, an API account or a SAML user", async () => {
    const user = userEvent.setup();
    await go("#/users");
    await screen.findByText("1-10 of 23");
    for (const [name, why] of [
      ["ylerer@example.com", "has the Administrator role"],
      ["api_aautomation", "is an API account"],
      ["pnair@example.com", "is a SAML account"],
    ] as const) {
      const details = await openUser(user, name);
      expect(within(details).getByRole("note")).toHaveTextContent(why);
      expect(within(details).getByRole("button", { name: "Edit" })).toBeDisabled();
      expect(within(details).getByRole("button", { name: "Delete" })).toBeDisabled();
      await user.keyboard("{Escape}");
    }
  });

  it("deletes a user only after the user name is typed", async () => {
    const user = userEvent.setup();
    await go("#/users");
    await screen.findByText("1-10 of 23");
    const details = await openUser(user, "mwebb@example.com");
    await user.click(within(details).getByRole("button", { name: "Delete" }));
    const dialog = screen.getByRole("dialog", { name: "Delete mwebb@example.com" });
    expect(within(dialog).getByText("acme (US)")).toBeInTheDocument();
    const button = within(dialog).getByRole("button", { name: "Delete user" });
    const input = within(dialog).getByLabelText(/to confirm/);
    await user.type(input, "mwebb");
    expect(button).toBeDisabled();
    await user.type(input, "@example.com");
    backend.state.changeError = "Deleting the user failed (500): Server error";
    await user.click(button);
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Server error");
    backend.state.changeError = "";
    await user.click(button);
    expect(await screen.findByText("Deleted mwebb@example.com from acme.")).toBeInTheDocument();
    expect(backend.state.sent.at(-1)).toEqual({
      path: "/api/users/delete",
      body: { connection_id: "c1", id: USERS[3]?.user_id, confirm: "mwebb@example.com" },
    });
    expect(await screen.findByText("No users match these filters.")).toBeInTheDocument();
    await user.clear(screen.getByRole("textbox", { name: "Search users" }));
    expect(screen.getByText("1-10 of 22")).toBeInTheDocument();

    const again = await openUser(user, "lfischer@example.com");
    await user.click(within(again).getByRole("button", { name: "Delete" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    // Cancelling goes back to the user's details.
    expect(screen.getByRole("dialog", { name: "lfischer@example.com" })).toBeInTheDocument();
    expect(backend.state.sent).toHaveLength(2);
  });
});

describe("users page", () => {
  it("shows the organization's real users", async () => {
    await go("#/users");
    expect(screen.getByRole("heading", { name: "All Users" })).toBeInTheDocument();
    expect(await screen.findByText("1-10 of 23")).toBeInTheDocument();
    expect(tableRows()).toHaveLength(11);
    expect(await orgName("acme")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add New User" })).toBeEnabled();
  });

  it("shows the users first, then fills in last login, type and MFA", async () => {
    let release = () => {};
    backend.state.detailsGate = new Promise((resolve) => (release = resolve));
    await go("#/users");
    expect(await screen.findByText("1-10 of 23")).toBeInTheDocument();
    expect(
      screen.getByText("Reading last login, type and MFA from Veracode..."),
    ).toBeInTheDocument();
    const firstRow = tableRows()[1] as HTMLElement;
    expect(within(firstRow).getAllByText("…")).toHaveLength(2);
    release();
    await waitFor(() =>
      expect(screen.queryByText("Reading last login, type and MFA from Veracode...")).toBeNull(),
    );
    expect(within(tableRows()[1] as HTMLElement).queryAllByText("…")).toHaveLength(0);
  });

  it("filters, clears and pages", async () => {
    const user = userEvent.setup();
    await go("#/users");
    await screen.findByText("1-10 of 23");
    await user.click(screen.getByRole("checkbox", { name: "API" }));
    expect(screen.getByText("1-3 of 3")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /User Type=API/ }));
    await user.click(screen.getByRole("radio", { name: "Inactive" }));
    expect(screen.getByText("1-3 of 3")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Clear All" }));
    await user.type(screen.getByRole("textbox", { name: "Search users" }), "zzz");
    expect(screen.getByText("No users match these filters.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Search=zzz/ }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Role" }), "adminapi");
    expect(screen.getByText("api_aautomation")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Role=adminapi/ }));
    await user.click(screen.getByRole("button", { name: "Next page" }));
    expect(screen.getByText("11-20 of 23")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Last page" }));
    expect(screen.getByText("21-23 of 23")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Previous page" }));
    await user.click(screen.getByRole("button", { name: "First page" }));
    await user.selectOptions(screen.getByRole("combobox", { name: /Rows per page/ }), "25");
    expect(screen.getByText("1-23 of 23")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Email/ }));
    await user.click(screen.getByRole("button", { name: /Email/ }));
    expect(screen.getByRole("columnheader", { name: /Email/ })).toHaveAttribute(
      "aria-sort",
      "descending",
    );
    await user.click(screen.getByRole("button", { name: "Filters" }));
    expect(screen.queryByRole("complementary", { name: "Filters" })).not.toBeInTheDocument();
  });

  it("shows a user's roles, the permissions they grant, direct permissions and teams", async () => {
    const user = userEvent.setup();
    await go("#/users");
    await screen.findByText("1-10 of 23");
    await user.type(screen.getByRole("textbox", { name: "Search users" }), "Lerer");
    await user.click(screen.getByRole("button", { name: "ylerer@example.com" }));
    const dialog = screen.getByRole("dialog", { name: "ylerer@example.com" });
    expect(within(dialog).getByText("Yaakov Lerer")).toBeInTheDocument();
    expect(within(dialog).getByText("Administrator")).toBeInTheDocument();
    expect(within(dialog).getByText("Manage users")).toBeInTheDocument();
    expect(within(dialog).getByText("Security Lead")).toBeInTheDocument();
    expect(within(dialog).getByText("Manage applications")).toBeInTheDocument();
    // Only a member: no "Manages teams" for someone who isn't a Team Admin.
    expect(within(dialog).getByText("Member of teams").nextSibling).toHaveTextContent("Blue Team");
    expect(within(dialog).queryByText("Manages teams")).toBeNull();
    expect(within(dialog).getByText("None.")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Close" }));

    await user.clear(screen.getByRole("textbox", { name: "Search users" }));
    await user.click(screen.getByRole("button", { name: "Actions for api_aautomation" }));
    await user.click(screen.getByRole("menuitem", { name: "View details" }));
    const api = screen.getByRole("dialog", { name: "api_aautomation" });
    expect(within(api).getByText("Access Admin API")).toBeInTheDocument();
    expect(within(api).getByText("API user")).toBeInTheDocument();
    expect(within(api).getByText("Red Team")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    // A click inside keeps it open; a click outside, or the corner button, closes it.
    await user.click(screen.getByRole("button", { name: "api_aautomation" }));
    await user.click(screen.getByRole("heading", { name: "Teams" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await user.click(screen.getByTestId("dialog-backdrop"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "api_aautomation" }));
    await user.click(screen.getByRole("button", { name: "Close dialog" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("shows scan types and API team restrictions as settings, as the Platform does", async () => {
    const user = userEvent.setup();
    await go("#/users");
    await screen.findByText("1-10 of 23");
    const search = screen.getByRole("textbox", { name: "Search users" });
    const details = async (name: string) => {
      await user.clear(search);
      await user.type(search, name.slice(0, 6));
      expect(screen.getByRole("row", { name: new RegExp(name) })).not.toHaveTextContent(
        /Any Scan|Static Scan|No Team Restriction API/,
      );
      await user.click(screen.getByRole("button", { name }));
      return screen.getByRole("dialog", { name });
    };
    const setting = (dialog: HTMLElement, label: string) =>
      within(dialog).getByText(label).nextSibling;

    // All scan types: a setting, not the "Any Scan" role, in the table and the details.
    let dialog = await details("dcohen@example.com");
    expect(setting(dialog, "Allowed scan types")).toHaveTextContent("All");
    expect(within(dialog).queryByText("Any Scan")).toBeNull();
    await user.keyboard("{Escape}");

    dialog = await details("kmensah@example.com");
    expect(setting(dialog, "Allowed scan types")).toHaveTextContent("Static Scan, Container Scan");
    expect(within(dialog).getByText("Submitter")).toBeInTheDocument();
    await user.keyboard("{Escape}");

    // An API account: its team setting, and no scan types.
    dialog = await details("api_rreader");
    expect(setting(dialog, "Team memberships")).toHaveTextContent("No team restrictions");
    expect(within(dialog).queryByText("No Team Restriction API")).toBeNull();
    expect(within(dialog).queryByText("Allowed scan types")).toBeNull();
    await user.keyboard("{Escape}");

    await user.clear(search);

    // Filters: the Role list has no scan types; Scan Types finds who may submit them.
    const roleFilter = screen.getByRole("combobox", { name: "Role" });
    expect(within(roleFilter).queryByRole("option", { name: "Any Scan" })).toBeNull();
    await user.selectOptions(screen.getByRole("combobox", { name: "Scan type" }), "all");
    expect(screen.getByText("1-6 of 6")).toBeInTheDocument();
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Scan type" }),
      "extsubmitstaticscan",
    );
    expect(screen.getByText("1-7 of 7")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Scan Type=Static Scan/ }));
    expect(screen.getByText("1-10 of 23")).toBeInTheDocument();
  });

  it("explains a Veracode error and tries again", async () => {
    const user = userEvent.setup();
    backend.state.usersError = "The acme connection is not allowed to do this (403).";
    await go("#/users");
    expect(await screen.findByText(/not allowed to do this/)).toBeInTheDocument();
    backend.state.usersError = "";
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("1-10 of 23")).toBeInTheDocument();
  });

  it("refreshes, and shows notices from the Actions menu", async () => {
    const user = userEvent.setup();
    await go("#/users");
    await screen.findByText("1-10 of 23");
    await user.click(screen.getByRole("button", { name: "Actions" }));
    await user.click(screen.getByRole("heading", { name: "All Users" }));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Refresh" }));
    expect(await screen.findByText("1-10 of 23")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Export to CSV" }));
    expect(screen.getByRole("status")).toHaveTextContent("Export is not built yet.");
    await user.click(screen.getByRole("button", { name: "Actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Import from CSV" }));
    expect(window.location.hash).toBe("#/import");
  });
});

describe("choosing the connection", () => {
  it("shows clearly which connection the users come from, and switches", async () => {
    const user = userEvent.setup();
    await go("#/users");
    const bar = screen.getByRole("region", { name: "Connection" });
    expect(await within(bar).findByText("acme")).toBeInTheDocument();
    expect(within(bar).getByText(/Users from/)).toBeInTheDocument();
    expect(within(bar).getByText("US")).toBeInTheDocument();
    expect(await screen.findByText("1-10 of 23")).toBeInTheDocument();

    await user.selectOptions(within(bar).getByRole("combobox"), "beta (EU)");
    expect(await within(bar).findByText("beta")).toBeInTheDocument();
    expect(await screen.findByText("1-3 of 3")).toBeInTheDocument();
    expect(await orgName("beta")).toBeInTheDocument();

    await user.click(screen.getAllByRole("button", { name: /@example.com$/ })[0] as HTMLElement);
    expect(within(screen.getByRole("dialog")).getByText("beta (EU)")).toBeInTheDocument();
  });

  it("asks for a connection when several exist and none is chosen", async () => {
    const user = userEvent.setup();
    for (const c of backend.state.connections) c.active = false;
    await go("#/users");
    expect(await screen.findByText("Choose a connection to see its users.")).toBeInTheDocument();
    // The table's prompt follows the picker's once the connections have loaded: wait for it.
    expect(
      await screen.findByText("Choose a connection above to see its users."),
    ).toBeInTheDocument();
    expect(await orgName("Choose a connection")).toBeInTheDocument();
    const bar = screen.getByRole("region", { name: "Connection" });
    await user.selectOptions(within(bar).getByRole("combobox"), "acme (US)");
    expect(await screen.findByText("1-10 of 23")).toBeInTheDocument();
  });

  it("says when there are no connections at all", async () => {
    backend.state.connections = [];
    await go("#/import");
    expect(await screen.findByText(/No connections yet/)).toBeInTheDocument();
    expect(
      within(screen.getByRole("region", { name: "Connection" })).getByRole("combobox"),
    ).toBeDisabled();
  });

  it("ignores an answer from a connection that is no longer chosen", async () => {
    await go("#/users");
    await screen.findByText("1-10 of 23");
    const original = backend.handler.getMockImplementation();
    backend.handler.mockImplementation(async (input, init) => {
      if (String(input).split("?")[0] === "/api/users") {
        return new Response(JSON.stringify({ connection: { id: "other" }, users: [] }), {
          status: 200,
        });
      }
      return original?.(input, init) ?? new Response(null, { status: 500 });
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Refresh" }));
    expect(
      await screen.findByText("The connection changed. Refresh to try again."),
    ).toBeInTheDocument();
  });
});

describe("import page", () => {
  const csv = [
    "user_name,email_address,first_name,last_name,roles",
    "dcohen@example.com,dcohen@example.com,Dana,Cohen,extseclead",
    "new,new@example.com,New,Person,extreviewer",
    ",bad@example.com,Bad,Row,extreviewer",
  ].join("\n");

  it("previews a CSV against the real users and roles; applying comes next", async () => {
    const user = userEvent.setup();
    await go("#/import");
    await user.upload(screen.getByLabelText("CSV file"), new File([csv], "users.csv"));
    expect(await screen.findByText("users.csv")).toBeInTheDocument();
    expect(await screen.findByText("1 to create")).toBeInTheDocument();
    expect(screen.getByText("1 to update")).toBeInTheDocument();
    expect(screen.getByText("1 with errors")).toBeInTheDocument();
    expect(screen.getByText("User name is required")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Apply 2 Changes" })).toBeDisabled();
  });

  it("reports a file with missing columns, and a Veracode error", async () => {
    const user = userEvent.setup();
    backend.state.usersError = "Could not reach Veracode: offline";
    await go("#/import");
    expect(await screen.findByText("Could not reach Veracode: offline")).toBeInTheDocument();
    await user.upload(screen.getByLabelText("CSV file"), new File(["name\nx"], "bad.csv"));
    expect(await screen.findByText(/Missing columns/)).toBeInTheDocument();
  });
});

describe("connections page", () => {
  it("lists the vault's connections and app users, tests and switches them", async () => {
    const user = userEvent.setup();
    await go("#/connections");
    expect(await screen.findByRole("cell", { name: "acme" })).toBeInTheDocument();
    expect(await orgName("acme")).toBeInTheDocument();
    expect(screen.getByText("npm run connect")).toBeInTheDocument();
    expect(screen.queryByLabelText(/secret/i)).not.toBeInTheDocument();
    expect(screen.getByText("23 days left")).toBeInTheDocument();
    expect(screen.getByText("3 days left")).toBeInTheDocument();
    expect(await screen.findByRole("cell", { name: "dana" })).toBeInTheDocument();
    expect(screen.getByText("6 days left")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Test acme" }));
    expect(await screen.findByText("Connected")).toBeInTheDocument();
    expect(await screen.findByText(/^Valid until/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Test beta" }));
    expect(await screen.findByText("Failed")).toBeInTheDocument();
    expect(screen.getByText(/not allowed to read users/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Use beta" }));
    expect(await orgName("beta")).toBeInTheDocument();
  });

  it("shows when there are no connections, and sign-in notices", async () => {
    backend.state.connections = [];
    backend.state.notices = ["Removed acme after 30 days and revoked it on Veracode."];
    await go("#/connections");
    expect(await screen.findByText(/No connections yet/)).toBeInTheDocument();
    expect(await orgName("No connection")).toBeInTheDocument();
    expect(
      screen.getByText("Removed acme after 30 days and revoked it on Veracode."),
    ).toBeInTheDocument();
  });

  it("returns to sign-in when the session ends", async () => {
    await go("#/users");
    backend.state.signedIn = false;
    navigate("#/connections");
    expect(await screen.findByRole("form", { name: "Sign in" })).toBeInTheDocument();
  });

  it("returns to sign-in when an action finds the session ended", async () => {
    const user = userEvent.setup();
    await go("#/connections");
    await screen.findByRole("cell", { name: "acme" });
    backend.state.signedIn = false;
    await user.click(screen.getByRole("button", { name: "Use beta" }));
    expect(await screen.findByRole("form", { name: "Sign in" })).toBeInTheDocument();
  });

  it("shows a server error", async () => {
    await go("#/users");
    backend.handler.mockImplementation(async () => new Response("oops", { status: 500 }));
    navigate("#/connections");
    expect((await screen.findAllByText("Request failed (500).")).length).toBeGreaterThan(0);
  });
});

describe("activity page", () => {
  it("shows who changed a user, which user, and each field from and to", async () => {
    backend.state.audit = [
      {
        time: NOW.toISOString(),
        actor: "yaakov",
        action: "user.update",
        outcome: "ok",
        connection: { name: "acme", region: "US", client_id: "vrc_acme" },
        reason: "update jdoe: last_name, login_enabled",
        target: { user_id: "u1", user_name: "jdoe@example.com" },
        changes: [
          { field: "Last name", from: "Doe", to: "Smith" },
          { field: "Login", from: "Enabled", to: "Disabled" },
        ],
      },
      {
        time: inDays(-1),
        actor: "dana",
        action: "user.create",
        outcome: "failed",
        target: { user_name: "new@example.com" },
        changes: [{ field: "Roles", from: null, to: "Reviewer" }],
      },
    ];
    await go("#/activity");
    const rows = within(await screen.findByRole("table"))
      .getAllByRole("row")
      .slice(1);
    const [update, create] = rows as [HTMLElement, HTMLElement];
    expect(within(update).getByText("yaakov")).toBeInTheDocument();
    expect(within(update).getByText("jdoe@example.com")).toBeInTheDocument();
    const changes = within(update).getByRole("list", { name: "Changes" });
    expect(
      within(changes)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["Last name: Doe → Smith", "Login: Enabled → Disabled"]);
    expect(within(create).getByText("dana")).toBeInTheDocument();
    expect(within(create).getByText("Failed")).toBeInTheDocument();
    expect(within(create).getByRole("listitem")).toHaveTextContent("Roles: — → Reviewer");
  });

  it("shows why each call was made, how long it took and what came back", async () => {
    backend.state.audit = [
      {
        time: NOW.toISOString(),
        actor: "yaakov",
        action: "user.list",
        outcome: "ok",
        purpose: "Load the users list: users of a role, for last login and user type",
        method: "GET",
        path: "api.veracode.com/api/authn/v2/users/by_role/r1",
        status: 200,
        ms: 3140,
        result: "23 users",
      },
      {
        time: inDays(-1),
        actor: "yaakov",
        action: "auth.token",
        outcome: "ok",
        purpose: "Get an access token",
        ms: 420,
      },
    ];
    await go("#/activity");
    const rows = within(await screen.findByRole("table"))
      .getAllByRole("row")
      .slice(1);
    const [list, token] = rows as [HTMLElement, HTMLElement];
    expect(
      within(list).getByText("Load the users list: users of a role, for last login and user type"),
    ).toBeInTheDocument();
    expect(
      within(list).getByText(
        "Took 3.1 s · Got 23 users · GET api.veracode.com/api/authn/v2/users/by_role/r1 -> 200",
      ),
    ).toBeInTheDocument();
    expect(within(token).getByText("Took 420 ms")).toBeInTheDocument();
  });

  it("shows the audit log, newest first, and filters to failures", async () => {
    const user = userEvent.setup();
    await go("#/activity");
    const table = await screen.findByRole("table");
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.map((r) => within(r).getAllByRole("cell")[2]?.textContent)).toEqual([
      "auth.check",
      "auth.token",
      "app.sign_in",
    ]);
    expect(within(rows[0] as HTMLElement).getByText("acme (US)")).toBeInTheDocument();
    expect(
      within(rows[0] as HTMLElement).getByText(
        "Reason: test · Connected: the credentials can read users.",
      ),
    ).toBeInTheDocument();
    expect(
      within(rows[1] as HTMLElement).getByText(
        "POST api.veracode.eu/api/authn/v2/oauth2/token -> 401",
      ),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("checkbox", { name: "Failed only" }));
    await screen.findByText("1-1 of 1");
    expect(within(screen.getByRole("table")).getAllByRole("row")).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByRole("table")).toBeInTheDocument();
  });

  it("pages the log, 50 at a time by default, with 100 and 500 to choose", async () => {
    const user = userEvent.setup();
    backend.state.audit = Array.from({ length: 120 }, (_, i) => ({
      time: inDays(-i / 100),
      actor: "yaakov",
      action: `test.${i}`,
      outcome: "ok" as const,
    }));
    await go("#/activity");
    expect(await screen.findByText("1-50 of 120")).toBeInTheDocument();
    expect(screen.getAllByRole("row")).toHaveLength(51);
    const sizes = screen.getByRole("combobox", { name: /Rows per page/ });
    expect(
      within(sizes)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["50", "100", "500"]);
    await user.click(screen.getByRole("button", { name: "Last page" }));
    expect(await screen.findByText("101-120 of 120")).toBeInTheDocument();
    expect(screen.getByText("test.119")).toBeInTheDocument();
    await user.selectOptions(screen.getByRole("combobox", { name: /Rows per page/ }), "500");
    expect(await screen.findByText("1-120 of 120")).toBeInTheDocument();
  });

  it("asks for a date range to export, and says export isn't built yet", async () => {
    const user = userEvent.setup();
    await go("#/activity");
    await user.click(screen.getByRole("button", { name: "Export" }));
    const dialog = screen.getByRole("dialog", { name: "Export Activity" });
    expect(within(dialog).getByLabelText("From")).toHaveValue("2026-11-03");
    expect(within(dialog).getByLabelText("To")).toHaveValue("2026-11-09");

    await user.clear(within(dialog).getByLabelText("From"));
    await user.click(within(dialog).getByRole("button", { name: "Export" }));
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Choose both dates.");
    await user.type(within(dialog).getByLabelText("From"), "2026-11-10");
    await user.click(within(dialog).getByRole("button", { name: "Export" }));
    expect(within(dialog).getByRole("alert")).toHaveTextContent("on or before the end date");
    await user.clear(within(dialog).getByLabelText("From"));
    await user.type(within(dialog).getByLabelText("From"), "2026-11-01");
    await user.click(within(dialog).getByRole("button", { name: "Export" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Export isn't built yet. It will save the entries from 2026-11-01 to 2026-11-09 as a file.",
    );

    await user.click(screen.getByRole("button", { name: "Export" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("shows an empty log, an error, and returns to sign-in when the session ends", async () => {
    await go("#/users");
    const original = backend.handler.getMockImplementation();
    backend.handler.mockImplementation(async (input, init) =>
      String(input) === "/api/audit/page"
        ? new Response(JSON.stringify({ entries: [], total: 0 }), { status: 200 })
        : (original?.(input, init) ?? new Response(null, { status: 500 })),
    );
    navigate("#/activity");
    expect(await screen.findByText("No activity yet.")).toBeInTheDocument();

    const user = userEvent.setup();
    backend.handler.mockImplementation(async () => new Response("oops", { status: 500 }));
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    expect((await screen.findAllByText("Request failed (500).")).length).toBeGreaterThan(0);

    backend.handler.mockImplementation(async () => new Response("{}", { status: 401 }));
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByRole("form", { name: "Sign in" })).toBeInTheDocument();
  });
});

describe("sign in", () => {
  it("shows the un-official sign-in, checks the password with the backend and signs out", async () => {
    const user = userEvent.setup();
    render(<App now={NOW} />);
    expect((await screen.findAllByText(/un-official/i)).length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Enter your username.");
    await user.type(screen.getByLabelText("Username"), "yaakov");
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(screen.getByRole("button", { name: "Sign In" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Enter your password.");
    await user.click(screen.getByRole("button", { name: "Change" }));
    expect(screen.getByLabelText("Username")).toHaveValue("yaakov");
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.type(screen.getByLabelText("Password"), "wrong password");
    await user.click(screen.getByRole("button", { name: "Sign In" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Wrong username or password.");
    expect(screen.getByLabelText("Password")).toHaveValue("");
    await user.type(screen.getByLabelText("Password"), PASSWORD);
    await user.click(screen.getByRole("button", { name: "Sign In" }));
    expect(await screen.findByRole("heading", { name: "All Users" })).toBeInTheDocument();
    expect(screen.getByText("Un-official")).toBeInTheDocument();
    expect(screen.getByText("yaakov")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Sign out" }));
    expect(await screen.findByRole("form", { name: "Sign in" })).toBeInTheDocument();
    expect(backend.state.signedIn).toBe(false);
  });

  it("skips the sign-in page when a session is still open", async () => {
    backend.state.signedIn = true;
    render(<App now={NOW} />);
    expect(await screen.findByRole("heading", { name: "All Users" })).toBeInTheDocument();
  });

  it("falls back to sign-in when the backend is down", async () => {
    backend.handler.mockImplementation(async () => {
      throw new Error("offline");
    });
    render(<App now={NOW} />);
    expect(await screen.findByRole("form", { name: "Sign in" })).toBeInTheDocument();
  });
});
