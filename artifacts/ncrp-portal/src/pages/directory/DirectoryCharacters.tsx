import { useState } from "react";
import { Link } from "wouter";
import { useListPublicCharacters } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";

type Scope = "all" | "active" | "retired" | "unclaimed" | "pc" | "npc";

export default function DirectoryCharacters() {
  const [q, setQ] = useState("");
  const [scope, setScope] = useState<Scope>("all");
  const { data, isLoading } = useListPublicCharacters({
    q: q || undefined,
    scope,
  });

  return (
    <div className="space-y-6 max-w-6xl mx-auto pb-12">
      <div>
        <h1 className="text-3xl md:text-4xl font-display text-nc-cyan tracking-widest">CHARACTER ARCHIVE</h1>
        <p className="text-muted-foreground font-mono text-sm mt-1">
          Sheets imported from the Discord forums. Includes retired and unclaimed identities.
        </p>
      </div>

      <Card className="rounded-none border-border bg-card/50">
        <CardContent className="pt-6 grid grid-cols-1 sm:grid-cols-12 gap-3 items-end">
          <div className="sm:col-span-6">
            <label className="text-xs font-mono uppercase tracking-widest text-muted-foreground">Filter by name</label>
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="e.g. Decker"
              className="rounded-none"
              data-testid="input-search-characters"
            />
          </div>
          <div className="sm:col-span-6 flex flex-wrap gap-2">
            {(["all", "pc", "npc", "active", "retired", "unclaimed"] as Scope[]).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setScope(s)}
                className={`px-3 py-2 border font-display text-xs uppercase tracking-widest ${
                  scope === s
                    ? "border-nc-cyan text-nc-cyan bg-nc-cyan/10"
                    : "border-border text-muted-foreground hover:border-nc-cyan/40"
                }`}
                data-testid={`button-scope-${s}`}
              >
                {s}
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      {isLoading ? (
        <div className="text-nc-cyan font-mono animate-pulse">Loading archive...</div>
      ) : !data || data.length === 0 ? (
        <div className="text-muted-foreground font-mono italic">No characters found.</div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3" data-testid="grid-public-characters">
          {data.map((c) => (
            <Link
              key={c.id}
              href={`/directory/characters/${c.id}`}
              className="border border-border bg-card/50 hover:border-nc-cyan transition p-3 flex gap-3"
              data-testid={`row-public-character-${c.id}`}
            >
              <div className="w-16 h-16 border border-border bg-background flex-shrink-0">
                {(c.portraitUrl || c.portraitUrls?.[0]) ? (
                  <img src={c.portraitUrl || c.portraitUrls![0]} alt={c.name} className="w-full h-full object-cover" loading="lazy" />
                ) : (
                  <div className="w-full h-full flex items-center justify-center font-display text-nc-cyan/40 text-lg">
                    {c.name.substring(0, 2).toUpperCase()}
                  </div>
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="font-display text-foreground truncate">{c.name}</div>
                <div className="text-xs font-mono text-muted-foreground truncate">{c.archetype ?? "—"}</div>
                <div className="flex flex-wrap gap-1 mt-1">
                  {c.archived && (
                    <Badge variant="outline" className="rounded-none border-nc-yellow text-nc-yellow text-[10px] font-mono">RETIRED</Badge>
                  )}
                  {!c.claimed && (
                    <Badge variant="outline" className="rounded-none border-nc-magenta text-nc-magenta text-[10px] font-mono">UNCLAIMED</Badge>
                  )}
                  {c.ownerName && (
                    <Badge variant="outline" className="rounded-none border-nc-cyan/50 text-nc-cyan/70 text-[10px] font-mono">@{c.ownerName}</Badge>
                  )}
                  {!c.ownerName && c.legacyDiscordUsername && (
                    <Badge variant="outline" className="rounded-none border-muted text-muted-foreground text-[10px] font-mono">legacy: {c.legacyDiscordUsername}</Badge>
                  )}
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
