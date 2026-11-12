import { useState, type ChangeEvent, type ComponentProps } from "react";
import { ConnectionPicker } from "../components/ConnectionPicker";
import { PageHeader } from "../components/PageHeader";
import { StatusPill, type PillTone } from "../components/StatusPill";
import type { DirectoryState } from "../hooks/useDirectory";
import { parseUsersCsv } from "../lib/csv";
import { readText } from "../lib/readFile";
import { planImport, type ImportAction, type PlannedRow } from "../lib/importPlan";

const TONES: Record<ImportAction, PillTone> = {
  Create: "info",
  Update: "warning",
  "No change": "muted",
  Error: "danger",
};

type Props = {
  state: DirectoryState;
  picker: Omit<ComponentProps<typeof ConnectionPicker>, "what">;
};

export function ImportPage({ state, picker }: Props) {
  const [fileName, setFileName] = useState("");
  const [text, setText] = useState("");

  const ready = state.status === "ready";
  const parsed = text ? parseUsersCsv(text) : null;
  const plan: PlannedRow[] =
    parsed && ready ? planImport(parsed.rows, state.users, state.roles) : [];
  const count = (a: ImportAction) => plan.filter((p) => p.action === a).length;
  const changes = plan.filter((p) => p.action === "Create" || p.action === "Update");

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
          Columns:{" "}
          <span className="mono">user_name, email_address, first_name, last_name, roles</span>.
          Separate roles with <span className="mono">;</span>. Rows match existing users by email,
          and roles are checked against the organization&apos;s real roles.
        </p>
        <label className="btn btn-outline">
          Choose CSV File
          <input type="file" accept=".csv,text/csv" hidden onChange={pick} aria-label="CSV file" />
        </label>
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
            <StatusPill tone="info">{`${count("Create")} to create`}</StatusPill>
            <StatusPill tone="warning">{`${count("Update")} to update`}</StatusPill>
            <StatusPill tone="muted">{`${count("No change")} unchanged`}</StatusPill>
            <StatusPill tone="danger">{`${count("Error")} with errors`}</StatusPill>
          </div>
          <section className="table-card" aria-label="Import preview">
            <table>
              <thead>
                <tr>
                  <th>Line</th>
                  <th>User Name</th>
                  <th>Email</th>
                  <th>Name</th>
                  <th>Roles</th>
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
                    <td className="roles">{row.roles.join(", ")}</td>
                    <td>
                      <StatusPill tone={TONES[row.action]}>{row.action}</StatusPill>
                    </td>
                    <td className="error-text">{row.errors.join("; ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          <div className="toolbar spaced">
            <span className="muted">Applying the import comes with user changes, next.</span>
            <button type="button" className="btn btn-primary" disabled>
              Apply {changes.length} Changes
            </button>
          </div>
        </>
      )}
    </main>
  );
}
