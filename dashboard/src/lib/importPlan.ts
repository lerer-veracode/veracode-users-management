import type { Role, User } from "../types";
import type { CsvUser } from "./csv";
import { fullName } from "./format";

// What each CSV row will do (docs/PLAN_CSV.md). The import creates users only: a user name
// already used is an error, and the email address never matches a row to a user.

export type ImportAction = "Create" | "Error";

export type PlannedRow = CsvUser & {
  action: ImportAction;
  // The roles to give, as the organization names them: the roles kept, then the scan types.
  give: Role[];
  // Roles that need a team, which a CSV can't set yet: left out of the user created.
  leftOut: Role[];
  // Things the row asks for that the user won't get, though the row is still created.
  notes: string[];
  // "All", the scan types by name, or "" when no role takes scan types.
  scanTypes: string;
};

const SECURITY_LEAD = "extseclead";
// Creator and Submitter need a team unless the user is also a Security Lead; Team Admin always
// does (docs/SPEC.md, the form's rules).
const TEAM_LEVEL = ["extcreator", "extsubmitter"];

const lower = (s: string) => s.toLowerCase();
const isScanType = (r: Role) => r.kind === "scan_type" || r.kind === "any_scan";

// "Static", "Static Scan" or "extsubmitstaticscan", ignoring case.
const scanTypeNamed = (roles: Role[], name: string): Role | undefined => {
  const n = lower(name);
  return roles.find(
    (r) =>
      r.kind === "scan_type" &&
      !r.is_api &&
      [
        lower(r.role_name),
        lower(r.role_description),
        lower(r.role_description).replace(/ scan$/, ""),
      ].includes(n),
  );
};

type ScanResult = { give: Role[]; label: string; errors: string[] };

const scanTypes = (written: string[], roles: Role[]): ScanResult => {
  const wantsAll = written.length === 0 || written.some((s) => lower(s) === "all");
  if (wantsAll) {
    if (written.length > 1) {
      return { give: [], label: "", errors: ["All can't be combined with specific scan types"] };
    }
    const all = roles.find((r) => r.kind === "any_scan" && !r.is_api);
    return all
      ? { give: [all], label: "All", errors: [] }
      : { give: [], label: "", errors: ["The organization has no All scan types role"] };
  }
  const found = written.map((s) => scanTypeNamed(roles, s));
  const unknown = written.filter((_, i) => !found[i]);
  if (unknown.length > 0)
    return { give: [], label: "", errors: [`Unknown scan types: ${unknown.join(", ")}`] };
  const give = [...new Set(found.filter((r): r is Role => r !== undefined))];
  return { give, label: give.map((r) => r.role_description).join(", "), errors: [] };
};

// A role by its name on the Platform ("Security Lead") or its role name ("extseclead"), ignoring
// case. A UI role wins over an API role of the same name.
const roleNamed = (roles: Role[], name: string): Role | undefined => {
  const n = lower(name);
  return (
    roles.find((r) => lower(r.role_name) === n) ??
    roles.find((r) => !r.is_api && lower(r.role_description) === n) ??
    roles.find((r) => lower(r.role_description) === n)
  );
};

const byDescription = (a: Role, b: Role) => a.role_description.localeCompare(b.role_description);

// The roles a CSV can give, listed on the Import page: not Administrator, API roles, scan types or
// the API team setting.
export const csvRoles = (roles: Role[]): Role[] =>
  roles
    .filter((r) => r.assignable && !r.is_api && !isScanType(r) && !r.no_team_restriction)
    .sort(byDescription);

// The specific scan types a CSV can give (All is the default).
export const csvScanTypes = (roles: Role[]): Role[] =>
  roles.filter((r) => r.kind === "scan_type" && !r.is_api).sort(byDescription);

// Why a role may be left out of a user created from a CSV, or "".
export const needsTeamNote = (r: Role): string =>
  r.kind === "team_admin"
    ? "left out: needs a team"
    : TEAM_LEVEL.includes(lower(r.role_name))
      ? "left out without Security Lead: needs a team"
      : "";

