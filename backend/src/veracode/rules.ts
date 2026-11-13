import type { VeracodeRole, VeracodeUser } from "./identity.js";

// What the app may change on Veracode. The backend checks these on every change, whatever the
// dashboard sends, against a fresh read of the user from Veracode.

export type Relationship = "ADMIN" | "MEMBER";
export type TeamRef = { team_id: string; relationship: Relationship };

export type NewUser = {
  user_name: string;
  email_address: string;
  first_name: string;
  last_name: string;
  roles: string[];
  teams: TeamRef[];
  // Require MFA (Veracode's pin_required).
  pin_required: boolean;
};

export type UserChanges = Partial<Omit<NewUser, "user_name">> & {
  active?: boolean;
  login_enabled?: boolean;
};

// The organization's roles and teams, read from Veracode, to check a change against.
export type Org = { roles: VeracodeRole[]; teams: { team_id: string; team_name: string }[] };

const ADMIN_ROLE = "extadmin";
const TEAM_ADMIN = "teamadmin";
const ANY_SCAN = "extsubmitanyscan";

// Security Lead, Creator and Submitter need at least one scan type: "Any scan", or one or more
// specific types (docs.veracode.com, Identity API roles table).
const NEEDS_SCAN_TYPE = ["extseclead", "extcreator", "extsubmitter"];

// Creator and Submitter need at least one team, unless the user is also a Security Lead.
// Veracode refuses them otherwise, on a create or an edit: "The roles provided require a team
// assignment." (docs/REALITY.md, entry 37). Checked here so the change isn't sent at all.
const TEAM_LEVEL = ["extcreator", "extsubmitter"];
const SECURITY_LEAD = "extseclead";
export const TEAM_NEEDED =
  "This combination of roles requires the user to be in at least one team: choose one under Member of teams.";
export const needsTeam = (roles: string[], teamCount: number): boolean => {
  const names = roles.map((r) => r.toLowerCase());
  return (
    teamCount === 0 && names.some((n) => TEAM_LEVEL.includes(n)) && !names.includes(SECURITY_LEAD)
  );
};

// How the dashboard groups a role: given plainly, as a scan type, as a role that needs a scan
// type, or as Team Admin, which needs teams to manage.
export type RoleKind = "plain" | "scan_type" | "any_scan" | "needs_scan_type" | "team_admin";

// Scan types are the extsubmit... roles other than Submitter (static, dynamic, manual,
// container and any others the organization has), or any role Veracode marks is_scan_type.
// The docs list only some of them, so they're found by name rather than from a fixed list.
export const roleKind = (role: { role_name: string; is_scan_type?: boolean }): RoleKind => {
  const n = role.role_name.toLowerCase();
  if (n === ANY_SCAN) return "any_scan";
  if (NEEDS_SCAN_TYPE.includes(n)) return "needs_scan_type";
  if (n === TEAM_ADMIN) return "team_admin";
  if (n.startsWith("extsubmit") || role.is_scan_type === true) return "scan_type";
  return "plain";
};

// The organization's own roles: Veracode adds "custom-" to their names (docs/SPEC.md).
export const isCustomRole = (r: { role_name: string }): boolean =>
  r.role_name.toLowerCase().startsWith("custom-");

// "No Team Restriction API", which the Platform shows as an API account's "Team Memberships: No
// Team Restrictions". Found by its description until its role name is known (docs/REALITY.md,
// entry 41).
export const isNoTeamRestriction = (r: { role_description: string }): boolean =>
  /\bno team restrictions?\b/i.test(r.role_description);

export const isAdministratorRole = (r: { role_name: string; role_description: string }): boolean =>
  r.role_name.toLowerCase() === ADMIN_ROLE || r.role_description.toLowerCase() === "administrator";

// Why a user can't be changed or deleted here, or null when they can.
export const protectedReason = (user: VeracodeUser): string | null => {
  if (user.roles.some(isAdministratorRole)) {
    return `${user.user_name} has the Administrator role. This app never changes or deletes administrators.`;
  }
  if (user.user_type !== "UI") {
    return `${user.user_name} is a${user.user_type === "API" ? "n" : ""} ${user.user_type} account. This app changes only UI users.`;
  }
  return null;
};

