import { useCallback } from "react";
import { TopNav } from "./components/TopNav";
import { useConnections } from "./hooks/useConnections";
import { useHashRoute } from "./hooks/useHashRoute";
import { useDirectory } from "./hooks/useDirectory";
import { ApiError, selectConnection } from "./lib/api";
import { ActivityPage } from "./pages/ActivityPage";
import { ConnectionsPage } from "./pages/ConnectionsPage";
import { ImportPage } from "./pages/ImportPage";
import { UsersPage } from "./pages/UsersPage";

type SignedInProps = {
  username: string;
  notices: string[];
  now: Date;
  onSignOut: () => Promise<void>;
  onUnauthorized: () => void;
};

export function SignedInApp({ username, notices, now, onSignOut, onUnauthorized }: SignedInProps) {
  const route = useHashRoute();
  const connections = useConnections(onUnauthorized);
  const ready = connections.state.status === "ready";
  const list = connections.state.status === "ready" ? connections.state.connections : [];
  const active = list.find((c) => c.active);
  // undefined while the connections are still loading, so the users page waits rather than
  // asking for a choice it doesn't need yet.
  const directory = useDirectory(ready ? (active?.id ?? null) : undefined, onUnauthorized);
  const allNotices = [
    ...notices,
    ...(connections.state.status === "ready" ? connections.state.notices : []),
  ];
  const { reload } = connections;

  const choose = useCallback(
    async (id: string) => {
      try {
        await selectConnection(id);
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return onUnauthorized();
      }
      await reload();
    },
    [reload, onUnauthorized],
  );

  const orgName = active?.name ?? (list.length > 1 ? "Choose a connection" : "No connection");
  const picker = { connections: connections.state, onSelect: (id: string) => void choose(id) };

  return (
    <>
      <TopNav
        route={route}
        orgName={orgName}
        appUser={username}
        onSignOut={() => void onSignOut()}
      />
      {allNotices.map((n) => (
        <div key={n} className="notice banner" role="status">
          {n}
        </div>
      ))}
      {route === "users" && (
        <UsersPage
          state={directory.state}
          reload={directory.reload}
          refreshTeams={directory.refreshTeams}
          picker={picker}
          onUnauthorized={onUnauthorized}
        />
      )}
      {route === "import" && (
        <ImportPage state={directory.state} reload={directory.reload} picker={picker} />
      )}
      {route === "activity" && <ActivityPage onUnauthorized={onUnauthorized} now={now} />}
      {route === "connections" && (
        <ConnectionsPage
          state={connections.state}
          reload={connections.reload}
          now={now}
          onUnauthorized={onUnauthorized}
        />
      )}
    </>
  );
}
