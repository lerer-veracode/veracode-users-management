import type { Sort, SortKey } from "../lib/users";
import { Icon } from "./Icon";

type Props = { label: string; sortKey: SortKey; sort: Sort; onSort: (key: SortKey) => void };

export function SortHeader({ label, sortKey, sort, onSort }: Props) {
  const direction = sort.dir === "asc" ? "ascending" : "descending";
  return (
    <th aria-sort={sort.key === sortKey ? direction : undefined}>
      <button type="button" onClick={() => onSort(sortKey)}>
        {label}
        <Icon name="sort" size={14} />
      </button>
    </th>
  );
}
