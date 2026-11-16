import { useState, type FormEvent } from "react";
import { fullName } from "../lib/format";
import type { Source, User } from "../types";
import { Dialog } from "./Dialog";

type Props = {
  source: Source;
  user: User;
  onReset: (confirm: string) => Promise<void>;
  onCancel: () => void;
};

// Confirms resetting a user's MFA: the administrator types the user name, as for a delete.
export function ResetMfaDialog({ source, user, onReset, onCancel }: Props) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const matches = typed === user.user_name;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!matches) return;
    setBusy(true);
    setError("");
    try {
      await onReset(typed);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <Dialog title={`Reset MFA for ${user.user_name}`} onClose={busy ? () => undefined : onCancel}>
      <form onSubmit={(e) => void submit(e)} noValidate>
        <p>
          {fullName(user)} will have to set up MFA again the next time they sign in to Veracode, in{" "}
          <strong>
            {source.name} ({source.region})
          </strong>
          . Their roles, teams and settings don't change.
        </p>
        <dl className="facts">
          <div>
            <dt>Email</dt>
            <dd>{user.email_address}</dd>
          </div>
          <div>
            <dt>Account type</dt>
            <dd>{user.user_type}</dd>
          </div>
        </dl>
        <label className="field">
          Type the user name, {user.user_name}, to confirm
          <input
            className="input"
            value={typed}
            autoComplete="off"
            onChange={(e) => setTyped(e.target.value)}
          />
        </label>
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
          <button type="submit" className="btn btn-danger btn-small" disabled={!matches || busy}>
            {busy ? "Resetting..." : "Reset MFA"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
