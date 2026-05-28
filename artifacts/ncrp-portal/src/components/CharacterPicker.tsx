import { useEffect, useRef, useState } from "react";
import { useListPublicCharacters, getListPublicCharactersQueryKey } from "@workspace/api-client-react";
import type { PublicCharacterSummary } from "@workspace/api-client-react";
import { Input } from "@/components/ui/input";
import { Check, Search, X } from "lucide-react";

export type CharacterPickerValue = {
  id: number;
  name: string;
  ownerName?: string | null;
} | null;

type Props = {
  value: CharacterPickerValue;
  onChange: (v: CharacterPickerValue) => void;
  placeholder?: string;
  scope?: "all" | "active" | "pc" | "npc";
  testId?: string;
  disabled?: boolean;
};

export default function CharacterPicker({
  value,
  onChange,
  placeholder = "Search by character or player name...",
  scope = "active",
  testId,
  disabled,
}: Props) {
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 180);
    return () => clearTimeout(t);
  }, [query]);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const enabled = open && debounced.length >= 1;
  const params = { q: debounced, scope };
  const { data: results, isFetching } = useListPublicCharacters(
    params,
    { query: { enabled, queryKey: getListPublicCharactersQueryKey(params) } },
  );

  if (value) {
    return (
      <div className="flex items-center justify-between border border-nc-cyan/60 bg-background px-3 h-10 font-mono text-sm" data-testid={testId}>
        <span className="truncate">
          <span className="text-foreground">{value.name}</span>
          {value.ownerName && (
            <span className="text-muted-foreground ml-2 text-xs">@{value.ownerName}</span>
          )}
        </span>
        {!disabled && (
          <button
            type="button"
            onClick={() => {
              onChange(null);
              setQuery("");
              setDebounced("");
              setOpen(false);
            }}
            className="text-muted-foreground hover:text-destructive ml-2"
            aria-label="Clear selection"
            data-testid={testId ? `${testId}-clear` : undefined}
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>
    );
  }

  const list = (results ?? []).slice(0, 25);

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
          placeholder={placeholder}
          className="pl-8 font-mono text-sm"
          disabled={disabled}
          data-testid={testId}
          autoComplete="off"
        />
      </div>
      {open && debounced.length >= 1 && (
        <div className="absolute z-50 mt-1 w-full max-h-72 overflow-auto border border-nc-cyan/60 bg-card font-mono text-sm shadow-xl">
          {isFetching && list.length === 0 ? (
            <div className="px-3 py-2 text-muted-foreground">Searching...</div>
          ) : list.length === 0 ? (
            <div className="px-3 py-2 text-muted-foreground">No matches.</div>
          ) : (
            list.map((c: PublicCharacterSummary) => (
              <button
                key={c.id}
                type="button"
                onClick={() => {
                  onChange({ id: c.id, name: c.name, ownerName: c.ownerName ?? null });
                  setQuery("");
                  setOpen(false);
                }}
                className="w-full text-left px-3 py-2 hover:bg-nc-cyan/10 flex items-center gap-2 border-b border-border/40 last:border-b-0"
                data-testid={testId ? `${testId}-option-${c.id}` : undefined}
              >
                <Check className="w-3.5 h-3.5 text-nc-cyan/0" />
                <span className="text-foreground">{c.name}</span>
                {c.ownerName ? (
                  <span className="text-muted-foreground text-xs ml-auto">@{c.ownerName}</span>
                ) : c.legacyDiscordUsername ? (
                  <span className="text-muted-foreground text-xs ml-auto italic">@{c.legacyDiscordUsername}</span>
                ) : (
                  <span className="text-muted-foreground text-xs ml-auto italic">unclaimed</span>
                )}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
