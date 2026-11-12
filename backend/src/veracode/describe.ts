import type { FieldChange } from "../audit/audit.js";
import type { VeracodeUser } from "./identity.js";
import { roleKind, type NewUser, type Org, type TeamRef, type UserChanges } from "./rules.js";

// Turns a user change into what the audit log keeps: each field that changes, from and to, in
// the words the dashboard uses. Never a secret or token; only the user's own settings.

type Shape = {
  first_name: string;
  last_name: string;
  email_address: string;
  active: boolean;
  login_enabled: boolean;
  pin_required: boolean;
  roles: string[];
  teams: TeamRef[];
};

const fromUser = (u: VeracodeUser): Shape => ({
  first_name: u.first_name,
  last_name: u.last_name,
  email_address: u.email_address,
  active: u.active,
  login_enabled: u.login_enabled,
  pin_required: u.pin_required,
  roles: u.roles.map((r) => r.role_name),
  teams: u.teams.map(({ team_id, relationship }) => ({ team_id, relationship })),
});

// The names to show: the organization's, else the user's own record, else the raw id.
const namer = (org: Org | null, user: VeracodeUser | null) => ({
  role: (name: string) =>
    org?.roles.find((r) => r.role_name === name)?.role_description ??
    user?.roles.find((r) => r.role_name === name)?.role_description ??
    name,
  isScan: (name: string) => {
    const kind = roleKind(org?.roles.find((r) => r.role_name === name) ?? { role_name: name });
    return kind === "scan_type" || kind === "any_scan";
  },
  team: (id: string) =>
    org?.teams.find((t) => t.team_id === id)?.team_name ??
    user?.teams.find((t) => t.team_id === id)?.team_name ??
    id,
});

const fields = (s: Shape, names: ReturnType<typeof namer>): [string, string][] => {
  const list = (items: string[]) => [...items].sort().join(", ") || "None";
  const teams = (relationship: TeamRef["relationship"]) =>
    list(s.teams.filter((t) => t.relationship === relationship).map((t) => names.team(t.team_id)));
  return [
    ["First name", s.first_name],
    ["Last name", s.last_name],
    ["Email", s.email_address],
    ["Status", s.active ? "Active" : "Inactive"],
    ["Login", s.login_enabled ? "Enabled" : "Disabled"],
    ["MFA", s.pin_required ? "Required" : "Not required"],
    ["Roles", list(s.roles.filter((r) => !names.isScan(r)).map(names.role))],
    ["Scan types", list(s.roles.filter(names.isScan).map(names.role))],
    ["Member of teams", teams("MEMBER")],
    ["Manages teams", teams("ADMIN")],
  ];
};

export const describeCreate = (user: NewUser, org: Org): FieldChange[] =>
  [
    ["User name", user.user_name] as [string, string],
    ...fields({ ...user, active: true, login_enabled: true }, namer(org, null)),
  ].map(([field, to]) => ({ field, from: null, to }));

export const describeUpdate = (
  current: VeracodeUser,
  changes: UserChanges,
  org: Org,
): FieldChange[] => {
  const names = namer(org, current);
  const before = fields(fromUser(current), names);
  const after = fields({ ...fromUser(current), ...changes }, names);
  return before.flatMap(([field, from], i) => {
    const to = after[i]?.[1] ?? null;
    return from === to ? [] : [{ field, from, to }];
  });
};

export const describeDelete = (current: VeracodeUser): FieldChange[] =>
  [
    ["User name", current.user_name] as [string, string],
    ...fields(fromUser(current), namer(null, current)),
  ].map(([field, from]) => ({ field, from, to: null }));