// The roles this app may give: not Administrator, not API roles.
export const assignable = (roles: VeracodeRole[]): VeracodeRole[] =>
  roles.filter((r) => !r.is_api && !isAdministratorRole(r));

type Json = Record<string, unknown>;
type Result<T> = { ok: true; value: T } | { ok: false; error: string };

const isRecord = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const field = (body: Json, key: string): unknown =>
  Object.getOwnPropertyDescriptor(body, key)?.value;
const text = (v: unknown): string | undefined => (typeof v === "string" ? v.trim() : undefined);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Checks the roles asked for. kept: roles the user already has, which may stay even if this
// app wouldn't give them.
const checkRoles = (v: unknown, roles: VeracodeRole[], kept: string[] = []): Result<string[]> => {
  if (!Array.isArray(v) || v.some((r) => typeof r !== "string")) {
    return { ok: false, error: "Roles must be a list of role names." };
  }
  const names = [...new Set(v.filter((r): r is string => typeof r === "string"))];
  if (names.length === 0) return { ok: false, error: "Choose at least one role." };
  const known = new Map(roles.map((r) => [r.role_name, r]));
  for (const name of names) {
    const role = known.get(name);
    if ((role && isAdministratorRole(role)) || name.toLowerCase() === ADMIN_ROLE) {
      return { ok: false, error: "This app never gives the Administrator role." };
    }
    if (kept.includes(name)) continue;
    if (!role) return { ok: false, error: `${name} isn't a role in this organization.` };
    if (role.is_api) {
      return { ok: false, error: `${name} is an API role; this app adds UI users only.` };
    }
  }
  return { ok: true, value: names };
};

// Checks the teams asked for. kept: teams the user is already in.
const checkTeams = (v: unknown, org: Org, kept: string[] = []): Result<TeamRef[]> => {
  if (v === undefined) return { ok: true, value: [] };
  if (!Array.isArray(v)) return { ok: false, error: "Teams must be a list." };
  const teams: TeamRef[] = [];
  for (const t of v) {
    const id = isRecord(t) ? field(t, "team_id") : undefined;
    const relationship = isRecord(t) ? (field(t, "relationship") ?? "MEMBER") : undefined;
    if (typeof id !== "string" || (relationship !== "ADMIN" && relationship !== "MEMBER")) {
      return { ok: false, error: "Each team needs a team_id and a relationship, ADMIN or MEMBER." };
    }
    if (!kept.includes(id) && !org.teams.some((x) => x.team_id === id)) {
      return { ok: false, error: `${id} isn't a team in this organization.` };
    }
    if (teams.some((x) => x.team_id === id)) {
      return { ok: false, error: "Each team can be listed only once." };
    }
    teams.push({ team_id: id, relationship });
  }
  return { ok: true, value: teams };
};

// Rules that tie roles together and to teams, checked on the user's roles and teams after the change.
const checkCombination = (roles: string[], teams: TeamRef[], org: Org): string | null => {
  const kinds = roles.map((name) =>
    roleKind(org.roles.find((r) => r.role_name === name) ?? { role_name: name }),
  );
  const scanTypes = kinds.filter((k) => k === "scan_type" || k === "any_scan");
  if (kinds.includes("needs_scan_type") && scanTypes.length === 0) {
    return "Security Lead, Creator and Submitter need a scan type: All scan types, or at least one specific type.";
  }
  if (kinds.includes("any_scan") && kinds.includes("scan_type")) {
    return "Choose All scan types or specific scan types, not both.";
  }
  const manages = teams.some((t) => t.relationship === "ADMIN");
  if (kinds.includes("team_admin") && !manages) {
    return "Team Admin needs at least one team to manage.";
  }
  if (manages && !kinds.includes("team_admin")) {
    return "Only a Team Admin can manage a team.";
  }
  if (needsTeam(roles, teams.length)) return TEAM_NEEDED;
  return null;
};

const checkName = (v: unknown, label: string): Result<string> => {
  const s = text(v);
  return s ? { ok: true, value: s } : { ok: false, error: `Enter the ${label}.` };
};

