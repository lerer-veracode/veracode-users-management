import Papa from "papaparse";
import type { Role, User } from "../types";
import { CSV_COLUMNS } from "./csv";
import { roleView } from "./roles";

// The users shown, saved in the import's format (docs/PLAN_CSV.md, phase 3): roles by their
// Platform names, without scan types or the API team setting; scan types as All, the types, or
// empty for a user whose roles take none.

// A cell a spreadsheet would run as a formula (=, +, -, @, tab, return) starts with ' instead,
// so opening the file can't run anything (CSV injection).
const safe = (value: string) => (/^[=+\-@\t\r]/.test(value) ? `'${value}` : value);

const scanTypesOf = (user: User, roles: Role[]): string[] => {
  const view = roleView(user, roles);
  if (view.scanTypes === "All") return ["All"];
  return user.roles
    .map((ref) => roles.find((r) => r.role_name === ref.role_name))
    .filter((r): r is Role => r?.kind === "scan_type")
    .map((r) => r.role_description);
};

export const usersCsv = (users: User[], roles: Role[]): string =>
  Papa.unparse(
    {
      fields: [...CSV_COLUMNS],
      data: users.map((u) =>
        [
          u.email_address,
          u.user_name,
          u.first_name,
          u.last_name,
          roleView(u, roles)
            .roles.map((r) => r.role_description)
            .join(";"),
          scanTypesOf(u, roles).join(";"),
        ].map(safe),
      ),
    },
    { newline: "\n" },
  ) + "\n";

// users-acme-2026-11-15.csv: the connection's name, made safe for a file name, and today's date.
export const exportFileName = (connection: string, today: Date): string => {
  const name = connection.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "users";
  const pad = (n: number) => String(n).padStart(2, "0");
  const date = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
  return `users-${name}-${date}.csv`;
};
