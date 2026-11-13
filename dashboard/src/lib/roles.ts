import type { Role, RoleRef, User } from "../types";

// How a user's roles show, as on the Veracode Platform (docs/PLAN_ROLES.md, phase 2): scan types
// as "Allowed scan types", and "No Team Restriction API" as an API account's team memberships.
// The organization's own roles show as ordinary roles for now (docs/PLAN_ROLES.md, later work).

export const isScanType = (r: Role): boolean => r.kind === "scan_type" || r.kind === "any_scan";

// Roles shown as roles, in the Roles filter and column: not scan types or a team setting.
export const isShownAsRole = (r: Role): boolean => !isScanType(r) && !r.no_team_restriction;

const lookup = (roles: Role[], ref: RoleRef): Role =>
  roles.find((r) => r.role_name === ref.role_name) ?? {
    ...ref,
    is_api: false,
    permissions: [],
    assignable: false,
    kind: "plain",
    no_team_restriction: false,
  };

export type RoleView = {
  roles: Role[];
  // "All", the types by name, or "None"; null for an API account, which has no scan types.
  scanTypes: string | null;
  // For an API account only.
  teamMemberships: string | null;
};

export const roleView = (user: User, roles: Role[]): RoleView => {
  const held = user.roles.map((ref) => lookup(roles, ref));
  const types = held.filter(isScanType);
  const api = user.user_type === "API";
  return {
    roles: held.filter(isShownAsRole),
    scanTypes: api
      ? null
      : types.some((r) => r.kind === "any_scan")
        ? "All"
        : types.map((r) => r.role_description).join(", ") || "None",
    teamMemberships: api
      ? held.some((r) => r.no_team_restriction)
        ? "No team restrictions"
        : "Restricted to selected teams"
      : null,
  };
};

// Whether the user may submit this scan type ("all": the user has All scan types). A user with
// All may submit every type.
export const allowsScanType = (user: User, roles: Role[], scanType: string): boolean => {
  const names = user.roles.map((r) => r.role_name);
  const all = roles.some((r) => r.kind === "any_scan" && names.includes(r.role_name));
  return scanType === "all" ? all : all || names.includes(scanType);
};
