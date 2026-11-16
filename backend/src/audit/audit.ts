import { AsyncLocalStorage } from "node:async_hooks";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Fetch } from "../veracode/oauth.js";

export type ConnectionRef = { name: string; region: string; client_id: string };

// One field of a user that a change touched. from is null for a new user, to for a deleted one.
export type FieldChange = { field: string; from: string | null; to: string | null };

// The user a change acted on.
export type TargetRef = { user_id?: string; user_name: string };

export type AuditEntry = {
  time: string;
  actor: string;
  action: string;
  outcome: "ok" | "failed";
  connection?: ConnectionRef;
  reason?: string;
  // Why the app made the call, in plain words, e.g. "Change a user: safety check".
  purpose?: string;
  method?: string;
  path?: string;
  status?: number;
  detail?: string;
  // How long Veracode took to answer, in milliseconds.
  ms?: number;
  // What came back, as counts only (e.g. "23 users"), never the records themselves.
  result?: string;
  target?: TargetRef;
  changes?: FieldChange[];
};

type Context = {
  actor?: string;
  connection?: ConnectionRef;
  reason?: string;
  purpose?: string;
  // For a change to a user: who, and each field from and to. Kept only on the entry for the
  // create, update or delete call itself.
  target?: TargetRef;
  changes?: FieldChange[];
};

const USER_CHANGES = ["user.create", "user.update", "user.delete", "user.reset_mfa"];

const context = new AsyncLocalStorage<Context>();

// Runs fn with who is acting, on which connection and why, for every entry recorded inside it.
export const withAudit = <T>(ctx: Context, fn: () => T): T =>
  context.run({ ...context.getStore(), ...ctx }, fn);

// Runs fn with a step added to the purpose of every call inside it, e.g. "Change a user" then
// "Change a user: safety check".
export const withPurpose = <T>(step: string, fn: () => T): T => {
  const outer = context.getStore()?.purpose;
  return withAudit({ purpose: outer ? `${outer}: ${step}` : step }, fn);
};

export const connectionRef = (c: ConnectionRef): ConnectionRef => ({
  name: c.name,
  region: c.region,
  client_id: c.client_id,
});

export const defaultAuditPath = (): string =>
  process.env.AUDIT_LOG_PATH ?? resolve(import.meta.dirname, "../../../.local/audit.log");

const isEntry = (v: unknown): v is AuditEntry =>
  typeof v === "object" &&
  v !== null &&
  "time" in v &&
  typeof v.time === "string" &&
  "action" in v &&
  typeof v.action === "string";

export class AuditLog {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    readonly path: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  // Appends one JSON line. Writes are queued so lines never interleave.
  record(entry: Omit<AuditEntry, "time" | "actor"> & { actor?: string }): Promise<void> {
    const store = context.getStore() ?? {};
    const isChange = USER_CHANGES.includes(entry.action);
    const line: AuditEntry = {
      time: this.now().toISOString(),
      actor: entry.actor ?? store.actor ?? "system",
      ...(store.connection && { connection: store.connection }),
      ...(store.reason && { reason: store.reason }),
      ...(store.purpose && { purpose: store.purpose }),
      ...(isChange && store.target && { target: store.target }),
      ...(isChange && store.changes && { changes: store.changes }),
      ...entry,
    };
    this.queue = this.queue.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      await appendFile(this.path, `${JSON.stringify(line)}\n`, { mode: 0o600 });
    });
    return this.queue;
  }

  // Every entry, newest first.
  private async all(): Promise<AuditEntry[]> {
    await this.queue;
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (e) {
      if (e instanceof Error && "code" in e && e.code === "ENOENT") return [];
      throw e;
    }
    const entries: AuditEntry[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (isEntry(parsed)) entries.push(parsed);
      } catch {
        // Skip a damaged line rather than lose the rest of the log.
      }
    }
    return entries.reverse();
  }

  async latest(limit: number): Promise<AuditEntry[]> {
    return (await this.all()).slice(0, limit);
  }

  // One page of the log, newest first; page 1 is the newest.
  async page(
    page: number,
    size: number,
    failedOnly = false,
  ): Promise<{ entries: AuditEntry[]; total: number }> {
    const all = (await this.all()).filter((e) => !failedOnly || e.outcome === "failed");
    return { entries: all.slice((page - 1) * size, page * size), total: all.length };
  }
}

