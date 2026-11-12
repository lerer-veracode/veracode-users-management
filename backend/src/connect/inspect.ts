import {
  baseUrl,
  failure,
  type Credentials,
  type Fetch,
  type TokenCache,
} from "../veracode/oauth.js";

// Describes a JSON value by its structure only: field names, types and list lengths, never
// values, so the output can be shared without exposing anyone's data.
export const shape = (value: unknown, depth = 0): unknown => {
  if (Array.isArray(value)) {
    return value.length === 0 ? "array(0)" : [`array(${value.length})`, shape(value[0], depth + 1)];
  }
  if (value === null) return "null";
  if (typeof value !== "object") return typeof value;
  if (depth >= 4) return "object";
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shape(v, depth + 1)]));
};

const record = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v))
    : {};

// The id of the first item in _embedded[key], used for the next probes but never printed.
const firstId = (body: unknown, key: string, field: string): string => {
  const list = record(record(body)._embedded)[key];
  const first = Array.isArray(list) ? record(list[0]) : {};
  return typeof first[field] === "string" ? first[field] : "";
};

// In a list of users, the first role and the first team found on any user, to show their
// fields. Shown as structure only, like everything else.
const nestedItems = (body: unknown): Record<string, unknown> => {
  const users = record(record(body)._embedded).users;
  const found: Record<string, unknown> = {};
  for (const u of Array.isArray(users) ? users : []) {
    for (const key of ["roles", "teams"]) {
      const list = record(u)[key];
      if (!(key in found) && Array.isArray(list) && list.length > 0) found[key] = list[0];
    }
  }
  return found;
};

// Each probe shows its path with {placeholders}; ids from earlier answers fill them in.
type Probe = { label: string; path: (ids: Record<string, string>) => string | null };

export const PROBES: Probe[] = [
  { label: "/v2/users?size=2", path: () => "/v2/users?size=2" },
  { label: "/v2/users?inactive=true&size=2", path: () => "/v2/users?inactive=true&size=2" },
  { label: "/v2/users?detailed=true&size=2", path: () => "/v2/users?detailed=true&size=2" },
  ...[
    "include_roles=true",
    "include_teams=true",
    "detailed=true&include_teams=true",
    "include_roles=true&include_teams=true",
    "detailed=true&include_roles=true&include_teams=true",
  ].map((q) => ({
    label: `/v2/users?${q}&size=2`,
    path: () => `/v2/users?${q}&size=2`,
  })),
  {
    label: "/v2/users/{userId}",
    path: (ids) => (ids.user ? `/v2/users/${encodeURIComponent(ids.user)}` : null),
  },
  {
    label: "/v2/users/{userId}?detailed=true",
    path: (ids) => (ids.user ? `/v2/users/${encodeURIComponent(ids.user)}?detailed=true` : null),
  },
  { label: "/v2/roles?size=2", path: () => "/v2/roles?size=2" },
  {
    label: "/v2/users/by_role/{roleId}?size=2",
    path: (ids) => (ids.role ? `/v2/users/by_role/${encodeURIComponent(ids.role)}?size=2` : null),
  },
  // Ways to read users' roles and teams in bulk, in place of one call per user (spec 1.5).
  { label: "/v2/users/search?size=2", path: () => "/v2/users/search?size=2" },
  ...[
    "roles,teams,last_login,pin_required,permissions",
    "roles&fields_to_return=teams&fields_to_return=last_login",
  ].map((fields) => ({
    label: `/v2/users/search?size=2&fields_to_return=${fields}`,
    path: () => `/v2/users/search?size=2&fields_to_return=${fields}`,
  })),
  {
    label: "/v2/users/search?role_id={roleId}&size=2",
    path: (ids) =>
      ids.role ? `/v2/users/search?role_id=${encodeURIComponent(ids.role)}&size=2` : null,
  },
  { label: "/v2/teams?size=2", path: () => "/v2/teams?size=2" },
  {
    label: "/v2/teams/{teamId}",
    path: (ids) => (ids.team ? `/v2/teams/${encodeURIComponent(ids.team)}` : null),
  },
  {
    label: "/v2/users/search?team_id={teamId}&size=2",
    path: (ids) =>
      ids.team ? `/v2/users/search?team_id=${encodeURIComponent(ids.team)}&size=2` : null,
  },
];

// Fields of a user record that are never printed: sign-in secrets, credentials and where the
// user signs in from. Only "(hidden)" shows that they're there.
const HIDDEN = new Set([
  "login_answer",
  "login_question",
  "api_credentials",
  "session_id",
  "ip_address",
  "last_host",
  "allowed_ip_addresses",
  "phone",
  "saml_subject",
  "okta_user_id",
]);

// The fields the app sends when it creates a user (backend/src/veracode/identity.ts).
export const CREATE_FIELDS = [
  "user_name",
  "email_address",
  "first_name",
  "last_name",
  "pin_required",
  "active",
  "login_enabled",
  "roles",
  "teams",
];

const names = (v: unknown, key: string, extra?: string): string => {
  if (!Array.isArray(v)) return JSON.stringify(v);
  if (v.length === 0) return "[]";
  return v
    .map((item) => {
      const r = record(item);
      const name = typeof r[key] === "string" ? r[key] : JSON.stringify(item);
      return extra && typeof r[extra] === "string" ? `${name} (${r[extra]})` : name;
    })
    .join(", ");
};

