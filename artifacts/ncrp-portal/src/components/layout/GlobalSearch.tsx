import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { useGlobalSearch, getGlobalSearchQueryKey } from "@workspace/api-client-react";
import type { SearchResultItem } from "@workspace/api-client-react";
import { useEffectiveMe } from "@/contexts/ViewAsContext";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Loader2, User, Crosshair, BookMarked, BookOpen, Store, Siren } from "lucide-react";

// Site-wide search palette (Ctrl+K / Cmd+K). Results come pre-scoped from the
// server (/search reuses each list endpoint's authz predicate); on top of that
// we hide staff-only rows client-side when the admin is previewing the portal
// via "View as player", so the preview matches what a real player would get.
export function GlobalSearchDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [, setLocation] = useLocation();
  const { data: eff } = useEffectiveMe();
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 200);
    return () => clearTimeout(t);
  }, [query]);

  // Reset the input each time the palette opens fresh.
  useEffect(() => {
    if (!open) {
      setQuery("");
      setDebounced("");
    }
  }, [open]);

  const enabled = open && debounced.length >= 2;
  const { data, isFetching } = useGlobalSearch(
    { q: debounced },
    {
      query: {
        enabled,
        queryKey: getGlobalSearchQueryKey({ q: debounced }),
        staleTime: 30_000,
      },
    },
  );

  // View-as safety: staff-only rows (unposted missions, NCPD records) are
  // flagged by the server; hide them whenever the EFFECTIVE viewer wouldn't
  // hold the corresponding role.
  const effIsManager = !!eff && (eff.isAdmin || eff.isFixer);
  const effSeesNcpd =
    !!eff && (eff.isAdmin || eff.isFixer || eff.isNcpd || eff.isNcpdCommissioner);

  const groups = useMemo(() => {
    if (!data) return [];
    const scrub = (items: SearchResultItem[] | undefined, allowStaff: boolean) =>
      (items ?? []).filter((i) => allowStaff || !i.staffOnly);
    return [
      { key: "characters", label: "Characters", icon: User, items: scrub(data.characters, effIsManager) },
      { key: "missions", label: "Missions", icon: Crosshair, items: scrub(data.missions, effIsManager) },
      { key: "lore", label: "Lore", icon: BookMarked, items: scrub(data.lore, true) },
      { key: "guidebook", label: "Guidebook", icon: BookOpen, items: scrub(data.guidebook, true) },
      { key: "venues", label: "Stores & Clinics", icon: Store, items: scrub(data.venues, true) },
      { key: "ncpd", label: "NCPD Records", icon: Siren, items: effSeesNcpd ? (data.ncpd ?? []) : [] },
    ].filter((g) => g.items.length > 0);
  }, [data, effIsManager, effSeesNcpd]);

  const hasResults = groups.length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="overflow-hidden p-0 max-w-lg" aria-describedby={undefined}>
        <DialogTitle className="sr-only">Search the portal</DialogTitle>
        {/* Server-side matching — cmdk's own filter must stay off. */}
        <Command shouldFilter={false} className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-input]]:h-12">
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder="Search characters, missions, lore, guidebook, venues..."
            data-testid="input-global-search"
          />
          <CommandList data-testid="list-global-search">
            {isFetching && (
              <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground" data-testid="status-search-loading">
                <Loader2 className="h-4 w-4 animate-spin" />
                Searching...
              </div>
            )}
            {!isFetching && debounced.length < 2 && (
              <div className="py-6 text-center text-sm text-muted-foreground">
                Type at least 2 characters to search.
              </div>
            )}
            {!isFetching && enabled && !hasResults && (
              <CommandEmpty data-testid="status-search-empty">No results for "{debounced}".</CommandEmpty>
            )}
            {!isFetching &&
              groups.map((g) => (
                <CommandGroup key={g.key} heading={g.label}>
                  {g.items.map((item) => (
                    <CommandItem
                      key={`${g.key}-${item.href}`}
                      value={`${g.key}-${item.href}`}
                      onSelect={() => {
                        onOpenChange(false);
                        setLocation(item.href);
                      }}
                      className="cursor-pointer"
                      data-testid={`search-result-${g.key}`}
                    >
                      {item.imageUrl ? (
                        <img src={item.imageUrl} alt="" className="h-6 w-6 rounded-sm object-cover shrink-0" />
                      ) : (
                        <g.icon className="h-4 w-4 text-muted-foreground shrink-0" />
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="truncate">{item.name}</div>
                        {item.subtitle && (
                          <div className="truncate text-xs text-muted-foreground">{item.subtitle}</div>
                        )}
                      </div>
                    </CommandItem>
                  ))}
                </CommandGroup>
              ))}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