const planRow = (row: CsvUser, users: User[], roles: Role[], earlier: CsvUser[]): PlannedRow => {
  const errors = [...row.errors];
  const named = row.roles.map((name) => ({
    name,
    role: roleNamed(roles, name),
  }));
  const unknown = named.filter((n) => !n.role).map((n) => n.name);
  if (unknown.length > 0) errors.push(`Unknown roles: ${unknown.join(", ")}`);
  const held = named.flatMap((n) => (n.role ? [n.role] : []));

  const scanInRoles = held.filter(isScanType);
  if (scanInRoles.length > 0) {
    errors.push(
      `Scan types go in the scan_types column: ${scanInRoles.map((r) => r.role_description).join(", ")}`,
    );
  }
  const admin = held.filter((r) => lower(r.role_name) === "extadmin");
  if (admin.length > 0) errors.push("The app never gives the Administrator role");
  const api = held.filter((r) => r.is_api);
  if (api.length > 0) {
    errors.push(`The app never gives API roles: ${api.map((r) => r.role_description).join(", ")}`);
  }

  const roleList = held.filter((r) => !isScanType(r) && !r.is_api && !admin.includes(r));
  const lead = roleList.some((r) => lower(r.role_name) === SECURITY_LEAD);
  const needsTeam = (r: Role) =>
    r.kind === "team_admin" || (!lead && TEAM_LEVEL.includes(lower(r.role_name)));
  const leftOut = roleList.filter(needsTeam);
  const kept = roleList.filter((r) => !needsTeam(r));
  if (held.length > 0 && kept.length === 0 && leftOut.length > 0) {
    errors.push(
      `No role left: ${leftOut.map((r) => r.role_description).join(", ")} ${leftOut.length === 1 ? "needs" : "need"} a team, which a CSV can't set yet`,
    );
  }

  // Scan types only for the roles that take them, and dropped otherwise.
  const takesScanTypes = kept.some((r) => r.kind === "needs_scan_type");
  const scan = takesScanTypes
    ? scanTypes(row.scan_types, roles)
    : { give: [], label: "", errors: [] };
  errors.push(...scan.errors);

  const name = lower(row.user_name);
  const taken = name ? users.find((u) => lower(u.user_name) === name) : undefined;
  if (taken) {
    errors.push(
      `${row.user_name} is already the user name of ${fullName(taken)}, ${taken.email_address}`,
    );
  }
  const before = name ? earlier.find((r) => lower(r.user_name) === name) : undefined;
  if (before) errors.push(`${row.user_name} is already used on line ${before.line}`);
  // Veracode refuses a new user whose email is an existing user name (docs/REALITY.md, entry 35).
  const email = lower(row.email_address);
  if (email && email !== name) {
    const owner = users.find((u) => lower(u.user_name) === email);
    const earlierOwner = earlier.find((r) => lower(r.user_name) === email);
    if (owner) {
      errors.push(`Veracode refuses this email: it is the user name of ${fullName(owner)}`);
    } else if (earlierOwner) {
      errors.push(`Veracode refuses this email: it is the user name on line ${earlierOwner.line}`);
    }
  }

  return {
    ...row,
    errors,
    action: errors.length > 0 ? "Error" : "Create",
    give: [...kept, ...scan.give],
    leftOut,
    notes:
      !takesScanTypes && row.scan_types.length > 0 && kept.length > 0
        ? [
            `Scan types not given: ${kept.map((r) => r.role_description).join(", ")} ${kept.length === 1 ? "doesn't" : "don't"} take them (only Security Lead, Creator and Submitter do)`,
          ]
        : [],
    scanTypes: scan.label,
  };
};

export const planImport = (rows: CsvUser[], users: User[], roles: Role[]): PlannedRow[] =>
  rows.map((row, i) => planRow(row, users, roles, rows.slice(0, i)));
