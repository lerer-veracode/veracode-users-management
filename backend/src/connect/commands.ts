import { auditedFetch, connectionRef, withAudit, type AuditLog } from "../audit/audit.js";
import { REGIONS, isRegion } from "../regions.js";
import { checkAccess, listRoles } from "../veracode/identity.js";
import { inspectApi, inspectUsers } from "./inspect.js";
import { isNoTeamRestriction } from "../veracode/rules.js";
import {
  TokenCache,
  VeracodeError,
  revokeConnection,
  type Fetch,
  type RevokeResult,
} from "../veracode/oauth.js";
import { cleanUp } from "../vault/cleanup.js";
import type { Cost } from "../vault/crypto.js";
import { readVault, writeVault } from "../vault/file.js";
import { MAX_AGE_DAYS, daysLeft } from "../vault/retention.js";
import {
  VaultError,
  addUser,
  createVault,
  newConnection,
  recordSignIn,
  removeUser,
  saveData,
  unlock,
  type Connection,
  type Session,
} from "../vault/vault.js";
import { CancelledError, type Prompter } from "./prompt.js";

export type Deps = {
  prompt: Prompter;
  out: (line: string) => void;
  fetch: Fetch;
  now: () => Date;
  vaultPath: string;
  audit: AuditLog;
  cost?: Cost;
};

export const HELP = `Usage: npm run connect -- <command>

  add                  Add a Veracode connection (the default)
  list                 List connections and app users
  remove [name]        Remove a connection and revoke it on Veracode
  add-user             Add an app user who can open the vault
  remove-user [name]   Remove an app user
  inspect [name]       Show the structure of Veracode's answers (no values), for debugging
  inspect-user USER_NAME ... [--email ADDRESS] [--connection NAME]
                       Show users' full Veracode records (sign-in secrets hidden), read only.
                       --email shows every user with that email address
  permissions [name]   List every permission the organization's roles carry, read only,
                       to choose which to hide in config/hidden-permissions.txt
  roles [name]         List the organization's roles with how the app groups them, read only
  help                 Show this help

Connections are removed ${MAX_AGE_DAYS} days after they are added. App users are removed
after ${MAX_AGE_DAYS} days without signing in.`;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const day = (iso: string) => {
  const d = new Date(iso);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
};
const left = (iso: string, now: Date) => {
  const n = daysLeft(iso, now);
  return n === 1 ? "1 day left" : `${n} days left`;
};

const ref = (c: Pick<Connection, "name" | "region" | "client_id">) =>
  connectionRef({ ...c, region: REGIONS[c.region].label });

class Cli {
  // Every call to Veracode goes through this, so every call is in the audit log.
  private readonly veracode: Fetch;

  constructor(private readonly deps: Deps) {
    this.veracode = auditedFetch(deps.fetch, deps.audit);
  }

  private say(line = "") {
    this.deps.out(line);
  }

  private async save(session: Session) {
    await writeVault(this.deps.vaultPath, session.file);
  }

  private async confirm(question: string) {
    return /^y(es)?$/i.test(await this.deps.prompt.ask(`${question} (y/N): `));
  }

  private async newPassword() {
    const first = await this.deps.prompt.askHidden("Password (at least 12 characters): ");
    const second = await this.deps.prompt.askHidden("Password again: ");
    if (first !== second) throw new VaultError("The passwords don't match.");
    return first;
  }

  async create(): Promise<Session> {
    this.say("No vault yet. Creating one, with you as its first app user.");
    const username = await this.deps.prompt.ask("Choose a username: ");
    const password = await this.newPassword();
    const session = await createVault(username, password, this.deps.now(), this.deps.cost);
    await this.save(session);
    await this.deps.audit.record({
      actor: session.username,
      action: "app_user.added",
      outcome: "ok",
      detail: "Created the vault and its first app user.",
    });
    this.say(`Vault created at ${this.deps.vaultPath} for ${session.username}.`);
    return session;
  }

