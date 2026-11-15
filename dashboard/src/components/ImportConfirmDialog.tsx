import { useState } from "react";
import type { PlannedRow } from "../lib/importPlan";
import type { Source } from "../types";
import { Dialog } from "./Dialog";

type Props = {
  source: Source;
  creates: PlannedRow[];
  skipped: number;
  onConfirm: () => Promise<void>;
  onCancel: () => void;
};

const names = (list: { role_description: string }[]) =>
  list.map((r) => r.role_description).join(", ");

// Confirms a CSV import: how many users, in which organization, and what each gets.
export function ImportConfirmDialog({ source, creates, skipped, onConfirm, onCancel }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const count = `${creates.length} ${creates.length === 1 ? "user" : "users"}`;

  const confirm = async () => {
    setBusy(true);
    setError("");
    try {
      await onConfirm();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <Dialog title={`Create ${count}`} onClose={busy ? () => undefined : onCancel}>
      <p>
        Create {count} in{" "}
        <strong>
          {source.name} ({source.region})
        </strong>
        , with login enabled and MFA required.
        {skipped > 0 &&
          ` ${skipped} ${skipped === 1 ? "row has" : "rows have"} errors and will be skipped.`}
      </p>
      <ul className="detail-list import-confirm" aria-label="Users to create">
        {creates.map((p) => (
          <li key={p.line}>
            <strong>{p.user_name}</strong>{" "}
            <span className="muted">
              {names(p.give.filter((r) => r.kind !== "scan_type" && r.kind !== "any_scan"))}
              {p.scanTypes && ` · Scan types: ${p.scanTypes}`}
            </span>
            {p.leftOut.length > 0 && (
              <span className="muted"> · Left out, needs a team: {names(p.leftOut)}</span>
            )}
          </li>
        ))}
      </ul>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      <div className="dialog-actions">
        <button
          type="button"
          className="btn btn-secondary btn-small"
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-primary btn-small"
          disabled={busy}
          onClick={() => void confirm()}
        >
          {busy ? "Creating..." : `Create ${count}`}
        </button>
      </div>
    </Dialog>
  );
}
