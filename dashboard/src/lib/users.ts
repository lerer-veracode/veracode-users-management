import type { Role, User, UserType } from "../types";
import { allowsScanType } from "./roles";

export type UserFilters = {
  search: string;
  types: UserType[];
  status: "all" | "active" | "inactive";
  role: string;
  // "all" (All scan types) or a scan type's role name.
  scanType: string;
};

export const EMPTY_FILTERS: UserFilters = {
  search: "",
  types: [],
  status: "all",
  role: "",
  scanType: "",
};

export type SortKey = "user_name" | "email_address" | "last_login";
export type Sort = { key: SortKey; dir: "asc" | "desc" };

export const filterUsers = (users: User[], f: UserFilters, roles: Role[]): User[] => {
  const term = f.search.trim().toLowerCase();
  return users.filter(
    (u) =>
      (!term ||
        [u.user_name, u.first_name, u.last_name, u.email_address].some((v) =>
          v.toLowerCase().includes(term),
        )) &&
      (f.types.length === 0 || f.types.includes(u.user_type)) &&
      (f.status === "all" || u.active === (f.status === "active")) &&
      (!f.role || u.roles.some((r) => r.role_name === f.role)) &&
      (!f.scanType || allowsScanType(u, roles, f.scanType)),
  );
};

export const sortUsers = (users: User[], { key, dir }: Sort): User[] => {
  const sign = dir === "asc" ? 1 : -1;
  return [...users].sort((a, b) => sign * (a[key] ?? "").localeCompare(b[key] ?? ""));
};

export const pageOf = <T>(items: T[], page: number, size: number): T[] =>
  items.slice((page - 1) * size, page * size);

export const pageCount = (total: number, size: number): number =>
  Math.max(1, Math.ceil(total / size));
