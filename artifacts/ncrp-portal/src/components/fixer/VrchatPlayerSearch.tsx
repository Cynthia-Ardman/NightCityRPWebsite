import { useEffect, useState } from "react";
import { Link } from "wouter";
import {
  useSearchFixerVrchatPlayers,
  useListFixerVrchatPlayerVisits,
  type VrchatPlayerSearchResult,
} from "@workspace/api-client-react";
import { Input } from "@/components/ui/input";
import { ChevronDown, ChevronUp, Link2, UserSearch } from "lucide-react";

function useDebounced(value: string, delayMs = 300): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}

function fmtDuration(ms: number): string {
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function VisitList({ vrchatUserId }: { vrchatUserId: string }) {
  const { data: visits, isLoading } = useListFixerVrchatPlayerVisits(vrchatUserId);
  if (isLoading) {
    return <p className="font-mono text-xs text-muted-foreground italic px-3 py-2">Loading visits…</p>;
  }
  if (!visits || visits.length === 0) {
    return <p className="font-mono text-xs text-muted-foreground italic px-3 py-2">No recorded visits.</p>;
  }
  return (
    <div className="max-h-72 overflow-y-auto divide-y divide-border/50" data-testid={`list-vr-visits-${vrchatUserId}`}>
      {visits.map((v) => (
        <div key={v.id} className="flex items-center justify-between gap-3 px-3 py-1.5 font-mono text-xs">
          <span className="truncate text-foreground">{v.worldName}</span>
          <span className="text-muted-foreground whitespace-nowrap">
            {fmtDate(v.joinedAt)} {fmtTime(v.joinedAt)} · <span className="text-nc-cyan">{fmtDuration(v.durationMs)}</span>
          </span>
        </div>
      ))}
    </div>
  );
}

function PlayerRow({ p }: { p: VrchatPlayerSearchResult }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border border-border" data-testid={`row-vr-player-${p.vrchatUserId}`}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between gap-3 px-3 py-2 text-left hover:bg-card/80"
        data-testid={`button-vr-player-${p.vrchatUserId}`}
      >
        <span className="font-mono text-sm text-foreground truncate">
          {p.displayName}
          {p.portalUser && (
            <span className="ml-2 inline-flex items-center gap-1 text-xs text-nc-cyan" title={p.portalUser.matchKind === "linked" ? "Linked via #vrchat-username" : "Matched by name"}>
              <Link2 className="w-3 h-3" />
              {p.portalUser.globalName ?? p.portalUser.username}
              {p.portalUser.matchKind === "name" && <span className="text-muted-foreground">(name match)</span>}
            </span>
          )}
        </span>
        <span className="font-mono text-xs text-muted-foreground whitespace-nowrap flex items-center gap-2">
          {p.visitCount} visits · {p.totalHours.toLocaleString()}h · last {fmtDate(p.lastSeenAt)}
          {open ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
        </span>
      </button>
      {open && (
        <div className="border-t border-border bg-background/40">
          {p.portalUser && (
            <div className="px-3 pt-2 font-mono text-xs">
              <Link
                href={`/fixer/players?userId=${p.portalUser.userId}`}
                className="text-nc-magenta hover:underline"
                data-testid={`link-vr-player-lookup-${p.vrchatUserId}`}
              >
                OPEN PLAYER LOOKUP →
              </Link>
            </div>
          )}
          <VisitList vrchatUserId={p.vrchatUserId} />
        </div>
      )}
    </div>
  );
}

/**
 * VRChat player search over imported VRCX instance history. Shows visit
 * aggregates per player and expands into their full visit list; players who
 * could be tied to a portal account carry a link chip.
 */
export default function VrchatPlayerSearch() {
  const [q, setQ] = useState("");
  const debouncedQ = useDebounced(q);
  const { data: players, isLoading } = useSearchFixerVrchatPlayers(
    debouncedQ ? { q: debouncedQ } : undefined,
  );

  return (
    <div className="space-y-2">
      <div className="relative">
        <UserSearch className="absolute left-2 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search VRChat username…"
          className="pl-8 rounded-none font-mono text-sm"
          data-testid="input-vr-player-search"
        />
      </div>
      {isLoading ? (
        <p className="font-mono text-xs text-muted-foreground italic">Searching…</p>
      ) : !players || players.length === 0 ? (
        <p className="font-mono text-xs text-muted-foreground italic" data-testid="text-vr-player-empty">
          {debouncedQ ? "No VRChat players match that name." : "No imported player history yet."}
        </p>
      ) : (
        <div className="space-y-1" data-testid="list-vr-players">
          {!debouncedQ && (
            <p className="font-mono text-xs text-muted-foreground">Top players by instance-hours:</p>
          )}
          {players.map((p) => (
            <PlayerRow key={p.vrchatUserId} p={p} />
          ))}
        </div>
      )}
    </div>
  );
}
