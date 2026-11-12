import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

// A stand-in for the Veracode Identity API, running on this machine, so end-to-end tests never
// call the real one. Users created, changed or deleted here live only in memory.
type FakeUser = Record<string, unknown> & { user_id: string };

// Like the real one: a team's relationship is sent as "ADMIN" or "MEMBER", and read back as
// { name, display_name } (docs/REALITY.md, entry 38).
const relationship = (name: string) => ({
  name,
  display_name: name === "ADMIN" ? "Team Admin" : "Member",
});

const USERS: FakeUser[] = [
  {
    user_id: "u0",
    user_name: "boss@example.com",
    first_name: "Big",
    last_name: "Boss",
    email_address: "boss@example.com",
    active: true,
    roles: [{ role_name: "extadmin", role_description: "Administrator" }],
  },
  {
    user_id: "u1",
    user_name: "alice@example.com",
    first_name: "Alice",
    last_name: "Adams",
    email_address: "alice@example.com",
    active: true,
    login_enabled: true,
    last_login: "2026-11-01T10:00:00Z",
    roles: [{ role_name: "extseclead", role_description: "Security Lead" }],
    teams: [{ team_id: "t1", team_name: "Blue Team", relationship: relationship("MEMBER") }],
  },
  {
    user_id: "u2",
    user_name: "api_ci",
    first_name: "CI",
    last_name: "Pipeline",
    email_address: "ci@example.com",
    api_user: true,
    active: true,
    roles: [{ role_name: "uploadapi", role_description: "Upload API" }],
    permissions: [{ permission_name: "apiUser", permission_description: "API user" }],
  },
  {
    user_id: "u3",
    user_name: "jdoe@example.com",
    first_name: "Jane",
    last_name: "Doe",
    email_address: "jdoe@example.com",
    active: false,
    roles: [{ role_name: "extreviewer", role_description: "Reviewer" }],
  },
];

const ROLES = [
  {
    role_name: "extseclead",
    role_description: "Security Lead",
    permissions: [
      { permission_name: "manageApps", permission_description: "Manage applications" },
      // Hidden by config/hidden-permissions.txt (docs/PLAN_ROLES.md, phase 1).
      { permission_name: "manageVsaRules", permission_description: "Manage VSA rules" },
    ],
  },
  { role_name: "extreviewer", role_description: "Reviewer" },
  { role_name: "extsubmitter", role_description: "Submitter" },
  { role_name: "extsubmitanyscan", role_description: "Any Scan" },
  { role_name: "extsubmitstaticscan", role_description: "Static Scan" },
  { role_name: "extsubmitcontainerscan", role_description: "Container Scan" },
  { role_name: "teamAdmin", role_description: "Team Admin" },
  { role_name: "extcreator", role_description: "Creator" },
  { role_name: "extadmin", role_description: "Administrator" },
  { role_name: "uploadapi", role_description: "Upload API", is_api: true },
];

const TEAMS = [
  { team_id: "t1", team_name: "Blue Team" },
  { team_id: "t2", team_name: "Red Team" },
];

let created = 0;

const readBody = (req: IncomingMessage): Promise<Record<string, unknown>> =>
  new Promise((resolve) => {
    let text = "";
    req.on("data", (chunk: Buffer) => (text += chunk.toString()));
    req.on("end", () => {
      try {
        const body: unknown = JSON.parse(text);
        resolve(typeof body === "object" && body !== null ? { ...body } : {});
      } catch {
        resolve({});
      }
    });
  });

// The fake's role ids are the role names.
const withRoleIds = (roles: unknown) =>
  (Array.isArray(roles) ? roles : []).map((r: { role_name?: string }) => ({
    ...r,
    role_id: r.role_name,
  }));

const withDescriptions = (body: Record<string, unknown>) => ({
  ...body,
  ...(Array.isArray(body.roles) && {
    roles: body.roles.map((r: { role_name?: string }) => ({
      role_name: r.role_name,
      role_description:
        ROLES.find((x) => x.role_name === r.role_name)?.role_description ?? r.role_name,
    })),
  }),
  ...(Array.isArray(body.teams) && {
    teams: body.teams.map((t: { team_id?: string; relationship?: string }) => ({
      team_id: t.team_id,
      team_name: TEAMS.find((x) => x.team_id === t.team_id)?.team_name ?? t.team_id,
      relationship: relationship(t.relationship === "ADMIN" ? "ADMIN" : "MEMBER"),
    })),
  }),
});

