import { useState, type ComponentProps } from "react";
import { ConnectionPicker } from "../components/ConnectionPicker";
import { FilterPanel } from "../components/FilterPanel";
import { Icon } from "../components/Icon";
import { Menu } from "../components/Menu";
import { PageHeader } from "../components/PageHeader";
import { Pagination } from "../components/Pagination";
import { DeleteUserDialog } from "../components/DeleteUserDialog";
import { LoginDialog } from "../components/LoginDialog";
import { UserDetails } from "../components/UserDetails";
import { UserFormDialog, type Change } from "../components/UserFormDialog";
import { UsersTable } from "../components/UsersTable";
import type { DirectoryState } from "../hooks/useDirectory";
import { ApiError, createUser, deleteUser, readUser, updateUser } from "../lib/api";
import {
  EMPTY_FILTERS,
  filterUsers,
  pageOf,
  sortUsers,
  type Sort,
  type SortKey,
  type UserFilters,
} from "../lib/users";
import type { User } from "../types";

type Props = {
  state: DirectoryState;
  reload: (fresh?: boolean) => Promise<void>;
  refreshTeams?: () => Promise<void>;
  picker: Omit<ComponentProps<typeof ConnectionPicker>, "what">;
  onUnauthorized: () => void;
};

type Action =
  | { kind: "add" }
  | { kind: "edit"; user: User }
  | { kind: "login"; user: User }
  | { kind: "delete"; user: User };

