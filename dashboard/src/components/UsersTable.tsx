import type { User } from "../types";
import type { Sort, SortKey } from "../lib/users";
import { formatDateTime, fullName } from "../lib/format";
import { Icon } from "./Icon";
import { Menu } from "./Menu";
import { SortHeader } from "./SortHeader";
import { StatusPill } from "./StatusPill";

type Props = {
  users: User[];
  sort: Sort;
  onSort: (key: SortKey) => void;
  onView: (user: User) => void;
  onEdit: (user: User) => void;
  onLogin: (user: User) => void;
  onDelete: (user: User) => void;
};

export function UsersTable({ users, sort, onSort, onView, onEdit, onLogin, onDelete }: Props) {
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
            <td>{u.user_type}</td>
            <td className="roles">{u.roles.map((r) => r.role_description).join(", ")}</td>
            <td className="nowrap">{formatDateTime(u.last_login)}</td>
            <td>
              <StatusPill tone={u.active ? "success" : "warning"}>
                {u.active ? "Active" : "Inactive"}
              </StatusPill>
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
