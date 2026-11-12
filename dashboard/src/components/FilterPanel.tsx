import { FilterGroup } from "./FilterGroup";
import type { Role, UserType } from "../types";
import type { UserFilters } from "../lib/users";
import { EMPTY_FILTERS } from "../lib/users";
import { Icon } from "./Icon";

const TYPES: UserType[] = ["UI", "API", "SAML"];
const STATUSES = [
  { value: "all", label: "All" },
  { value: "active", label: "Active" },
  { value: "inactive", label: "Inactive" },
] as const;

type Props = { filters: UserFilters; roles: Role[]; onChange: (f: UserFilters) => void };

const chipsFor = (f: UserFilters, set: (f: UserFilters) => void) => [
  ...(f.search ? [{ label: `Search=${f.search}`, clear: () => set({ ...f, search: "" }) }] : []),
  ...f.types.map((t) => ({
    label: `User Type=${t}`,
    clear: () => set({ ...f, types: f.types.filter((x) => x !== t) }),
  })),
  ...(f.status !== "all"
    ? [{ label: `Status=${f.status}`, clear: () => set({ ...f, status: "all" as const }) }]
    : []),
  ...(f.role ? [{ label: `Role=${f.role}`, clear: () => set({ ...f, role: "" }) }] : []),
];

export function FilterPanel({ filters, roles, onChange }: Props) {
  const chips = chipsFor(filters, onChange);
  return (
    <aside className="panel" aria-label="Filters">
      <div className="filters-head">
        Applied Filters
        <button type="button" className="link" onClick={() => onChange(EMPTY_FILTERS)}>
          Clear All
        </button>
      </div>
      <div className="chips">
        {chips.map((c) => (
          <button key={c.label} type="button" className="chip" onClick={c.clear}>
            <Icon name="close" size={14} label="Remove" />
            {c.label}
          </button>
        ))}
      </div>
      <FilterGroup title="Search">
        <input
          className="input"
          aria-label="Search users"
          placeholder="Name, user name or email"
          value={filters.search}
          onChange={(e) => onChange({ ...filters, search: e.target.value })}
        />
      </FilterGroup>
      <FilterGroup title="User Type">
        {TYPES.map((t) => (
          <label key={t}>
            <input
              type="checkbox"
              checked={filters.types.includes(t)}
              onChange={(e) =>
                onChange({
                  ...filters,
                  types: e.target.checked
                    ? [...filters.types, t]
                    : filters.types.filter((x) => x !== t),
                })
              }
            />
            {t}
          </label>
        ))}
      </FilterGroup>
      <FilterGroup title="Status">
        {STATUSES.map((s) => (
          <label key={s.value}>
            <input
              type="radio"
              name="status"
              checked={filters.status === s.value}
              onChange={() => onChange({ ...filters, status: s.value })}
            />
            {s.label}
          </label>
        ))}
      </FilterGroup>
      <FilterGroup title="Role">
        <select
          className="input"
          aria-label="Role"
          value={filters.role}
          onChange={(e) => onChange({ ...filters, role: e.target.value })}
        >
          <option value="">Any role</option>
          {roles.map((r) => (
            <option key={r.role_name} value={r.role_name}>
              {r.role_description}
            </option>
          ))}
        </select>
      </FilterGroup>
    </aside>
  );
}
