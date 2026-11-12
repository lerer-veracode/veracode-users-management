import type { ConnectionsState } from "../hooks/useConnections";

type Props = {
  connections: ConnectionsState;
  onSelect: (id: string) => void;
  what: string;
};

// Which organization's users are on screen, and the place to switch it. Always visible above a
// list, so there's no doubt which connection the list came from.
export function ConnectionPicker({ connections, onSelect, what }: Props) {
  if (connections.status !== "ready") return null;
  const list = connections.connections;
  const active = list.find((c) => c.active);

  return (
    <section className="source-bar" aria-label="Connection">
      <label className="source-select">
        Connection
        <select
          className="input"
          value={active?.id ?? ""}
          onChange={(e) => onSelect(e.target.value)}
          disabled={list.length === 0}
        >
          {!active && (
            <option value="">{list.length === 0 ? "None yet" : "Choose a connection"}</option>
          )}
          {list.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} ({c.region})
            </option>
          ))}
        </select>
      </label>
      <p className="source-text" aria-live="polite">
        {active ? (
          <>
            {what} from <strong>{active.name}</strong>
            <span className="source-region">{active.region}</span>
            <span className="mono muted">{active.client_id}</span>
          </>
        ) : list.length === 0 ? (
          <>
            No connections yet. Add one with <span className="mono">npm run connect</span>.
          </>
        ) : (
          <>Choose a connection to see its {what.toLowerCase()}.</>
        )}
      </p>
    </section>
  );
}
