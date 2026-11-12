import type { Role, RoleKind, RoleRef, TeamOption, User, UserType } from "../types";

// Sample data for tests: the shapes the backend returns from Veracode.
const perm = (permission_name: string, permission_description: string) => ({
  permission_name,
  permission_description,
});

// The same grouping as the backend's roleKind.
const kindOf = (name: string): RoleKind => {
  if (name === "extsubmitanyscan") return "any_scan";
  if (["extseclead", "extcreator", "extsubmitter"].includes(name)) return "needs_scan_type";
  if (name === "teamAdmin") return "team_admin";
  if (name.startsWith("extsubmit")) return "scan_type";
  return "plain";
};

export const TEAMS: TeamOption[] = [
  { team_id: "t-blue", team_name: "Blue Team" },
  { team_id: "t-red", team_name: "Red Team" },
  { team_id: "t-green", team_name: "Green Team" },
];

export const ROLES: Role[] = [
  ["extadmin", "Administrator", false, [perm("manageUsers", "Manage users")]],
  [
    "extseclead",
    "Security Lead",
    false,
    [perm("viewReports", "View reports"), perm("manageApps", "Manage applications")],
  ],
  ["extcreator", "Creator", false, []],
  ["extsubmitter", "Submitter", false, []],
  ["extsubmitanyscan", "Any Scan", false, []],
  ["extsubmitstaticscan", "Static Scan", false, []],
  ["extsubmitdynamicscan", "Dynamic Scan", false, []],
  ["extsubmitcontainerscan", "Container Scan", false, []],
  ["teamAdmin", "Team Admin", false, []],
  ["extreviewer", "Reviewer", false, []],
  ["extexecutive", "Executive", false, []],
  ["extpolicyadmin", "Policy Administrator", false, []],
  ["adminapi", "Admin API", true, [perm("adminApi", "Access Admin API")]],
  ["resultsapi", "Results API", true, []],
  ["uploadapi", "Upload API", true, []],
].map(([role_name, role_description, is_api, permissions]) => ({
  role_name: String(role_name),
  role_description: String(role_description),
  is_api: is_api === true,
  permissions: Array.isArray(permissions) ? permissions : [],
  assignable: is_api !== true && role_name !== "extadmin",
  kind: kindOf(String(role_name)),
}));

const role = (name: string): RoleRef => {
  const found = ROLES.find((r) => r.role_name === name);
  if (!found) throw new Error(`Unknown role ${name}`);
  return { role_name: found.role_name, role_description: found.role_description };
};

const PEOPLE: [string, string, UserType, string[], boolean][] = [
  ["Yaakov", "Lerer", "UI", ["extadmin", "extseclead"], true],
  ["Dana", "Cohen", "UI", ["extseclead", "extsubmitanyscan"], true],
  ["Priya", "Nair", "SAML", ["extcreator", "extsubmitanyscan"], true],
  ["Marcus", "Webb", "UI", ["extreviewer"], true],
  ["Sofia", "Rossi", "SAML", ["extexecutive"], true],
  ["Ci", "Pipeline", "API", ["uploadapi", "resultsapi"], true],
  ["Tom", "Becker", "UI", ["extreviewer"], false],
  ["Aisha", "Okafor", "SAML", ["extpolicyadmin", "extseclead"], true],
  ["Lena", "Fischer", "UI", ["extcreator"], true],
  ["Admin", "Automation", "API", ["adminapi"], true],
  ["Noah", "Kim", "SAML", ["extsubmitanyscan"], true],
  ["Elena", "Petrova", "UI", ["extseclead"], false],
  ["Omar", "Haddad", "SAML", ["extcreator", "extreviewer"], true],
  ["Grace", "Liu", "UI", ["extexecutive"], true],
  ["Diego", "Alvarez", "SAML", ["extsubmitanyscan", "extreviewer"], true],
  ["Hannah", "Brooks", "UI", ["extreviewer"], true],
  ["Results", "Reader", "API", ["resultsapi"], true],
  ["Ivan", "Novak", "SAML", ["extcreator"], false],
  ["Mei", "Tanaka", "UI", ["extseclead", "extcreator"], true],
  ["Samuel", "Osei", "SAML", ["extsubmitanyscan"], true],
  ["Rachel", "Green", "UI", ["extpolicyadmin"], true],
  ["Kofi", "Mensah", "SAML", ["extreviewer"], true],
  ["Julia", "Santos", "UI", ["extcreator", "extsubmitanyscan"], true],
];

export const USERS: User[] = PEOPLE.map(([first, last, type, roles, active], i) => {
  const handle = `${first[0] ?? ""}${last}`.toLowerCase();
  const userName = type === "API" ? `api_${handle}` : `${handle}@example.com`;
  return {
    user_id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
    user_name: userName,
    locked: roles.includes("extadmin")
      ? `${userName} has the Administrator role. This app never changes or deletes administrators.`
      : type === "UI"
        ? null
        : `${userName} is a${type === "API" ? "n" : ""} ${type} account. This app changes only UI users.`,
    first_name: first,
    last_name: last,
    email_address: `${handle}@example.com`,
    user_type: type,
    active,
    login_enabled: active,
    pin_required: i % 2 === 0,
    roles: roles.map(role),
    permissions: type === "API" ? [perm("apiUser", "API user")] : [],
    teams:
      i % 3 === 0
        ? [
            i % 2 === 0
              ? { team_id: "t-blue", team_name: "Blue Team", relationship: "MEMBER" as const }
              : { team_id: "t-red", team_name: "Red Team", relationship: "MEMBER" as const },
          ]
        : [],
    last_login:
      i % 5 === 4
        ? null
        : new Date(Date.UTC(2026, 10, 8 - i, 9 + (i % 8), (i * 7) % 60)).toISOString(),
  };
});
