import type { ImportResult } from "../lib/api";
import type { PlannedRow } from "../lib/importPlan";
import { StatusPill } from "./StatusPill";

type Props = {
  results: ImportResult[];
  // The preview's rows, for each row's email and the roles left out.
  plan: PlannedRow[];
  onDone: () => void;
};

const names = (list: { role_description: string }[]) =>
  list.map((r) => r.role_description).join(", ");

// What a CSV import did, row by row (docs/PLAN_CSV.md, phase 2). Rows with errors in the
// preview were never sent, and are listed as skipped.
export function ImportReport({ results, plan, onDone }: Props) {
  const byLine = new Map(results.map((r) => [r.line, r]));
  const rows = plan.map((p) => ({ plan: p, result: byLine.get(p.line) }));
  const created = rows.filter((r) => r.result?.status === "created");
  const failed = rows.filter((r) => r.result?.status === "failed");
  const skipped = rows.filter((r) => !r.result);
  const missing = created.filter((r) => r.plan.leftOut.length > 0);

  return (
    <>
      <div className="summary" role="status" aria-label="Import result">
        <StatusPill tone="success">{`${created.length} created`}</StatusPill>
        <StatusPill tone="danger">{`${failed.length} failed`}</StatusPill>
        <StatusPill tone="muted">{`${skipped.length} skipped`}</StatusPill>
      </div>
      {missing.length > 0 && (
        <div className="notice" role="note" aria-label="Roles to give by hand">
          <p>
            {missing.map((r) => r.plan.user_name).join(", ")}{" "}
            {missing.length === 1 ? "was" : "were"} created without roles that need a team. Give
            them by hand in the user&apos;s form on the Users page:
          </p>
          <ul>
            {missing.map((r) => (
              <li key={r.plan.line}>
                {r.plan.user_name}: {names(r.plan.leftOut)}
              </li>
            ))}
          </ul>
        </div>
      )}
      <section className="table-card" aria-label="Import report">
        <table>
          <thead>
            <tr>
              <th>Line</th>
              <th>Email</th>
              <th>User Name</th>
              <th>Result</th>
              <th>Details</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ plan: p, result }) => (
              <tr key={p.line}>
                <td className="mono">{p.line}</td>
                <td>{p.email_address}</td>
                <td>{p.user_name}</td>
                <td>
                  {result?.status === "created" ? (
                    <StatusPill tone="success">Created</StatusPill>
                  ) : result ? (
                    <StatusPill tone="danger">Failed</StatusPill>
                  ) : (
                    <StatusPill tone="muted">Skipped</StatusPill>
                  )}
                </td>
                <td>
                  {result?.status === "failed" && (
                    <span className="error-text">{result.error}</span>
                  )}
                  {!result && <span className="muted">{p.errors.join("; ")}</span>}
                  {result?.status === "created" && p.leftOut.length > 0 && (
                    <span className="muted">Without, needs a team: {names(p.leftOut)}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <div className="toolbar spaced">
        <span className="muted">The Users page shows the new users.</span>
        <button type="button" className="btn btn-outline" onClick={onDone}>
          Import Another File
        </button>
      </div>
    </>
  );
}