// One field's value as a line of text.
const valueOf = (key: string, v: unknown): string => {
  if (HIDDEN.has(key)) return v === null || v === undefined || v === "" ? "(empty)" : "(hidden)";
  if (key === "roles") return names(v, "role_name");
  if (key === "permissions") return names(v, "permission_name");
  if (key === "teams") {
    // A team's relationship comes back as { name, display_name } (docs/REALITY.md, entry 38).
    const flat = Array.isArray(v)
      ? v.map((t) => {
          const r = record(t);
          const rel = record(r.relationship).name ?? r.relationship;
          return { ...r, relationship: typeof rel === "string" ? rel : undefined };
        })
      : v;
    return names(flat, "team_name", "relationship");
  }
  if (typeof v === "string") return v;
  return JSON.stringify(v);
};

// Which users to inspect: by user name, or every user with one of these email addresses.
export type Wanted = { names: string[]; emails: string[] };

type Match = { name: string; id: string | null };

// Finds users by user name or email (any capitals) in the full list, read page by page.
// Users missing from the list come back with no id, to be reported.
const findUsers = async (
  creds: Credentials,
  token: string,
  fetchFn: Fetch,
  wanted: Wanted,
): Promise<Match[]> => {
  const names = new Map<string, string>();
  const byEmail: Match[] = [];
  const matchedEmails = new Set<string>();
  const lowerNames = wanted.names.map((w) => w.toLowerCase());
  const lowerEmails = wanted.emails.map((w) => w.toLowerCase());
  for (let page = 0; page < 100; page++) {
    const res = await fetchFn(`${baseUrl(creds.region)}/v2/users?page=${page}&size=100`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    if (!res.ok) throw await failure(res, "Reading the users list");
    const body: unknown = await res.json();
    const list = record(record(body)._embedded).users;
    for (const item of Array.isArray(list) ? list : []) {
      const u = record(item);
      if (typeof u.user_id !== "string" || typeof u.user_name !== "string") continue;
      const name = u.user_name.toLowerCase();
      const email = typeof u.email_address === "string" ? u.email_address.toLowerCase() : "";
      if (lowerNames.includes(name)) names.set(name, u.user_id);
      else if (lowerEmails.includes(email)) {
        byEmail.push({ name: u.user_name, id: u.user_id });
        matchedEmails.add(email);
      }
    }
    const meta = record(record(body).page);
    const total = meta.total_pages ?? meta.totalPages;
    // An email can match any number of users, so the whole list is read when emails are asked.
    const allNamesFound = lowerEmails.length === 0 && names.size === lowerNames.length;
    if (allNamesFound || page + 1 >= (typeof total === "number" ? total : 1)) break;
  }
  const missingEmails = wanted.emails
    .filter((e) => !matchedEmails.has(e.toLowerCase()))
    .map((e) => ({ name: `Users with email ${e}`, id: null }));
  return [
    ...wanted.names.map((n) => ({ name: n, id: names.get(n.toLowerCase()) ?? null })),
    ...byEmail,
    ...missingEmails,
  ];
};

// Prints each user's full record, values included except the hidden fields, then the fields
// they have that the app's create request doesn't send. Reads only.
export const inspectUsers = async (
  creds: Credentials,
  tokens: TokenCache,
  fetchFn: Fetch,
  wanted: Wanted,
  say: (line: string) => void,
): Promise<void> => {
  const token = await tokens.get(creds);
  const matches = await findUsers(creds, token, fetchFn, wanted);
  const notSent = new Set<string>();
  for (const { name, id } of matches) {
    if (!id) {
      say(`${name}: not found in the users list.`);
      say("");
      continue;
    }
    const res = await fetchFn(`${baseUrl(creds.region)}/v2/users/${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    if (!res.ok) {
      say(`${name}: ${(await failure(res, "Reading the record")).message}`);
      say("");
      continue;
    }
    const user = record(await res.json());
    say(`${name}`);
    for (const key of Object.keys(user).sort()) {
      if (key === "_links") continue;
      say(`  ${key}: ${valueOf(key, user[key])}`);
      if (!CREATE_FIELDS.includes(key) && !HIDDEN.has(key)) notSent.add(key);
    }
    say("");
  }
  if (notSent.size > 0) {
    say("Fields these users have that the app's create request doesn't send:");
    say(`  ${[...notSent].sort().join(", ")}`);
  }
};

export const inspectApi = async (
  creds: Credentials,
  tokens: TokenCache,
  fetchFn: Fetch,
  say: (line: string) => void,
): Promise<void> => {
  const token = await tokens.get(creds);
  const ids: Record<string, string> = {};
  for (const probe of PROBES) {
    const path = probe.path(ids);
    if (!path) {
      say(`GET ${probe.label} -> skipped: no id from an earlier answer`);
      say("");
      continue;
    }
    const res = await fetchFn(`${baseUrl(creds.region)}${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    say(`GET ${probe.label} -> ${res.status} ${res.headers.get("content-type") ?? ""}`);
    const text = await res.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      say(`  not JSON (${text.length} characters)`);
      say("");
      continue;
    }
    // A refusal's own message says why; it describes the request, not anyone's data.
    const message = record(body).message;
    if (!res.ok && typeof message === "string") say(`  message: ${message}`);
    const total = record(record(body).page).total_elements;
    if (typeof total === "number") say(`  total_elements: ${total}`);
    say(JSON.stringify(shape(body), null, 2));
    // The roles and teams inside a list of users sit too deep for the shape above.
    for (const [key, item] of Object.entries(nestedItems(body))) {
      say(`  first of a user's ${key}: ${JSON.stringify(shape(item))}`);
    }
    say("");
    ids.user ||= firstId(body, "users", "user_id");
    ids.role ||= firstId(body, "roles", "role_id");
    // A team the inspected user is in, so the team probes look at a team with a member; else
    // the first team in the list.
    const userTeams = record(body).teams;
    const memberOf = Array.isArray(userTeams) ? record(userTeams[0]).team_id : undefined;
    ids.team ||= typeof memberOf === "string" ? memberOf : firstId(body, "teams", "team_id");
  }
};