// Names each Identity API call. Anything unknown is still logged, by method and path.
export const classify = (method: string, path: string): string => {
  const p = path.replace(/^\/api\/authn/, "").replace(/\?.*$/, "");
  if (method === "POST" && p === "/v2/oauth2/token") return "auth.token";
  if (method === "DELETE" && /^\/v2\/oauth2\/client_credentials\/[^/]+\/tokens$/.test(p)) {
    return "auth.revoke_tokens";
  }
  if (method === "DELETE" && /^\/v2\/oauth2\/client_credentials\/[^/]+$/.test(p)) {
    return "auth.revoke_client";
  }
  if (p === "/v2/users" && method === "GET") return "user.list";
  if (p === "/v2/users/search" && method === "GET") return "user.list";
  // The users of one role, read in bulk for the list (docs/PLAN_CACHE.md, phase 4).
  if (p.startsWith("/v2/users/by_role/") && method === "GET") return "user.list";
  if (p === "/v2/users" && method === "POST") return "user.create";
  if (/^\/v2\/users\/[^/]+\/reset_mfa$/.test(p) && method === "POST") return "user.reset_mfa";
  if (/^\/v2\/users\/[^/]+$/.test(p)) {
    if (method === "GET") return "user.read";
    if (method === "PUT") return "user.update";
    if (method === "DELETE") return "user.delete";
  }
  if (p.startsWith("/v2/roles") && method === "GET") return "role.list";
  if (p.startsWith("/v2/teams") && method === "GET") return "team.list";
  return `api.${method.toLowerCase()}`;
};

// The message in an error answer: Veracode's message, error_description or error field, or
// the start of the text.
const refusal = async (res: Response): Promise<string | undefined> => {
  const text = await res.text().catch(() => "");
  try {
    const body: unknown = JSON.parse(text);
    if (typeof body === "object" && body !== null) {
      for (const key of ["message", "error_description", "error"]) {
        const value: unknown = Object.getOwnPropertyDescriptor(body, key)?.value;
        if (typeof value === "string" && value) return value.slice(0, 300);
      }
    }
  } catch {
    // Not JSON: use the text itself.
  }
  return text.trim().slice(0, 300) || undefined;
};

const pick = (v: unknown, key: string): unknown =>
  typeof v === "object" && v !== null ? Object.getOwnPropertyDescriptor(v, key)?.value : undefined;

// What an answer held, as counts only, so no user's details and no token reach the log.
export const summarize = (text: string): string | undefined => {
  if (!text.trim()) return "no content";
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof body !== "object" || body === null) return undefined;
  const page = pick(body, "page");
  const pages = pick(page, "total_pages");
  const number = pick(page, "number");
  const of =
    typeof pages === "number" && pages > 1 && typeof number === "number"
      ? ` (page ${number + 1} of ${pages})`
      : "";
  const embedded = pick(body, "_embedded");
  if (typeof embedded === "object" && embedded !== null) {
    const counts = Object.entries(embedded)
      .filter((e): e is [string, unknown[]] => Array.isArray(e[1]))
      .map(([key, items]) => `${items.length} ${key}`);
    if (counts.length) return counts.join(", ") + of;
  }
  if (page !== undefined) return `none${of}`;
  if (typeof pick(body, "access_token") === "string") return "1 token";
  if (typeof pick(body, "user_id") === "string") {
    return Array.isArray(pick(body, "roles")) ? "1 user, with roles" : "1 user";
  }
  if (typeof pick(body, "team_id") === "string") return "1 team";
  return "1 record";
};

// A token is fetched on the way to some other call: say which.
const tokenPurpose = (): string => {
  const outer = context.getStore()?.purpose;
  return outer ? `Get an access token, for: ${outer}` : "Get an access token";
};

// Wraps fetch so every Veracode call is logged: what, by whom, on which connection, and the
// result. Headers and bodies are never logged, so secrets and tokens stay out. A user change
// carries its own record of what changed, set by the route with withAudit.
export const auditedFetch = (fetchFn: Fetch, log: AuditLog): Fetch => {
  const wrapped = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (
      init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
    const action = classify(method, url.pathname);
    const base = { action, method, path: `${url.host}${url.pathname}${url.search}` };
    const started = performance.now();
    const took = () => Math.round(performance.now() - started);
    const why = action === "auth.token" ? { purpose: tokenPurpose() } : {};
    try {
      const res = await fetchFn(input, init);
      const ms = took();
      // A refused user change keeps Veracode's reason. It's an error message about the
      // request, never a token or secret.
      const reason =
        !res.ok && USER_CHANGES.includes(action) ? await refusal(res.clone()) : undefined;
      const result = res.ok
        ? summarize(
            await res
              .clone()
              .text()
              .catch(() => ""),
          )
        : undefined;
      await log.record({
        ...base,
        ...why,
        outcome: res.ok ? "ok" : "failed",
        status: res.status,
        ms,
        ...(result && { result }),
        ...(reason && { detail: `Veracode: ${reason}` }),
      });
      return res;
    } catch (e) {
      await log.record({
        ...base,
        ...why,
        outcome: "failed",
        ms: took(),
        detail: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }
  };
  return wrapped;
};
