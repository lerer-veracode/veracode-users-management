import { useEffect, useState } from "react";
import { PageHeader } from "../components/PageHeader";
import { RemovalPill } from "../components/RemovalPill";
import { StatusPill } from "../components/StatusPill";
import type { ConnectionsState } from "../hooks/useConnections";
import {
  ApiError,
  getAppUsers,
  testConnection,
  selectConnection,
  type TestResult,
} from "../lib/api";
import { formatDateTime } from "../lib/format";
import { MAX_AGE_DAYS } from "../lib/retention";
import type { AppUser } from "../types";

type Props = {
  state: ConnectionsState;
  reload: () => Promise<void>;
  now: Date;
  onUnauthorized: () => void;
};

export function ConnectionsPage({ state, reload, now, onUnauthorized }: Props) {
  const [results, setResults] = useState<Record<string, TestResult | "testing">>({});
  const [appUsers, setAppUsers] = useState<AppUser[] | null>(null);
  const [error, setError] = useState("");

  const handle = (e: unknown) => {
    if (e instanceof ApiError && e.status === 401) return onUnauthorized();
    setError(e instanceof Error ? e.message : String(e));
  };

  useEffect(() => {
    getAppUsers()
      .then(setAppUsers)
      .catch((e: unknown) => {
        if (e instanceof ApiError && e.status === 401) onUnauthorized();
        else setError(e instanceof Error ? e.message : String(e));
      });
  }, [onUnauthorized]);

  const test = async (id: string) => {
    setResults((r) => ({ ...r, [id]: "testing" }));
    try {
      const result = await testConnection(id);
      setResults((r) => ({ ...r, [id]: result }));
      await reload();
    } catch (e) {
      handle(e);
    }
  };

  const use = async (id: string) => {
    try {
      await selectConnection(id);
      await reload();
    } catch (e) {
      handle(e);
    }
  };

  return (
    <main className="page">
      <PageHeader title="Connections" />

      <section className="panel" aria-label="Add a connection">
        <p>
          To add or remove a connection or an app user, run this in a terminal at the project
          folder. It asks you to sign in first.
        </p>
        <pre className="cmd">npm run connect</pre>
        <p className="muted">
          Secrets are kept in the encrypted vault and never shown here. Tokens are requested when
          needed and kept in memory only. Each connection is removed {MAX_AGE_DAYS} days after it is
          added, and its tokens and client are revoked on Veracode. App users are kept while they
          sign in: each sign-in extends them to {MAX_AGE_DAYS} days from then.
        </p>
      </section>

      {error && (
        <div className="notice spaced" role="alert">
          {error}
        </div>
      )}

      <section className="table-card spaced" aria-label="Saved connections">
        {state.status === "loading" && <p className="empty">Loading connections...</p>}
        {state.status === "error" && (
          <p className="empty error-text" role="alert">
            {state.message}
          </p>
        )}
        {state.status === "ready" && state.connections.length === 0 && (
          <p className="empty">
            No connections yet. Add one with <span className="mono">npm run connect</span>.
          </p>
        )}
        {state.status === "ready" && state.connections.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Organization</th>
                <th>Region</th>
                <th>Client ID</th>
                <th>Token</th>
                <th>Removed In</th>
                <th>Test</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {state.connections.map((c) => {
                const result = results[c.id];
                return (
                  <tr key={c.id}>
                    <td>{c.name}</td>
                    <td>{c.region}</td>
                    <td className="mono">{c.client_id}</td>
                    <td>
                      {c.token_expires ? (
                        <StatusPill tone="success">{`Valid until ${formatDateTime(c.token_expires)}`}</StatusPill>
                      ) : (
                        <StatusPill tone="muted">No token</StatusPill>
                      )}
                    </td>
                    <td>
                      <RemovalPill removesAt={c.removes_at} now={now} />
                    </td>
                    <td>
                      {result === "testing" && <span className="muted">Testing...</span>}
                      {result && result !== "testing" && (
                        <span title={result.message}>
                          <StatusPill tone={result.ok ? "success" : "danger"}>
                            {result.ok ? "Connected" : "Failed"}
                          </StatusPill>
                          {!result.ok && (
                            <span className="error-text test-message">{result.message}</span>
                          )}
                        </span>
                      )}
                      {!result && (
                        <button
                          type="button"
                          className="link"
                          aria-label={`Test ${c.name}`}
                          onClick={() => void test(c.id)}
                        >
                          Test
                        </button>
                      )}
                    </td>
                    <td>
                      {c.active ? (
                        <StatusPill tone="info">In use</StatusPill>
                      ) : (
                        <button
                          type="button"
                          className="link"
                          aria-label={`Use ${c.name}`}
                          onClick={() => void use(c.id)}
                        >
                          Use
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      <section className="table-card spaced" aria-label="App users">
        {appUsers === null ? (
          <p className="empty">Loading app users...</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>App User</th>
                <th>Added</th>
                <th>Last Sign-in</th>
                <th>Removed In</th>
              </tr>
            </thead>
            <tbody>
              {appUsers.map((u) => (
                <tr key={u.username}>
                  <td>{u.username}</td>
                  <td>{formatDateTime(u.added_at)}</td>
                  <td>{formatDateTime(u.last_sign_in)}</td>
                  <td>
                    <RemovalPill removesAt={u.removes_at} now={now} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}
