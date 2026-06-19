import { useState } from "react";
import { ChevronUp, ChevronDown, ChevronsUpDown } from "lucide-react";

// Shared, dependency-free table sorting used by the catalog pages so every
// column header behaves identically: click to sort ascending, click again to
// flip to descending. Sorting is alphabetical (numeric-aware) for text columns
// and numeric for number accessors.
export type SortDir = "asc" | "desc";

export function useSort<K extends string>() {
  const [sortKey, setSortKey] = useState<K | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const toggle = (key: K) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  };
  return { sortKey, sortDir, toggle };
}

// Stable sort: when no column is selected the original (caller-provided) order
// is preserved. Empty / null values always sink to the bottom regardless of
// direction so blanks never push real values out of view.
export function sortRows<T>(
  rows: T[],
  sortKey: string | null,
  sortDir: SortDir,
  accessor: (row: T, key: string) => string | number | null | undefined,
): T[] {
  if (!sortKey) return rows;
  const dir = sortDir === "asc" ? 1 : -1;
  const isEmpty = (v: string | number | null | undefined) =>
    v === null || v === undefined || v === "";
  return [...rows].sort((a, b) => {
    const va = accessor(a, sortKey);
    const vb = accessor(b, sortKey);
    const ea = isEmpty(va);
    const eb = isEmpty(vb);
    if (ea && eb) return 0;
    if (ea) return 1;
    if (eb) return -1;
    if (typeof va === "number" && typeof vb === "number") return (va - vb) * dir;
    return String(va).localeCompare(String(vb), undefined, { numeric: true }) * dir;
  });
}

// A clickable <th> that renders a sort indicator. `align` controls text/number
// column alignment to match the existing layout.
export function SortableTh({
  label,
  columnKey,
  activeKey,
  dir,
  onSort,
  align = "left",
  className = "",
  testId,
}: {
  label: string;
  columnKey: string;
  activeKey: string | null;
  dir: SortDir;
  onSort: (key: string) => void;
  align?: "left" | "right";
  className?: string;
  testId?: string;
}) {
  const active = activeKey === columnKey;
  return (
    <th
      className={`${align === "right" ? "text-right" : "text-left"} p-3 ${className}`}
      aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"}
    >
      <button
        type="button"
        onClick={() => onSort(columnKey)}
        className={`inline-flex items-center gap-1 uppercase tracking-widest text-nc-cyan/90 hover:text-nc-cyan focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nc-cyan/60 ${
          align === "right" ? "flex-row-reverse" : ""
        }`}
        data-testid={testId ?? `sort-${columnKey}`}
      >
        <span>{label}</span>
        {active ? (
          dir === "asc" ? (
            <ChevronUp className="w-3 h-3 shrink-0" />
          ) : (
            <ChevronDown className="w-3 h-3 shrink-0" />
          )
        ) : (
          <ChevronsUpDown className="w-3 h-3 shrink-0 opacity-40" />
        )}
      </button>
    </th>
  );
}
