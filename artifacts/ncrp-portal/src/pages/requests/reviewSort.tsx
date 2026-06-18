import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

// Sort modes shared across the review queue tabs (Misc Requests, Character
// Edits, New Characters). "updated" is the default and orders by the
// server-computed lastActivityAt (max of the row's base timestamp and its
// newest review comment), so freshly-discussed items float to the top.
export type ReviewSortMode = "updated" | "newest" | "oldest";

const SORT_LABELS: Record<ReviewSortMode, string> = {
  updated: "Recently updated",
  newest: "Newest",
  oldest: "Oldest",
};

function ts(v: string | null | undefined): number {
  if (!v) return 0;
  const t = new Date(v).getTime();
  return Number.isNaN(t) ? 0 : t;
}

// Sort a copy of `items` by the chosen mode. `baseAt` returns the row's
// creation/submission timestamp (used for newest/oldest and as the fallback
// when lastActivityAt is absent); `activityAt` returns lastActivityAt.
export function sortReviewItems<T>(
  items: T[],
  mode: ReviewSortMode,
  baseAt: (item: T) => string | null | undefined,
  activityAt: (item: T) => string | null | undefined,
): T[] {
  const copy = [...items];
  if (mode === "oldest") {
    copy.sort((a, b) => ts(baseAt(a)) - ts(baseAt(b)));
  } else if (mode === "newest") {
    copy.sort((a, b) => ts(baseAt(b)) - ts(baseAt(a)));
  } else {
    copy.sort((a, b) => (ts(activityAt(b)) || ts(baseAt(b))) - (ts(activityAt(a)) || ts(baseAt(a))));
  }
  return copy;
}

// Pin decided-but-not-closed tickets (approved / rejected) to the top of a
// queue, preserving the relative order produced by sortReviewItems within each
// group. Decided tickets still need a closer to CLOSE & APPLY / CLOSE & DENY,
// so surfacing them first replaces the old "Ready to apply" banner.
export function decidedFirst<T>(items: T[], statusOf: (item: T) => string): T[] {
  const decided: T[] = [];
  const rest: T[] = [];
  for (const it of items) {
    const s = statusOf(it);
    if (s === "approved" || s === "rejected") decided.push(it);
    else rest.push(it);
  }
  return [...decided, ...rest];
}

export function ReviewSortDropdown({
  value,
  onChange,
  testId,
}: {
  value: ReviewSortMode;
  onChange: (mode: ReviewSortMode) => void;
  testId?: string;
}) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as ReviewSortMode)}>
      <SelectTrigger
        className="w-[180px] h-9 rounded-none font-mono text-xs"
        data-testid={testId ?? "select-review-sort"}
      >
        <SelectValue placeholder="Sort" />
      </SelectTrigger>
      <SelectContent className="rounded-none">
        {(Object.keys(SORT_LABELS) as ReviewSortMode[]).map((m) => (
          <SelectItem key={m} value={m} className="rounded-none font-mono text-xs">
            {SORT_LABELS[m]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