const checkEmail = (v: unknown): Result<string> => {
  const s = text(v);
  return s && EMAIL.test(s)
    ? { ok: true, value: s }
    : { ok: false, error: "Enter a valid email address." };
};

export const checkNewUser = (body: unknown, org: Org): Result<NewUser> => {
  if (!isRecord(body)) return { ok: false, error: "Send the user's details." };
  const email = checkEmail(field(body, "email_address"));
  if (!email.ok) return email;
  // The user name is the email address unless a different one is given.
  const rawName = field(body, "user_name");
  const userName = rawName === undefined ? email.value : text(rawName);
  if (!userName) return { ok: false, error: "Enter the user name, or use the email address." };
  if (/\s/.test(userName) || userName.length > 256) {
    return { ok: false, error: "A user name can't contain spaces or be over 256 characters." };
  }
  const first = checkName(field(body, "first_name"), "first name");
  if (!first.ok) return first;
  const last = checkName(field(body, "last_name"), "last name");
  if (!last.ok) return last;
  const r = checkRoles(field(body, "roles"), org.roles);
  if (!r.ok) return r;
  const t = checkTeams(field(body, "teams"), org);
  if (!t.ok) return t;
  const combination = checkCombination(r.value, t.value, org);
  if (combination) return { ok: false, error: combination };
  const mfa = field(body, "pin_required");
  if (mfa !== undefined && typeof mfa !== "boolean") {
    return { ok: false, error: "Require MFA must be true or false." };
  }
  return {
    ok: true,
    value: {
      user_name: userName,
      email_address: email.value,
      first_name: first.value,
      last_name: last.value,
      roles: r.value,
      teams: t.value,
      pin_required: mfa === true,
    },
  };
};

const sameTeams = (a: TeamRef[], b: TeamRef[]) =>
  a.length === b.length &&
  a.every((x) => b.some((y) => y.team_id === x.team_id && y.relationship === x.relationship));

// Only the fields that differ from the user's current record are kept.
export const checkChanges = (
  body: unknown,
  current: VeracodeUser,
  org: Org,
): Result<UserChanges> => {
  if (!isRecord(body)) return { ok: false, error: "Send the changes." };
  const changes: UserChanges = {};
  for (const [key, label] of [
    ["first_name", "first name"],
    ["last_name", "last name"],
  ] as const) {
    if (field(body, key) === undefined) continue;
    const r = checkName(field(body, key), label);
    if (!r.ok) return r;
    if (r.value !== current[key]) changes[key] = r.value;
  }
  if (field(body, "email_address") !== undefined) {
    const r = checkEmail(field(body, "email_address"));
    if (!r.ok) return r;
    if (r.value !== current.email_address) changes.email_address = r.value;
  }
  for (const [key, label] of [
    ["active", "Active"],
    ["login_enabled", "Login enabled"],
    ["pin_required", "Require MFA"],
  ] as const) {
    const value = field(body, key);
    if (value === undefined) continue;
    if (typeof value !== "boolean") return { ok: false, error: `${label} must be true or false.` };
    if (value !== current[key]) changes[key] = value;
  }
  const held = current.roles.map((r) => r.role_name);
  if (field(body, "roles") !== undefined) {
    const r = checkRoles(field(body, "roles"), org.roles, held);
    if (!r.ok) return r;
    const same = r.value.length === held.length && r.value.every((n) => held.includes(n));
    if (!same) changes.roles = r.value;
  }
  const currentTeams: TeamRef[] = current.teams.map((t) => ({
    team_id: t.team_id,
    relationship: t.relationship,
  }));
  if (field(body, "teams") !== undefined) {
    const t = checkTeams(
      field(body, "teams"),
      org,
      currentTeams.map((x) => x.team_id),
    );
    if (!t.ok) return t;
    if (!sameTeams(t.value, currentTeams)) changes.teams = t.value;
  }
  // The rules that tie roles to scan types and teams apply when either changes.
  if (changes.roles || changes.teams) {
    const combination = checkCombination(changes.roles ?? held, changes.teams ?? currentTeams, org);
    if (combination) return { ok: false, error: combination };
  }
  if (Object.keys(changes).length === 0) return { ok: false, error: "Nothing to change." };
  return { ok: true, value: changes };
};
