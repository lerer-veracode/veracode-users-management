import { FilterGroup } from "./FilterGroup";
import type { Role, UserType } from "../types";
import type { UserFilters } from "../lib/users";
import { EMPTY_FILTERS } from "../lib/users";
import { isScanType, isShownAsRole } from "../lib/roles";
import { Icon } from "./Icon";

const TYPES: UserType[] = ["UI", "API", "SAML"];
const STATUSES = [
  { value: "all", label: "All" },
  { value: "active", label: "Active" },
  { value: "inactive", label: "Inactive" },
] as const;

type Props = { filters: UserFilters; roles: Role[]; onChange: (f: UserFilters) => void };

const chipsFor = (f: UserFilters, roles: Role[], set: (f: UserFilters) => void) => [
  ...(f.search ? [{ label: `Search=${f.search}`, clear: () => set({ ...f, search: "" }) }] : []),
  ...f.types.map((t) => ({
    label: `User Type=${t}`,
    clear: () => set({ ...f, types: f.types.filter((x) => x !== t) }),
  })),
  ...(f.status !== "all"
    ? [{ label: `Status=${f.status}`, clear: () => set({ ...f, status: "all" as const }) }]
    : []),
  ...(f.role ? [{ label: `Role=${f.role}`, clear: () => set({ ...f, role: "" }) }] : []),
  ...(f.scanType
    ? [
        {
          label: `Scan Type=${f.scanType === "all" ? "All" : (roles.find((r) => r.role_name === f.scanType)?.role_description ?? f.scanType)}`,
          clear: () => set({ ...f, scanType: "" }),
        },
      ]
    : []),
];

export function FilterPanel({ filters, roles, onChange }: Props) {
  const chips = chipsFor(filters, roles, onChange);
  const shown = roles.filter(isShownAsRole);
  const option = (r: Role) => (
    <option key={r.role_name} value={r.role_name}>
      {r.role_description}
    </option>
  );
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
          {shown.map(option)}
        </select>
      </FilterGroup>
      <FilterGroup title="Scan Types">
        <select
          className="input"
          aria-label="Scan type"
          value={filters.scanType}
          onChange={(e) => onChange({ ...filters, scanType: e.target.value })}
        >
          <option value="">Any scan type</option>
          <option value="all">All scan types</option>
          {roles.filter((r) => isScanType(r) && r.kind !== "any_scan").map(option)}
        </select>
      </FilterGroup>
    </aside>
  );
}
