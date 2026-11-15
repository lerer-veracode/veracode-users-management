import { useState, type ChangeEvent, type ComponentProps } from "react";
import { ConnectionPicker } from "../components/ConnectionPicker";
import { PageHeader } from "../components/PageHeader";
import { StatusPill } from "../components/StatusPill";
import type { DirectoryState } from "../hooks/useDirectory";
import { CSV_COLUMNS, SAMPLE_CSV, parseUsersCsv } from "../lib/csv";
import { readText } from "../lib/readFile";
import {
  csvRoles,
  csvScanTypes,
  needsTeamNote,
  planImport,
  type PlannedRow,
} from "../lib/importPlan";

type Props = {
  state: DirectoryState;
  picker: Omit<ComponentProps<typeof ConnectionPicker>, "what">;
};

// The sample offered for download, as a link the browser saves.
const SAMPLE_HREF = `data:text/csv;charset=utf-8,${encodeURIComponent(SAMPLE_CSV)}`;

const names = (list: { role_description: string }[]) =>
  list.map((r) => r.role_description).join(", ");

export function ImportPage({ state, picker }: Props) {
  const [fileName, setFileName] = useState("");
  const [text, setText] = useState("");
  // The instructions fold away once a file is read, leaving the page to its users.
  const [helpOpen, setHelpOpen] = useState(true);

  const ready = state.status === "ready";
  const parsed = text ? parseUsersCsv(text) : null;
  const plan: PlannedRow[] =
    parsed && ready ? planImport(parsed.rows, state.users, state.roles) : [];
  const creates = plan.filter((p) => p.action === "Create");
  const missingRoles = creates.filter((p) => p.leftOut.length > 0);
  const errors = plan.filter((p) => p.action === "Error");

  const pick = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    setText(await readText(file));
    setHelpOpen(false);
    // The same file can be chosen again after it's changed.
    e.target.value = "";
  };
  const loaded = parsed !== null && !parsed.error;
  const showHelp = helpOpen || !loaded;
  const chooser = (label: string) => (
    <label className="btn btn-outline">
      {label}
      <input type="file" accept=".csv,text/csv" hidden onChange={pick} aria-label="CSV file" />
    </label>
  );

  return (
    <main className="page">
      <PageHeader title="Import Users from CSV" />
      <ConnectionPicker {...picker} what="Compared with users" />
      {state.status === "loading" && (
        <div className="notice" role="status">
          Loading users and roles from Veracode...
        </div>
      )}
      {state.status === "error" && (
        <div className="notice error-text" role="alert">
          {state.message}
        </div>
      )}
      {loaded && (
        <section className="panel file-bar" aria-label="Chosen file">
          <span>
            File: <strong>{fileName}</strong>
            <span className="muted">
              {" "}
              · {parsed.rows.length} {parsed.rows.length === 1 ? "row" : "rows"}
            </span>
          </span>
          <span className="drop-actions">
            {!showHelp && chooser("Choose Another File")}
            <button
              type="button"
              className="link"
              aria-expanded={showHelp}
              onClick={() => setHelpOpen(!helpOpen)}
            >
              {showHelp ? "Hide instructions" : "Show instructions"}
            </button>
          </span>
        </section>
      )}
      {showHelp && (
        <section className="panel drop" aria-label="Instructions">
          <p className="muted">
            Columns: <span className="mono">{CSV_COLUMNS.join(", ")}</span>
          </p>
          <ul className="muted csv-help" aria-label="CSV format">
            <li>Email address and roles are required.</li>
            <li>An empty user name is the email address.</li>
            <li>
              Roles by their names on the Platform, for example Security Lead. Separate several with{" "}
              <span className="mono">;</span>.
            </li>
            <li>
              Scan types: empty for All, or one or more of the types listed below, separated with{" "}
              <span className="mono">;</span>. Only Security Lead, Creator and Submitter take them.
            </li>
            <li>
              The import creates new users only: a row whose user name is already used is skipped.
            </li>
            <li>
              Teams can&apos;t be set from a CSV yet, so roles that need a team are left out. Give
              them by hand in the user&apos;s form afterwards.
            </li>
          </ul>
          <p className="muted">
            New to this? Start from the{" "}
            <a href={SAMPLE_HREF} download="users-import-sample.csv">
              sample CSV
            </a>
            : three example users, one for each way of writing a row. Replace them with your own.
          </p>
          <div className="drop-actions">
            {chooser(loaded ? "Choose Another File" : "Choose CSV File")}
          </div>
          {parsed?.error && (
            <p className="error-text" role="alert">
              {parsed.error}
            </p>
          )}
          {ready && (
            <div className="csv-names">
              <div>
                <h3 className="small">Roles</h3>
                <ul className="small" aria-label="Roles for the CSV">
                  {csvRoles(state.roles).map((r) => (
                    <li key={r.role_name}>
                      {r.role_description}
                      {needsTeamNote(r) && <span className="muted"> ({needsTeamNote(r)})</span>}
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <h3 className="small">Scan types</h3>
                <ul className="small" aria-label="Scan types for the CSV">
                  <li>All (the default)</li>
                  {csvScanTypes(state.roles).map((r) => (
                    <li key={r.role_name}>{r.role_description}</li>
                  ))}
                </ul>
              </div>
            </div>
          )}
        </section>
      )}

      {plan.length > 0 && (
        <>
          <div className="summary">
            <StatusPill tone="info">{`${creates.length} to create`}</StatusPill>
            <StatusPill tone="warning">{`${missingRoles.length} without some roles`}</StatusPill>
            <StatusPill tone="danger">{`${errors.length} with errors`}</StatusPill>
          </div>
          {missingRoles.length > 0 && (
            <div className="notice" role="note" aria-label="Roles left out">
              <p>
                These users will be created without roles that need a team. Give them by hand in the
                user&apos;s form:
              </p>
              <ul>
                {missingRoles.map((p) => (
                  <li key={p.line}>
                    {p.user_name}: {names(p.leftOut)}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <section className="table-card" aria-label="Import preview">
            <table>
              <thead>
                <tr>
                  <th>Line</th>
                  <th>Email</th>
                  <th>User Name</th>
                  <th>Name</th>
                  <th>Roles</th>
                  <th>Scan Types</th>
                  <th>Action</th>
                  <th>Problems</th>
                </tr>
              </thead>
              <tbody>
                {plan.map((row) => (
                  <tr key={row.line}>
                    <td className="mono">{row.line}</td>
                    <td>{row.email_address}</td>
                    <td>{row.user_name}</td>
                    <td>
                      {row.first_name} {row.last_name}
                    </td>
                    <td className="roles">
                      {row.action === "Create"
                        ? names(
                            row.give.filter((r) => r.kind !== "scan_type" && r.kind !== "any_scan"),
                          )
                        : row.roles.join(", ")}
                    </td>
                    <td>{row.action === "Create" ? row.scanTypes : row.scan_types.join(", ")}</td>
                    <td>
                      <StatusPill tone={row.action === "Create" ? "info" : "danger"}>
                        {row.action}
                      </StatusPill>
                    </td>
                    <td>
                      {row.errors.length > 0 && (
                        <span className="error-text">{row.errors.join("; ")}</span>
                      )}
                      {row.action === "Create" && row.leftOut.length > 0 && (
                        <span className="muted">Left out, needs a team: {names(row.leftOut)}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          <div className="toolbar spaced">
            <span className="muted">Applying the import comes in the next phase.</span>
            <button type="button" className="btn btn-primary" disabled>
              Create {creates.length} Users
            </button>
          </div>
        </>
      )}
    </main>
  );
}
