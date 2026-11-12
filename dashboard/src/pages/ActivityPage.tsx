import { useCallback, useEffect, useState } from "react";
import { ExportLogDialog } from "../components/ExportLogDialog";
import { PageHeader } from "../components/PageHeader";
import { Pagination } from "../components/Pagination";
import { StatusPill } from "../components/StatusPill";
import { ApiError, getAudit } from "../lib/api";
import { formatDateTime, formatDuration } from "../lib/format";

const SIZES = [50, 100, 500];
import type { AuditEntry } from "../types";

type Props = { onUnauthorized: () => void; now: Date };

type State =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; entries: AuditEntry[]; total: number };

export function ActivityPage({ onUnauthorized, now }: Props) {
  const [state, setState] = useState<State>({ status: "loading" });
  const [failedOnly, setFailedOnly] = useState(false);
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(50);
  const [exporting, setExporting] = useState(false);
  const [notice, setNotice] = useState("");

  // The backend pages the log, newest first, so only one page is ever loaded.
  const load = useCallback(async () => {
    setState({ status: "loading" });
    try {
      setState({ status: "ready", ...(await getAudit(page, size, failedOnly)) });
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return onUnauthorized();
      setState({ status: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }, [onUnauthorized, page, size, failedOnly]);

  useEffect(() => {
    void load();
  }, [load]);

  const entries = state.status === "ready" ? state.entries : [];

  return (
    <main className="page">
      <PageHeader title="Activity">
        <button type="button" className="btn btn-secondary" onClick={() => void load()}>
          Refresh
        </button>
        <button type="button" className="btn btn-primary" onClick={() => setExporting(true)}>
          Export
        </button>
      </PageHeader>
      {notice && (
        <div className="notice" role="status">
          {notice}
        </div>
      )}
      <p className="muted">
        Every call this app makes to the Veracode Platform, every sign-in, and every connection or
        app user added, removed or expired, newest first. A change to a user shows who made it, the
        user, and each field from and to. Each call to Veracode says why it was made, how long it
        took, and what came back, as counts only. The full log is{" "}
        <span className="mono">.local/audit.log</span>.
      </p>
      <div className="toolbar-row">
        <label className="filter-options">
          <span>
            <input
              type="checkbox"
              checked={failedOnly}
              onChange={(e) => {
                setFailedOnly(e.target.checked);
                setPage(1);
              }}
            />{" "}
            Failed only
          </span>
        </label>
      </div>
      <section className="table-card" aria-label="Activity log">
        {state.status === "loading" && <p className="empty">Loading activity...</p>}
        {state.status === "error" && (
          <p className="empty error-text" role="alert">
            {state.message}
          </p>
        )}
        {state.status === "ready" && entries.length === 0 && (
          <p className="empty">No activity yet.</p>
        )}
        {entries.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>App User</th>
                <th>Action</th>
                <th>Why</th>
                <th>Organization</th>
                <th>User</th>
                <th>Outcome</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e, i) => (
                <tr key={`${e.time}-${i}`}>
                  <td className="nowrap">{formatDateTime(e.time)}</td>
                  <td>{e.actor}</td>
                  <td className="mono">{e.action}</td>
                  <td>{e.purpose ?? ""}</td>
                  <td>{e.connection ?? ""}</td>
                  <td>{e.target ?? ""}</td>
                  <td>
                    <StatusPill tone={e.outcome === "ok" ? "success" : "danger"}>
                      {e.outcome === "ok" ? "OK" : "Failed"}
                    </StatusPill>
                  </td>
                  <td className="roles">
                    {[
                      e.reason && `Reason: ${e.reason}`,
                      e.ms !== null && `Took ${formatDuration(e.ms)}`,
                      e.result && `Got ${e.result}`,
                      e.request,
                      e.detail,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                    {e.changes.length > 0 && (
                      <ul className="change-list" aria-label="Changes">
                        {e.changes.map((c) => (
                          <li key={c.field}>
                            <strong>{c.field}:</strong> {c.from ?? "—"} → {c.to ?? "—"}
                          </li>
                        ))}
                      </ul>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {state.status === "ready" && state.total > 0 && (
          <Pagination
            total={state.total}
            page={page}
            size={size}
            sizes={SIZES}
            onPage={setPage}
            onSize={(s) => {
              setSize(s);
              setPage(1);
            }}
          />
        )}
      </section>
      {exporting && (
        <ExportLogDialog
          today={now}
          onCancel={() => setExporting(false)}
          onExport={(from, to) => {
            setExporting(false);
            setNotice(
              `Export isn't built yet. It will save the entries from ${from} to ${to} as a file.`,
            );
          }}
        />
      )}
    </main>
  );
}