  async signIn(): Promise<Session> {
    const file = await readVault(this.deps.vaultPath);
    if (!file) return this.create();
    const username = await this.deps.prompt.ask("Username: ");
    const password = await this.deps.prompt.askHidden("Password: ");
    const now = this.deps.now();
    let session;
    try {
      session = recordSignIn(await unlock(file, username, password, now), now);
    } catch (e) {
      if (e instanceof VaultError) {
        await this.deps.audit.record({
          actor: username.trim().toLowerCase(),
          action: "app.sign_in",
          outcome: "failed",
          detail: `npm run connect: ${e.message}`,
        });
      }
      throw e;
    }
    await this.deps.audit.record({
      actor: session.username,
      action: "app.sign_in",
      outcome: "ok",
      detail: "npm run connect",
    });
    this.say(`Signed in as ${session.username}.`);

    const signedIn = session;
    const cleaned = await withAudit({ actor: session.username }, () =>
      cleanUp(signedIn, now, this.veracode, this.deps.audit),
    );
    session = cleaned.session;
    for (const name of cleaned.report.removedUsers) {
      this.say(`Removed app user ${name}: no sign-in for ${MAX_AGE_DAYS} days.`);
    }
    for (const { connection, results } of cleaned.report.revoked) {
      this.say(
        `Connection ${connection.name} is ${MAX_AGE_DAYS} days old. Revoked it on Veracode:`,
      );
      this.report(results);
    }
    await this.save(session);
    return session;
  }

  private async revoke(conn: Connection) {
    const results = await revokeConnection(conn, this.veracode, this.deps.now().getTime());
    this.report(results);
    return results;
  }

  private report(results: RevokeResult[]) {
    for (const r of results) this.say(`  ${r.ok ? "OK" : "FAILED"}  ${r.step}: ${r.message}`);
    if (results.some((r) => !r.ok)) {
      this.say(
        "  Check the client on the Veracode Platform and revoke it there if it's still active.",
      );
    }
  }

  async add(session: Session) {
    const name = await this.deps.prompt.ask("Connection name (for example, the organization): ");
    if (!name) throw new VaultError("A connection needs a name.");
    if (session.data.connections.some((c) => c.name.toLowerCase() === name.toLowerCase())) {
      throw new VaultError(`A connection named ${name} already exists.`);
    }
    const regions = Object.keys(REGIONS).join(", ");
    const region = (
      (await this.deps.prompt.ask(`Region (${regions}) [us]: `)) || "us"
    ).toLowerCase();
    if (!isRegion(region)) throw new VaultError(`Region must be one of: ${regions}.`);
    const clientId = await this.deps.prompt.ask("OAuth client ID: ");
    const clientSecret = await this.deps.prompt.askHidden("OAuth client secret: ");
    if (!clientId || !clientSecret) throw new VaultError("The client ID and secret are required.");

    const creds = { region, client_id: clientId, client_secret: clientSecret };
    this.say(`Testing the connection on ${REGIONS[region].label}...`);
    const check = await withAudit(
      { connection: ref({ name, ...creds }), reason: "add" },
      async () => {
        const result = await checkAccess(creds, new TokenCache(this.veracode), this.veracode);
        await this.deps.audit.record({
          action: "auth.check",
          outcome: result.ok ? "ok" : "failed",
          detail: result.message,
        });
        return result;
      },
    );
    this.say(`  ${check.ok ? "OK" : "FAILED"}  ${check.message}`);
    if (!check.ok && !(await this.confirm("Save it anyway?"))) {
      this.say("Not saved.");
      return;
    }
    const conn = newConnection({ name, ...creds }, this.deps.now());
    await this.save(
      saveData(session, { ...session.data, connections: [...session.data.connections, conn] }),
    );
    await this.deps.audit.record({
      action: "connection.added",
      outcome: "ok",
      connection: ref(conn),
      detail: `Removed on ${conn.removes_at} (${MAX_AGE_DAYS} days).${check.ok ? "" : " Saved although its check failed."}`,
    });
    this.say(
      `Saved ${name}. It will be removed on ${day(conn.removes_at)} (${MAX_AGE_DAYS} days).`,
    );
  }