// Like the real one (docs/REALITY.md, entry 37): Creator or Submitter with no team is refused,
// unless the user is also a Security Lead.
const lacksTeam = (user: Record<string, unknown>) => {
  const roles = Array.isArray(user.roles)
    ? user.roles.map((r: { role_name?: string }) => (r.role_name ?? "").toLowerCase())
    : [];
  const teams = Array.isArray(user.teams) ? user.teams.length : 0;
  return (
    teams === 0 &&
    (roles.includes("extcreator") || roles.includes("extsubmitter")) &&
    !roles.includes("extseclead")
  );
};
const TEAM_REFUSED = { message: "The roles provided require a team assignment." };

export const startFakeVeracode = (port: number): Promise<Server> =>
  new Promise((resolve) => {
    const server = createServer((req, res) => {
      void handle(req, res);
    });
    const handle = async (req: IncomingMessage, res: ServerResponse) => {
      const path = (req.url ?? "").replace(/\?.*$/, "");
      const method = req.method ?? "GET";
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (req.method === "POST" && path === "/api/authn/v2/oauth2/token") {
        return send(200, { access_token: "fake-token", expires_in: 3600 });
      }
      if (req.headers.authorization !== "Bearer fake-token") return send(401, {});
      // Like the real one: the list has only basic fields; each user's record has the rest.
      if (path === "/api/authn/v2/users" && method === "POST") {
        const user: FakeUser = {
          ...withDescriptions(await readBody(req)),
          user_id: `new${++created}`,
        };
        if (lacksTeam(user)) return send(400, TEAM_REFUSED);
        USERS.push(user);
        return send(200, user);
      }
      // Like the real one (docs/REALITY.md, entries 1 and 39): the list's options add each
      // user's roles and teams; by_role returns full records without teams; a user's own record
      // has no last login.
      const query = new URL(req.url ?? "", "http://x").searchParams;
      if (path === "/api/authn/v2/users") {
        const basics = USERS.map((u) => ({
          user_id: u.user_id,
          user_name: u.user_name,
          first_name: u.first_name,
          last_name: u.last_name,
          email_address: u.email_address,
          active: u.active,
          ...(query.get("include_roles") === "true" && { roles: withRoleIds(u.roles) }),
          ...(query.get("include_teams") === "true" && { teams: u.teams ?? [] }),
        }));
        return send(200, { _embedded: { users: basics }, page: { total_pages: 1 } });
      }
      const byRole = /^\/api\/authn\/v2\/users\/by_role\/([^/]+)$/.exec(path);
      if (byRole) {
        const holders = USERS.filter((u) =>
          withRoleIds(u.roles).some((r) => r.role_id === decodeURIComponent(byRole[1] ?? "")),
        ).map(({ teams, ...rest }) => (void teams, { ...rest, roles: withRoleIds(rest.roles) }));
        return send(200, { _embedded: { users: holders }, page: { total_pages: 1 } });
      }
      const i = USERS.findIndex((u) => path === `/api/authn/v2/users/${u.user_id}`);
      const one = USERS[i];
      if (one && method === "PUT") {
        const changed = { ...one, ...withDescriptions(await readBody(req)), user_id: one.user_id };
        if (lacksTeam(changed)) return send(400, TEAM_REFUSED);
        USERS[i] = changed;
        return send(200, changed);
      }
      if (one && method === "DELETE") {
        USERS.splice(i, 1);
        res.writeHead(204);
        return res.end();
      }
      if (one) {
        const { last_login, ...record } = one;
        void last_login;
        return send(200, { ...record, roles: withRoleIds(record.roles) });
      }
      if (path === "/api/authn/v2/teams") {
        return send(200, { _embedded: { teams: TEAMS }, page: { total_pages: 1 } });
      }
      if (path === "/api/authn/v2/roles") {
        return send(200, { _embedded: { roles: ROLES }, page: { total_pages: 1 } });
      }
      send(404, {});
    };
    server.listen(port, () => resolve(server));
  });
