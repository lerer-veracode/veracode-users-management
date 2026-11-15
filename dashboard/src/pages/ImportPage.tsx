import { useState, type ChangeEvent, type ComponentProps } from "react";
import { ConnectionPicker } from "../components/ConnectionPicker";
import { PageHeader } from "../components/PageHeader";
import { StatusPill } from "../components/StatusPill";
import type { DirectoryState } from "../hooks/useDirectory";
import { CSV_COLUMNS, SAMPLE_CSV, parseUsersCsv } from "../lib/csv";
import { downloadText } from "../lib/download";
import { readText } from "../lib/readFile";
import { planImport, type PlannedRow } from "../lib/importPlan";

type Props = {
  state: DirectoryState;
  picker: Omit<ComponentProps<typeof ConnectionPicker>, "what">;
};

const names = (list: { role_description: string }[]) =>
  list.map((r) => r.role_description).join(", ");

export function ImportPage({ state, picker }: Props) {
  const [fileName, setFileName] = useState("");
  const [text, setText] = useState("");

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
  };

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
      <section className="panel drop">
        <p className="muted">
          Columns: <span className="mono">{CSV_COLUMNS.join(", ")}</span>. Email address and roles
          are required. An empty user name is the email address; empty scan types are All. Separate
          roles and scan types with <span className="mono">;</span>. Scan types are All, or
          Container, Discovery, Dynamic Analysis, Infrastructure as Code and Static.
        </p>
        <p className="muted">
          The import creates new users only: a row whose user name is already used is skipped. Teams
          can&apos;t be set from a CSV yet, so roles that need a team (Team Admin, and Creator or
          Submitter without Security Lead) are left out. Give them by hand in the user&apos;s form
          afterwards.
        </p>
        <label className="btn btn-outline">
          Choose CSV File
          <input type="file" accept=".csv,text/csv" hidden onChange={pick} aria-label="CSV file" />
        </label>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => downloadText("sample_users.csv", SAMPLE_CSV)}
        >
          Download Sample CSV
        </button>
        {fileName && <span>{fileName}</span>}
        {parsed?.error && (
          <p className="error-text" role="alert">
            {parsed.error}
          </p>
        )}
      </section>

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
                  <th>User Name</th>
                  <th>Email</th>
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
                    <td>{row.user_name}</td>
                    <td>{row.email_address}</td>
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
