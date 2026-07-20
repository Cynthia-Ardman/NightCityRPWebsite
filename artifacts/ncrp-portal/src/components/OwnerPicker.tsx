import { useEffect, useRef, useState } from "react";
import {
  useAdminSearchDiscordMembers,
  getAdminSearchDiscordMembersQueryKey,
} from "@workspace/api-client-react";

type Props = {
  value: string;
  onChange: (id: string, label?: string) => void;
  testIdPrefix?: string;
};

// Searchable owner picker backed by a live Discord guild member search, so staff
// can assign a character to ANYONE in the server — including members who have
// never signed in to the portal (they have no `users` row yet). The backend
// provisions a stub account for those members on assignment, which their first
// login then adopts.
export default function OwnerPicker({ value, onChange, testIdPrefix = "owner" }: Props) {
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [open, setOpen] = useState(false);
  const [selectedLabel, setSelectedLabel] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 300);
    return () => clearTimeout(t);
  }, [query]);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const enabled = debounced.length >= 2;
  const { data: results, isFetching, isError } = useAdminSearchDiscordMembers(
    { q: debounced },
    { query: { enabled, queryKey: getAdminSearchDiscordMembersQueryKey({ q: debounced }) } },
  );

  const inputCls = "h-9 px-2 text-sm bg-background border border-border w-full";

  if (value) {
    return (
      <div className="flex items-center gap-2">
        <div
          className="flex h-9 flex-1 items-center truncate border border-border bg-background px-2 font-mono text-sm text-nc-cyan"
          data-testid={`${testIdPrefix}-selected`}
        >
          {selectedLabel ?? value}
        </div>
        <button
          type="button"
          className="h-9 shrink-0 border border-border px-2 font-display text-xs text-muted-foreground hover:text-foreground"
          onClick={() => {
            onChange("", undefined);
            setSelectedLabel(null);
            setQuery("");
            setDebounced("");
            setOpen(false);
          }}
          data-testid={`${testIdPrefix}-clear`}
        >
          CHANGE
        </button>
      </div>
    );
  }

  return (
    <div className="relative" ref={boxRef}>
      <input
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        placeholder="Search Discord members…"
        className={inputCls}
        data-testid={`${testIdPrefix}-search`}
      />
      {open && (
        <div className="absolute z-50 mt-1 max-h-64 w-full overflow-auto border border-border bg-card shadow-lg">
          {!enabled && (
            <div className="px-2 py-2 font-mono text-xs text-muted-foreground">
              Type at least 2 characters…
            </div>
          )}
          {enabled && isFetching && (
            <div className="px-2 py-2 font-mono text-xs text-muted-foreground">Searching…</div>
          )}
          {enabled && isError && (
            <div className="px-2 py-2 font-mono text-xs text-destructive">
              Search unavailable — try again
            </div>
          )}
          {enabled && !isFetching && !isError && (results ?? []).length === 0 && (
            <div className="px-2 py-2 font-mono text-xs text-muted-foreground">No members found.</div>
          )}
          {enabled &&
            (results ?? []).map((m) => {
              const label = m.globalName ? `${m.globalName} (@${m.username})` : `@${m.username}`;
              return (
                <button
                  key={m.id}
                  type="button"
                  className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-sm hover:bg-accent"
                  onClick={() => {
                    onChange(m.id, label);
                    setSelectedLabel(label);
                    setOpen(false);
                  }}
                  data-testid={`${testIdPrefix}-option-${m.id}`}
                >
                  {m.avatarUrl ? (
                    <img src={m.avatarUrl} alt="" className="h-6 w-6 rounded-full" />
                  ) : (
                    <div className="h-6 w-6 rounded-full bg-muted" />
                  )}
                  <span className="flex-1 truncate font-mono">
                    {m.globalName ? `${m.globalName} ` : ""}
                    <span className="text-muted-foreground">@{m.username}</span>
                  </span>
                  {!m.hasAccount && (
                    <span className="shrink-0 font-display text-[10px] uppercase tracking-wide text-amber-400/80">
                      Not signed in
                    </span>
                  )}
                </button>
              );
            })}
        </div>
      )}
    </div>
  );
}
