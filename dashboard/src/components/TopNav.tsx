import type { Route } from "../hooks/useHashRoute";
import { Icon } from "./Icon";
import { UnofficialBadge } from "./UnofficialBadge";

const LINKS: { route: Route; label: string }[] = [
  { route: "users", label: "Users" },
  { route: "import", label: "Import CSV" },
  { route: "connections", label: "Connections" },
  { route: "activity", label: "Activity" },
];

type Props = { route: Route; orgName: string; appUser: string; onSignOut: () => void };

export function TopNav({ route, orgName, appUser, onSignOut }: Props) {
  return (
    <header className="topbar">
      <a href="#/users" aria-label="Home">
        <svg width="26" height="26" viewBox="0 0 32 32" aria-hidden="true">
          <path d="M3 4h7l6 17 6-17h7L19 28h-6z" fill="var(--primary)" />
        </svg>
      </a>
      <UnofficialBadge />
      <nav aria-label="Main">
        {LINKS.map((l) => (
          <a
            key={l.route}
            href={`#/${l.route}`}
            aria-current={route === l.route ? "page" : undefined}
          >
            {l.label}
          </a>
        ))}
      </nav>
      <div className="topbar-tools">
        <button type="button" className="icon-button" aria-label="Notifications">
          <Icon name="bell" />
        </button>
        <a href="#/connections" className="icon-button" aria-label="Settings">
          <Icon name="gear" />
        </a>
        <button type="button" className="icon-button" aria-label="Help">
          <Icon name="help" />
        </button>
        <span>{orgName}</span>
        <span className="muted" title="Signed in to the app">
          {appUser}
        </span>
        <button type="button" className="icon-button" aria-label="Sign out" onClick={onSignOut}>
          <Icon name="lock" />
        </button>
      </div>
    </header>
  );
}
