import Papa from "papaparse";

// A CSV row as written, before it's checked against the organization (docs/PLAN_CSV.md).
export type CsvUser = {
  line: number;
  // The email address when the cell is empty.
  user_name: string;
  email_address: string;
  first_name: string;
  last_name: string;
  roles: string[];
  // As written; empty means All.
  scan_types: string[];
  errors: string[];
};

export type ParseResult = { rows: CsvUser[]; error: string | null };

export const CSV_COLUMNS = [
  "user_name",
  "email_address",
  "first_name",
  "last_name",
  "roles",
  "scan_types",
] as const;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const REQUIRED = ["email_address", "roles"];

const list = (value: string) =>
  value
    .split(";")
    .map((r) => r.trim())
    .filter(Boolean);

export const parseUsersCsv = (text: string): ParseResult => {
  const parsed = Papa.parse<Record<string, string>>(text.trim(), {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim().toLowerCase(),
  });
  const headers = parsed.meta.fields ?? [];
  const missing = REQUIRED.filter((h) => !headers.includes(h));
  if (missing.length > 0) {
    return { rows: [], error: `Missing columns: ${missing.join(", ")}` };
  }

  const rows = parsed.data.map((record, i) => {
    const get = (key: string) => (record[key] ?? "").trim();
    const email = get("email_address");
    const localPart = email.split("@")[0] ?? "";
    const userName = get("user_name") || email;
    const roles = list(get("roles"));
    const errors: string[] = [];
    if (!email) errors.push("Email address is required");
    else if (!EMAIL.test(email)) errors.push("Email address is not valid");
    if (/\s/.test(userName) || userName.length > 256) {
      errors.push("A user name can't contain spaces or be over 256 characters");
    }
    if (roles.length === 0) errors.push("At least one role is required");
    return {
      line: i + 2,
      user_name: userName,
      email_address: email,
      first_name: get("first_name") || localPart,
      last_name: get("last_name") || localPart,
      roles,
      scan_types: list(get("scan_types")),
      errors,
    };
  });
  return { rows, error: null };
};