export function UsersPage({ state, reload, refreshTeams, picker, onUnauthorized }: Props) {
  const [action, setAction] = useState<Action | null>(null);
  const [filters, setFilters] = useState<UserFilters>(EMPTY_FILTERS);
  const [showFilters, setShowFilters] = useState(true);
  const [sort, setSort] = useState<Sort>({ key: "user_name", dir: "asc" });
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(10);
  const [viewing, setViewing] = useState<User | null>(null);
  const [notice, setNotice] = useState("");

  const users = state.status === "ready" ? state.users : [];
  const roles = state.status === "ready" ? state.roles : [];
  const visible = sortUsers(filterUsers(users, filters, roles), sort);

  const changeFilters = (f: UserFilters) => {
    setFilters(f);
    setPage(1);
  };
  const changeSort = (key: SortKey) =>
    setSort((s) => ({ key, dir: s.key === key && s.dir === "asc" ? "desc" : "asc" }));

  // Runs a change, then closes the dialogs and reads the users again: the backend drops its
  // copy of the users on a change, and keeps roles and teams (docs/PLAN_CACHE.md, phase 3).
  // Errors go back to the dialog to show, except an ended session.
  const run = async (change: () => Promise<string>) => {
    let done: string;
    try {
      done = await change();
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        onUnauthorized();
        return;
      }
      throw e;
    }
    setAction(null);
    setViewing(null);
    setNotice(done);
    await reload();
  };

  const source = state.status === "ready" ? state.source : null;

  // A user's details and the edit form start from what Veracode has now, not the kept list
  // (docs/PLAN_CACHE.md, phase 4). If the read fails, the list's copy is used.
  const freshen = async (u: User): Promise<User> => {
    if (!source) return u;
    try {
      return await readUser(source.id, u.user_id);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) onUnauthorized();
      return u;
    }
  };
  const view = (u: User) => {
    setViewing(u);
    void freshen(u).then((fresh) =>
      setViewing((current) => (current?.user_id === fresh.user_id ? fresh : current)),
    );
  };
  const edit = async (u: User) => setAction({ kind: "edit", user: await freshen(u) });

  const switchLogin = (user: User) =>
    run(async () => {
      if (!source) throw new Error("No connection in use.");
      const enable = !user.login_enabled;
      await updateUser(source.id, user.user_id, { login_enabled: enable });
      return `${enable ? "Enabled" : "Disabled"} login for ${user.user_name} in ${source.name}.`;
    });

  const save = (change: Change) =>
    run(async () => {
      if (!source) throw new Error("No connection in use.");
      if (change.kind === "update" && action?.kind === "edit") {
        await updateUser(source.id, action.user.user_id, change.changes);
        return `Saved the changes to ${action.user.user_name} in ${source.name}.`;
      }
      if (change.kind !== "create") throw new Error("No user to change.");
      const { user_name } = await createUser(source.id, change.user);
      return `Created ${user_name} in ${source.name}.`;
    });

  const remove = (user: User, confirm: string) =>
    run(async () => {
      if (!source) throw new Error("No connection in use.");
      await deleteUser(source.id, user.user_id, confirm);
      return `Deleted ${user.user_name} from ${source.name}.`;
    });

  return (
    <main className="page">
      <PageHeader title="All Users">
        <Menu
          items={[
            { label: "Refresh", onSelect: () => void reload(true) },
            { label: "Import from CSV", onSelect: () => (window.location.hash = "#/import") },
            { label: "Export to CSV", onSelect: () => setNotice("Export is not built yet.") },
          ]}
          trigger={(toggle) => (
            <button type="button" className="btn btn-secondary" onClick={toggle}>
              Actions <Icon name="caret" size={18} />
            </button>
          )}
        />
        <button
          type="button"
          className="btn btn-primary"
          disabled={state.status !== "ready"}
          onClick={() => setAction({ kind: "add" })}
        >
          Add New User
        </button>
      </PageHeader>

      <ConnectionPicker {...picker} what="Users" />

      {notice && (
        <div className="notice" role="status">
          {notice}
        </div>
      )}

      <div className="toolbar-row">
        <button
          type="button"
          className="btn btn-outline"
          aria-pressed={showFilters}
          onClick={() => setShowFilters(!showFilters)}
        >
          <Icon name="filter" size={16} /> Filters
        </button>
      </div>

      <div className={showFilters ? "with-filters" : undefined}>
        {showFilters && <FilterPanel filters={filters} roles={roles} onChange={changeFilters} />}
        <section className="table-card" aria-label="Users">
          {state.status === "no-connection" && (
            <p className="empty">Choose a connection above to see its users.</p>
          )}
          {state.status === "loading" && <p className="empty">Loading users from Veracode...</p>}
          {state.status === "error" && (
            <div className="empty" role="alert">
              <p className="error-text">{state.message}</p>
              <button type="button" className="link" onClick={() => void reload(true)}>
                Try again
              </button>
            </div>
          )}
          {state.status === "ready" && state.details === "loading" && (
            <p className="muted small details-note" role="status">
              Reading last login, type and MFA from Veracode...
            </p>
          )}
          {state.status === "ready" && typeof state.details === "object" && (
            <p className="error-text small details-note" role="alert">
              Couldn't read last login, type and MFA: {state.details.error}{" "}
              <button type="button" className="link" onClick={() => void reload(true)}>
                Try again
              </button>
            </p>
          )}
          {state.status === "ready" && (
            <>
              <UsersTable
                users={pageOf(visible, page, size)}
                roles={roles}
                sort={sort}
                onSort={changeSort}
                onView={view}
                onEdit={(user) => void edit(user)}
                onLogin={(user) => setAction({ kind: "login", user })}
                onDelete={(user) => setAction({ kind: "delete", user })}
              />
              <Pagination
                total={visible.length}
                page={page}
                size={size}
                onPage={setPage}
                onSize={(s) => {
                  setSize(s);
                  setPage(1);
                }}
              />
            </>
          )}
        </section>
      </div>

      {viewing && !action && state.status === "ready" && (
        <UserDetails
          user={viewing}
          roles={roles}
          source={state.source}
          onClose={() => setViewing(null)}
          onEdit={() => setAction({ kind: "edit", user: viewing })}
          onDelete={() => setAction({ kind: "delete", user: viewing })}
        />
      )}
      {(action?.kind === "add" || action?.kind === "edit") && state.status === "ready" && (
        <UserFormDialog
          source={state.source}
          roles={roles}
          teams={state.teams}
          onRefreshTeams={refreshTeams}
          existing={users}
          user={action.kind === "edit" ? action.user : undefined}
          onSave={save}
          onCancel={() => setAction(null)}
        />
      )}
      {action?.kind === "login" && state.status === "ready" && (
        <LoginDialog
          source={state.source}
          user={action.user}
          onConfirm={() => switchLogin(action.user)}
          onCancel={() => setAction(null)}
        />
      )}
      {action?.kind === "delete" && state.status === "ready" && (
        <DeleteUserDialog
          source={state.source}
          user={action.user}
          onDelete={(confirm) => remove(action.user, confirm)}
          onCancel={() => setAction(null)}
        />
      )}
    </main>
  );
}
