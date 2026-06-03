import { useEffect, useMemo, useRef, useState } from "react";
import { useListMissions } from "@workspace/api-client-react";
import type { MissionSummary } from "@workspace/api-client-react";
import { Input } from "@/components/ui/input";
import { Link2, Pencil, Search, X } from "lucide-react";

// Either a hard link to a real mission (missionId set) or a free-text label
// (missionId null). `label` is what gets stored as the breach's contextLabel.
export type MissionContextValue = {
  missionId: number | null;
  label: string;
} | null;

type Props = {
  value: MissionContextValue;
  onChange: (v: MissionContextValue) => void;
  placeholder?: string;
  testId?: string;
  disabled?: boolean;
};

export default function MissionContextPicker({
  value,
  onChange,
  placeholder = "Search a mission, or type any context...",
  testId,
  disabled,
}: Props) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  // Staff endpoint returns every mission (no per-status filter) up to the limit;
  // we filter by title client-side as the user types.
  const { data: missions } = useListMissions({ limit: 1000 });

  const trimmed = query.trim();
  const matches = useMemo(() => {
    const all = missions ?? [];
    if (!trimmed) return all.slice(0, 25);
    const q = trimmed.toLowerCase();
    return all.filter((m) => m.title.toLowerCase().includes(q)).slice(0, 25);
  }, [missions, trimmed]);

  const exactTitle = useMemo(
    () => (missions ?? []).some((m) => m.title.toLowerCase() === trimmed.toLowerCase()),
    [missions, trimmed],
  );

  if (value) {
    return (
      <div
        className="flex items-center justify-between border border-nc-cyan/60 bg-background px-3 h-10 font-mono text-sm"
        data-testid={testId}
      >
        <span className="truncate flex items-center gap-2">
          {value.missionId != null ? (
            <Link2 className="w-3.5 h-3.5 text-nc-cyan shrink-0" />
          ) : (
            <Pencil className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
          )}
          <span className="text-foreground truncate">{value.label}</span>
          {value.missionId != null && (
            <span className="text-muted-foreground text-xs">#{value.missionId}</span>
          )}
        </span>
        {!disabled && (
          <button
            type="button"
            onClick={() => {
              onChange(null);
              setQuery("");
              setOpen(false);
            }}
            className="text-muted-foreground hover:text-destructive ml-2"
            aria-label="Clear context"
            data-testid={testId ? `${testId}-clear` : undefined}
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>
    );
  }

  return (
    <div ref={wrapRef} className="relative">
      <div className="relative">
        <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
        <Input
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            // Enter commits the typed text as a free-form label.
            if (e.key === "Enter" && trimmed) {
              e.preventDefault();
              onChange({ missionId: null, label: trimmed });
              setQuery("");
              setOpen(false);
            }
          }}
          placeholder={placeholder}
          className="pl-8 font-mono text-sm"
          disabled={disabled}
          data-testid={testId}
          autoComplete="off"
        />
      </div>
      {open && (
        <div className="absolute z-50 mt-1 w-full max-h-72 overflow-auto border border-nc-cyan/60 bg-card font-mono text-sm shadow-xl">
          {trimmed && !exactTitle && (
            <button
              type="button"
              onClick={() => {
                onChange({ missionId: null, label: trimmed });
                setQuery("");
                setOpen(false);
              }}
              className="w-full text-left px-3 py-2 hover:bg-nc-magenta/10 flex items-center gap-2 border-b border-border/40"
              data-testid={testId ? `${testId}-freetext` : undefined}
            >
              <Pencil className="w-3.5 h-3.5 text-nc-magenta shrink-0" />
              <span className="text-foreground">
                Use custom text: <span className="text-nc-magenta">“{trimmed}”</span>
              </span>
            </button>
          )}
          {matches.length === 0 ? (
            <div className="px-3 py-2 text-muted-foreground">
              {trimmed ? "No matching missions." : "No missions yet."}
            </div>
          ) : (
            matches.map((m: MissionSummary) => (
              <button
                key={m.id}
                type="button"
                onClick={() => {
                  onChange({ missionId: m.id, label: m.title });
                  setQuery("");
                  setOpen(false);
                }}
                className="w-full text-left px-3 py-2 hover:bg-nc-cyan/10 flex items-center gap-2 border-b border-border/40 last:border-b-0"
                data-testid={testId ? `${testId}-option-${m.id}` : undefined}
              >
                <Link2 className="w-3.5 h-3.5 text-nc-cyan shrink-0" />
                <span className="text-foreground truncate">{m.title}</span>
                <span className="text-muted-foreground text-xs ml-auto shrink-0">
                  T{m.tier} · {m.status}
                </span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
