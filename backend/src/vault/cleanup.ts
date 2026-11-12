import { connectionRef, withAudit, type AuditLog } from "../audit/audit.js";
import { revokeConnection, type Fetch, type RevokeResult } from "../veracode/oauth.js";
import { MAX_AGE_DAYS } from "./retention.js";
import {
  expiredConnections,
  removeExpiredUsers,
  saveData,
  type Connection,
  type Session,
} from "./vault.js";

export type CleanupReport = {
  removedUsers: string[];
  revoked: { connection: Connection; results: RevokeResult[] }[];
};

export const cleanUp = async (
  session: Session,
  now: Date,
  fetchFn: Fetch,
  audit: AuditLog,
): Promise<{ session: Session; report: CleanupReport }> => {
  const users = removeExpiredUsers(session, now);
  let next = users.session;
  for (const username of users.removed) {
    await audit.record({
      action: "app_user.expired",
      outcome: "ok",
      detail: `Removed app user ${username}: no sign-in for ${MAX_AGE_DAYS} days.`,
    });
  }
  const expired = expiredConnections(next.data, now);
  const revoked = [];
  for (const connection of expired) {
    const results = await withAudit(
      { connection: connectionRef(connection), reason: "expired" },
      async () => {
        const res = await revokeConnection(connection, fetchFn, now.getTime());
        await audit.record({
          action: "connection.expired",
          outcome: res.every((r) => r.ok) ? "ok" : "failed",
          detail: `Removed after ${MAX_AGE_DAYS} days. ${res.map((r) => `${r.step}: ${r.message}`).join("; ")}`,
        });
        return res;
      },
    );
    revoked.push({ connection, results });
  }
  if (expired.length > 0) {
    const ids = expired.map((c) => c.id);
    next = saveData(next, {
      ...next.data,
      connections: next.data.connections.filter((c) => !ids.includes(c.id)),
    });
  }
  return { session: next, report: { removedUsers: users.removed, revoked } };
};
