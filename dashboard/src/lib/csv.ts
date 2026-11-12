import Papa from "papaparse";

export type CsvUser = {
  line: number;
  user_name: string;
  email_address: string;
  first_name: string;
  last_name: string;
  roles: string[];
  errors: string[];
};

export type ParseResult = { rows: CsvUser[]; error: string | null };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const REQUIRED = ["user_name", "email_address", "roles"];

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
    const roles = get("roles")
      .split(";")
      .map((r) => r.trim())
      .filter(Boolean);
    const errors: string[] = [];
    if (!get("user_name")) errors.push("User name is required");
    if (!EMAIL.test(email)) errors.push("Email address is not valid");
    if (roles.length === 0) errors.push("At least one role is required");
    return {
      line: i + 2,
      user_name: get("user_name"),
      email_address: email,
      first_name: get("first_name") || localPart,
      last_name: get("last_name") || localPart,
      roles,
      errors,
    };
  });
  return { rows, error: null };
};
