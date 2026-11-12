import { useState, type FormEvent } from "react";
import { Dialog } from "./Dialog";

type Props = {
  today: Date;
  onExport: (from: string, to: string) => void;
  onCancel: () => void;
};

const day = (d: Date) => d.toISOString().slice(0, 10);

export function ExportLogDialog({ today, onExport, onCancel }: Props) {
  const [from, setFrom] = useState(day(new Date(today.getTime() - 6 * 86_400_000)));
  const [to, setTo] = useState(day(today));
  const [error, setError] = useState("");

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!from || !to) return setError("Choose both dates.");
    if (from > to) return setError("The start date must be on or before the end date.");
    onExport(from, to);
  };

  return (
    <Dialog title="Export Activity" onClose={onCancel}>
      <form onSubmit={submit} noValidate>
        <p className="muted">Export the log entries between these dates, both included.</p>
        <div className="form-grid">
          <label className="field">
            From
            <input
              className="input"
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </label>
          <label className="field">
            To
            <input
              className="input"
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </label>
        </div>
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn btn-secondary btn-small" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary btn-small">
            Export
          </button>
        </div>
      </form>
    </Dialog>
  );
}
