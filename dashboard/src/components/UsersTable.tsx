import type { Role, User } from "../types";
import type { Sort, SortKey } from "../lib/users";
import { formatDateTime, fullName } from "../lib/format";
import { roleView } from "../lib/roles";
import { Icon } from "./Icon";
import { Menu } from "./Menu";
import { SortHeader } from "./SortHeader";
import { UserStatusPill } from "./UserStatusPill";

type Props = {
  users: User[];
  roles: Role[];
  sort: Sort;
  onSort: (key: SortKey) => void;
  onView: (user: User) => void;
  onEdit: (user: User) => void;
  onLogin: (user: User) => void;
  onDelete: (user: User) => void;
  onResetMfa: (user: User) => void;
};

export function UsersTable({
  users,
  roles,
  sort,
  onSort,
  onView,
  onEdit,
  onLogin,
  onDelete,
  onResetMfa,
}: Props) {
  // Scan types and the API team setting aren't roles on the Platform (docs/PLAN_ROLES.md).
  const roleNames = (u: User) =>
    roleView(u, roles)
      .roles.map((r) => r.role_description)
      .join(", ");
  return (
    <table>
      <thead>
        <tr>
          <SortHeader label="User Name" sortKey="user_name" sort={sort} onSort={onSort} />
          <th>Name</th>
          <SortHeader label="Email" sortKey="email_address" sort={sort} onSort={onSort} />
          <th>Type</th>
          <th>Roles</th>
          <SortHeader label="Last Login" sortKey="last_login" sort={sort} onSort={onSort} />
          <th>Status</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        {users.length === 0 && (
          <tr>
            <td colSpan={8} className="empty">
              No users match these filters.
            </td>
          </tr>
        )}
        {users.map((u) => (
          <tr key={u.user_id}>
            <td>
              <button type="button" className="link" onClick={() => onView(u)}>
                {u.user_name}
              </button>
            </td>
            <td>{fullName(u)}</td>
            <td>{u.email_address}</td>
            <td>{u.details_pending ? "…" : u.user_type}</td>
            <td className="roles">{roleNames(u)}</td>
            <td className="nowrap">{u.details_pending ? "…" : formatDateTime(u.last_login)}</td>
            <td>
              <UserStatusPill user={u} />
            </td>
            <td>
              <Menu
                items={[
                  { label: "View details", onSelect: () => onView(u) },
                  { label: "Edit", onSelect: () => onEdit(u), disabled: u.locked ?? undefined },
                  {
                    label: u.login_enabled ? "Disable login" : "Enable login",
                    onSelect: () => onLogin(u),
                    disabled: u.locked ?? undefined,
                  },
                  {
                    label: "Reset MFA",
                    onSelect: () => onResetMfa(u),
                    disabled: u.mfa_locked ?? undefined,
                  },
                  {
                    label: "Delete",
                    onSelect: () => onDelete(u),
                    danger: true,
                    disabled: u.locked ?? undefined,
                  },
                ]}
                trigger={(toggle) => (
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`Actions for ${u.user_name}`}
                    onClick={toggle}
                  >
                    <Icon name="more" size={22} />
                  </button>
                )}
              />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