  list(session: Session) {
    const now = this.deps.now();
    this.say("Connections:");
    if (session.data.connections.length === 0) this.say("  none");
    for (const c of session.data.connections) {
      this.say(
        `  ${c.name}  ${REGIONS[c.region].label}  ${c.client_id}  added ${day(c.added_at)}  ${left(c.removes_at, now)}`,
      );
    }
    this.say("App users:");
    for (const u of session.file.users) {
      this.say(`  ${u.username}  last sign-in ${day(u.last_sign_in)}  ${left(u.removes_at, now)}`);
    }
  }

  async remove(session: Session, arg: string | undefined) {
    const name = arg ?? (await this.deps.prompt.ask("Connection to remove: "));
    const conn = session.data.connections.find((c) => c.name.toLowerCase() === name.toLowerCase());
    if (!conn) throw new VaultError(`No connection named ${name}.`);
    if (!(await this.confirm(`Remove ${conn.name} and revoke it on Veracode?`))) {
      this.say("Nothing removed.");
      return;
    }
    await withAudit({ connection: ref(conn), reason: "removed" }, async () => {
      const results = await this.revoke(conn);
      await this.save(
        saveData(session, {
          ...session.data,
          connections: session.data.connections.filter((c) => c.id !== conn.id),
        }),
      );
      await this.deps.audit.record({
        action: "connection.removed",
        outcome: results.every((r) => r.ok) ? "ok" : "failed",
        detail: results.map((r) => `${r.step}: ${r.message}`).join("; "),
      });
    });
    this.say(`Removed ${conn.name}.`);
  }

  async addUser(session: Session) {
    const username = await this.deps.prompt.ask("New app user's username: ");
    const password = await this.newPassword();
    const updated = await addUser(session, username, password, this.deps.now(), this.deps.cost);
    await this.save(updated);
    await this.deps.audit.record({
      action: "app_user.added",
      outcome: "ok",
      detail: `Added app user ${username.trim().toLowerCase()}.`,
    });
    this.say(`Added app user ${username.trim().toLowerCase()}.`);
  }

  async inspect(session: Session, arg: string | undefined) {
    const conn = arg
      ? session.data.connections.find((c) => c.name.toLowerCase() === arg.toLowerCase())
      : session.data.connections[0];
    if (!conn) throw new VaultError(arg ? `No connection named ${arg}.` : "No connections yet.");
    this.say(`Inspecting ${conn.name} (${REGIONS[conn.region].label}). Structure only, no values.`);
    this.say("");
    await withAudit({ connection: ref(conn), reason: "inspect" }, () =>
      inspectApi(conn, new TokenCache(this.veracode), this.veracode, (line) => this.say(line)),
    );
  }

  private async readRoles(
    session: Session,
    arg: string | undefined,
    reason: string,
    purpose: string,
  ) {
    const conn = arg
      ? session.data.connections.find((c) => c.name.toLowerCase() === arg.toLowerCase())
      : session.data.connections[0];
    if (!conn) throw new VaultError(arg ? `No connection named ${arg}.` : "No connections yet.");
    const roles = await withAudit({ connection: ref(conn), reason, purpose }, () =>
      listRoles(conn, new TokenCache(this.veracode), this.veracode),
    );
    return { conn, roles };
  }

  // Each role with what the app reads from it, to check how the Users page groups roles
  // (docs/PLAN_ROLES.md, phase 2).
  async roles(session: Session, arg: string | undefined) {
    const { conn, roles } = await this.readRoles(session, arg, "roles", "List the roles");
    this.say(`${roles.length} roles in ${conn.name} (${REGIONS[conn.region].label}), read only:`);
    this.say("");
    const sorted = [...roles].sort((a, b) => a.role_description.localeCompare(b.role_description));
    for (const r of sorted) {
      const marks = [
        r.is_api && "API",
        r.is_scan_type && "scan type",
        r.ignore_team_restrictions && "all teams",
        isNoTeamRestriction(r) && "team setting",
      ].filter(Boolean);
      this.say(
        `${r.role_description}  (${r.role_name})${marks.length > 0 ? `  [${marks.join(", ")}]` : ""}`,
      );
    }
  }

