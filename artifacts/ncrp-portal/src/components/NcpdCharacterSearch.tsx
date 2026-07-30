import { useState } from "react";
import { Link } from "wouter";
import {
  useNcpdSearchCharacters,
  getNcpdSearchCharactersQueryKey,
  type NcpdCharacterSummary,
} from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { User } from "lucide-react";

// Shared NCPD character/player search. Matches character names, character
// numbers, and PLAYER names (a player-name match returns all of that player's
// characters, grouped under a player header — mirroring the fixer Player
// Lookup). Used by the Lookup tab (link mode) and the New Warrant dialog
// (select mode via onSelect).
export default function NcpdCharacterSearch({
  onSelect,
  autoFocus,
}: {
  /** When provided, clicking a result calls this instead of navigating. */
  onSelect?: (c: NcpdCharacterSummary) => void;
  autoFocus?: boolean;
}) {
  const [q, setQ] = useState("");
  // Enable at 2+ chars for names, but allow single-character queries when the
  // input is numeric — officers look characters up by character number (e.g. "4").
  const trimmed = q.trim();
  const enabled = trimmed.length >= 2 || /^\d+$/.test(trimmed);
  const { data, isLoading } = useNcpdSearchCharacters(
    { q: trimmed },
    { query: { enabled, queryKey: getNcpdSearchCharactersQueryKey({ q: trimmed }) } },
  );
  const rows: NcpdCharacterSummary[] = data ?? [];

  // Group rows whose OWNER name matches the query under a player header (all
  // of that player's characters); everything else renders as a flat character
  // match. The server already returned every character of a matched player.
  const lower = trimmed.toLowerCase();
  const playerGroups = new Map<string, { ownerName: string; chars: NcpdCharacterSummary[] }>();
  const charMatches: NcpdCharacterSummary[] = [];
  for (const c of rows) {
    const ownerMatched =
      lower.length >= 2 && c.ownerId != null && (c.ownerName ?? "").toLowerCase().includes(lower);
    if (ownerMatched) {
      const g = playerGroups.get(c.ownerId!) ?? { ownerName: c.ownerName ?? "Unknown", chars: [] };
      g.chars.push(c);
      playerGroups.set(c.ownerId!, g);
    } else {
      charMatches.push(c);
    }
  }

  const renderCard = (c: NcpdCharacterSummary) => {
    const body = (
      <Card
        className="rounded-none border-border bg-card/50 hover:border-nc-cyan transition-all cursor-pointer h-full"
        data-testid={`card-ncpd-char-${c.id}`}
      >
        <CardContent className="py-4 space-y-1">
          <p className="font-display tracking-wider text-foreground">{c.name}</p>
          <p className="font-mono text-xs text-muted-foreground">
            {c.kind.toUpperCase()}
            {c.archetype ? ` · ${c.archetype}` : ""}
            {c.archived ? " · ARCHIVED" : ""}
          </p>
          {c.ownerName && (
            <p className="font-mono text-xs text-muted-foreground">
              Player: <span className="text-foreground/80">{c.ownerName}</span>
            </p>
          )}
        </CardContent>
      </Card>
    );
    return onSelect ? (
      <button key={c.id} type="button" className="text-left w-full" onClick={() => onSelect(c)}>
        {body}
      </button>
    ) : (
      <Link key={c.id} href={`/ncpd/characters/${c.id}`}>
        {body}
      </Link>
    );
  };

  return (
    <div className="space-y-4">
      <Input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search by character or player name…"
        className="rounded-none max-w-md"
        autoFocus={autoFocus}
        data-testid="input-ncpd-search"
      />
      {!enabled ? (
        <p className="font-mono text-sm text-muted-foreground">Enter at least 2 characters to search.</p>
      ) : isLoading ? (
        <div className="text-nc-cyan font-display animate-pulse">SEARCHING...</div>
      ) : !rows.length ? (
        <p className="font-mono text-sm text-muted-foreground">No matches.</p>
      ) : (
        <div className="space-y-4">
          {[...playerGroups.entries()].map(([ownerId, g]) => (
            <div key={`player-${ownerId}`} className="space-y-2" data-testid={`group-ncpd-player-${ownerId}`}>
              <p className="font-display tracking-widest text-nc-yellow flex items-center gap-2 text-sm">
                <User className="w-4 h-4" /> PLAYER: {g.ownerName}
                <span className="font-mono text-xs text-muted-foreground normal-case tracking-normal">
                  {g.chars.length} character{g.chars.length === 1 ? "" : "s"}
                </span>
              </p>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">{g.chars.map(renderCard)}</div>
            </div>
          ))}
          {charMatches.length > 0 && (
            <div className="space-y-2">
              {playerGroups.size > 0 && (
                <p className="font-display tracking-widest text-muted-foreground text-sm">CHARACTER MATCHES</p>
              )}
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">{charMatches.map(renderCard)}</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
