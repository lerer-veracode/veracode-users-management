import type { Role, RoleRef, User } from "../types";
import type { CsvUser } from "./csv";

export type ImportAction = "Create" | "Update" | "No change" | "Error";

export type PlannedRow = CsvUser & { action: ImportAction; existing: User | null };

const sameRoles = (names: string[], roles: RoleRef[]) =>
  [...names].sort().join(";") ===
  roles
    .map((r) => r.role_name)
    .sort()
    .join(";");

const actionFor = (row: CsvUser, errors: string[], existing: User | null): ImportAction => {
  if (errors.length > 0) return "Error";
  if (!existing) return "Create";
  const unchanged =
    sameRoles(row.roles, existing.roles) &&
    existing.first_name === row.first_name &&
    existing.last_name === row.last_name;
  return unchanged ? "No change" : "Update";
};

export const planImport = (rows: CsvUser[], users: User[], roles: Role[]): PlannedRow[] => {
  const known = new Set(roles.map((r) => r.role_name));
  return rows.map((row) => {
    const unknown = row.roles.filter((r) => !known.has(r));
    const errors =
      unknown.length > 0 ? [...row.errors, `Unknown roles: ${unknown.join(", ")}`] : row.errors;
    const email = row.email_address.toLowerCase();
    const existing = users.find((u) => u.email_address.toLowerCase() === email) ?? null;
    return { ...row, errors, existing, action: actionFor(row, errors, existing) };
  });
};
