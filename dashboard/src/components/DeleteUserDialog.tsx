import { useState, type FormEvent } from "react";
import { fullName } from "../lib/format";
import type { Source, User } from "../types";
import { Dialog } from "./Dialog";

type Props = {
  source: Source;
  user: User;
  onDelete: (confirm: string) => Promise<void>;
  onCancel: () => void;
};

export function DeleteUserDialog({ source, user, onDelete, onCancel }: Props) {
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
      await onDelete(typed);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <Dialog title={`Delete ${user.user_name}`} onClose={busy ? () => undefined : onCancel}>
      <form onSubmit={(e) => void submit(e)} noValidate>
        <p>
          This deletes the user on Veracode, in{" "}
          <strong>
            {source.name} ({source.region})
          </strong>
          . It can't be undone here.
        </p>
        <dl className="facts">
          <div>
            <dt>Name</dt>
            <dd>{fullName(user)}</dd>
          </div>
          <div>
            <dt>Email</dt>
            <dd>{user.email_address}</dd>
          </div>
          <div>
            <dt>Roles</dt>
            <dd>{user.roles.map((r) => r.role_description).join(", ") || "None"}</dd>
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
            {busy ? "Deleting..." : "Delete user"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