  async permissions(session: Session, arg: string | undefined) {
    const { conn, roles } = await this.readRoles(
      session,
      arg,
      "permissions",
      "List the permissions",
    );
    const all = new Map<string, string>();
    for (const r of roles) {
      for (const p of r.permissions) all.set(p.permission_name, p.permission_description);
    }
    const lines = [...all]
      .map(([name, description]) => `${description}  (${name})`)
      .sort((a, b) => a.localeCompare(b));
    this.say(
      `${lines.length} permissions in ${conn.name} (${REGIONS[conn.region].label}), read only:`,
    );
    this.say("");
    for (const line of lines) this.say(line);
  }

  async inspectUser(session: Session, args: string[]) {
    // Options take the next word: --connection <name>, --email <address> (repeatable).
    let connName: string | undefined;
    const names: string[] = [];
    const emails: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i] ?? "";
      if (a === "--connection") connName = args[++i];
      else if (a === "--email") emails.push(args[++i] ?? "");
      else names.push(a);
    }
    if (names.length === 0 && emails.filter(Boolean).length === 0) {
      throw new VaultError(
        "Say which users: npm run connect -- inspect-user USER_NAME ... or --email ADDRESS",
      );
    }
    const conn = connName
      ? session.data.connections.find((c) => c.name.toLowerCase() === connName.toLowerCase())
      : session.data.connections[0];
    if (!conn) {
      throw new VaultError(connName ? `No connection named ${connName}.` : "No connections yet.");
    }
    this.say(
      `Reading from ${conn.name} (${REGIONS[conn.region].label}). Read only; sign-in secrets hidden.`,
    );
    this.say("");
    await withAudit({ connection: ref(conn), reason: "inspect-user" }, () =>
      inspectUsers(
        conn,
        new TokenCache(this.veracode),
        this.veracode,
        { names, emails: emails.filter(Boolean) },
        (line) => this.say(line),
      ),
    );
  }

  async removeUser(session: Session, arg: string | undefined) {
    const name = arg ?? (await this.deps.prompt.ask("App user to remove: "));
    const updated = removeUser(session, name);
    if (!(await this.confirm(`Remove app user ${name}?`))) {
      this.say("Nothing removed.");
      return;
    }
    await this.save(updated);
    await this.deps.audit.record({
      action: "app_user.removed",
      outcome: "ok",
      detail: `Removed app user ${name}.`,
    });
    this.say(`Removed app user ${name}.`);
  }
}

const COMMANDS = [
  "add",
  "list",
  "remove",
  "add-user",
  "remove-user",
  "inspect",
  "inspect-user",
  "permissions",
  "roles",
];

export const runConnect = async (args: string[], deps: Deps): Promise<number> => {
  const [command = "add", arg] = args;
  const rest = args.slice(1);
  if (command === "help" || command === "--help" || command === "-h") {
    deps.out(HELP);
    return 0;
  }
  if (!COMMANDS.includes(command)) {
    deps.out(`Unknown command: ${command}\n\n${HELP}`);
    return 1;
  }
  const cli = new Cli(deps);
  try {
    const session = await cli.signIn();
    await withAudit({ actor: session.username }, async () => {
      if (command === "add") await cli.add(session);
      if (command === "list") cli.list(session);
      if (command === "remove") await cli.remove(session, arg);
      if (command === "add-user") await cli.addUser(session);
      if (command === "remove-user") await cli.removeUser(session, arg);
      if (command === "inspect") await cli.inspect(session, arg);
      if (command === "inspect-user") await cli.inspectUser(session, rest);
      if (command === "permissions") await cli.permissions(session, arg);
      if (command === "roles") await cli.roles(session, arg);
    });
    return 0;
  } catch (e) {
    // Veracode's refusals are reported as a message, not a crash.
    if (e instanceof VaultError || e instanceof CancelledError || e instanceof VeracodeError) {
      deps.out(e.message);
      return 1;
    }
    throw e;
  }
};
