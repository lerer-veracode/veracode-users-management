import { formatDateTime, fullName } from "../lib/format";
import type { Role, Source, User } from "../types";
import { Dialog } from "./Dialog";
import { StatusPill } from "./StatusPill";

type Props = {
  user: User;
  roles: Role[];
  source: Source;
  onClose: () => void;
  onEdit: () => void;
  onDelete: () => void;
};

export function UserDetails({ user, roles, source, onClose, onEdit, onDelete }: Props) {
  const roleDetails = user.roles.map(
    (r) =>
      roles.find((x) => x.role_name === r.role_name) ?? { ...r, is_api: false, permissions: [] },
  );
  const facts: [string, string][] = [
    ["Connection", `${source.name} (${source.region})`],
    ["Name", fullName(user)],
    ["Email", user.email_address],
    ["Type", user.details_pending ? "…" : user.user_type],
    ["Last login", user.details_pending ? "…" : formatDateTime(user.last_login)],
    ["Login", user.login_enabled ? "Enabled" : "Disabled"],
    ["MFA", user.details_pending ? "…" : user.pin_required ? "Required" : "Not required"],
    ["User ID", user.user_id],
  ];
  const teamNames = (relationship: "ADMIN" | "MEMBER") =>
    user.teams
      .filter((t) => t.relationship === relationship)
      .map((t) => t.team_name)
      .join(", ");
  // "Manages teams" shows for a Team Admin, or anyone who manages a team.
  const managesAny = user.teams.some((t) => t.relationship === "ADMIN");
  const teamAdmin = user.roles.some(
    (r) => roles.find((x) => x.role_name === r.role_name)?.kind === "team_admin",
  );
  const teamRows: [string, string][] = [
    ...(managesAny || teamAdmin ? [["Manages teams", teamNames("ADMIN")] as [string, string]] : []),
    ["Member of teams", teamNames("MEMBER")],
  ];

  return (
    <Dialog title={user.user_name} onClose={onClose}>
      <p>
        <StatusPill tone={user.active ? "success" : "warning"}>
          {user.active ? "Active" : "Inactive"}
        </StatusPill>
      </p>
      <dl className="facts">
        {facts.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd className={label === "User ID" ? "mono" : undefined}>{value}</dd>
          </div>
        ))}
      </dl>

      <h3>Roles and their permissions</h3>
      {roleDetails.length === 0 && <p className="muted">No roles.</p>}
      <ul className="detail-list">
        {roleDetails.map((r) => (
          <li key={r.role_name}>
            <strong>{r.role_description}</strong> <span className="mono muted">{r.role_name}</span>
            {r.permissions.length > 0 ? (
              <ul>
                {r.permissions.map((p) => (
                  <li key={p.permission_name}>{p.permission_description || p.permission_name}</li>
                ))}
              </ul>
            ) : (
              <p className="muted small">No permissions listed for this role.</p>
            )}
          </li>
        ))}
      </ul>

      <h3>Permissions given directly</h3>
      {user.permissions.length === 0 ? (
        <p className="muted">None.</p>
      ) : (
        <ul className="detail-list">
          {user.permissions.map((p) => (
            <li key={p.permission_name}>
              {p.permission_description || p.permission_name}{" "}
              <span className="mono muted">{p.permission_name}</span>
            </li>
          ))}
        </ul>
      )}

      <h3>Teams</h3>
      {user.teams.length === 0 ? (
        <p className="muted">No teams.</p>
      ) : (
        // As in the edit form: the teams the user manages (Team Admin) apart from the teams
        // they're only a member of.
        <dl className="facts">
          {teamRows.map(([label, names]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd className={names ? undefined : "muted"}>{names || "None"}</dd>
            </div>
          ))}
        </dl>
      )}

      {user.locked && (
        <p className="notice small" role="note">
          {user.locked}
        </p>
      )}
      <div className="dialog-actions">
        <button
          type="button"
          className="btn btn-danger btn-small"
          disabled={user.locked !== null}
          onClick={onDelete}
        >
          Delete
        </button>
        <button
          type="button"
          className="btn btn-secondary btn-small"
          disabled={user.locked !== null}
          onClick={onEdit}
        >
          Edit
        </button>
        <button type="button" className="btn btn-secondary btn-small" onClick={onClose}>
          Close
        </button>
      </div>
    </Dialog>
  );
}
