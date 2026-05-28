import { useState } from "react";
import { Link } from "wouter";
import {
  useListPublicCharacters,
  useListPublicCharacterTags,
} from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";

type Scope = "all" | "active" | "retired" | "unclaimed" | "pc" | "npc";
type Mode = "name" | "content";

export default function DirectoryCharacters() {
  const [q, setQ] = useState("");
  const [scope, setScope] = useState<Scope>("all");
  const [mode, setMode] = useState<Mode>("name");
  const [selectedTags, setSelectedTags] = useState<string[]>([]);

  const { data: tagList } = useListPublicCharacterTags();
  const { data, isLoading } = useListPublicCharacters({
    q: q || undefined,
    scope,
    mode,
    tags: selectedTags.length > 0 ? selectedTags.join(",") : undefined,
  });

  const toggleTag = (tag: string) => {
    setSelectedTags((cur) =>
      cur.includes(tag) ? cur.filter((t) => t !== tag) : [...cur, tag],
    );
  };

  return (
    <div className="space-y-6 max-w-6xl mx-auto pb-12">
      <div>
        <h1 className="text-3xl md:text-4xl font-display text-nc-cyan tracking-widest">CHARACTER ARCHIVE</h1>
        <p className="text-muted-foreground font-mono text-sm mt-1">
          Sheets imported from the Discord forums. Includes retired and unclaimed identities.
        </p>
      </div>

      <Card className="rounded-none border-border bg-card/50">
        <CardContent className="pt-6 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-12 gap-3 items-end">
            <div className="sm:col-span-6">
              <label className="text-xs font-mono uppercase tracking-widest text-muted-foreground">
                {mode === "content" ? "Search sheet contents" : "Filter by name"}
              </label>
              <Input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={mode === "content" ? "e.g. Arasaka" : "e.g. Decker"}
                className="rounded-none"
                data-testid="input-search-characters"
              />
            </div>
            <div className="sm:col-span-3">
              <label className="text-xs font-mono uppercase tracking-widest text-muted-foreground">
                Search mode
              </label>
              <div className="flex gap-2 mt-1">
                {(["name", "content"] as Mode[]).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setMode(m)}
                    className={`flex-1 px-3 py-2 border font-display text-xs uppercase tracking-widest ${
                      mode === m
                        ? "border-nc-cyan text-nc-cyan bg-nc-cyan/10"
                        : "border-border text-muted-foreground hover:border-nc-cyan/40"
                    }`}
                    data-testid={`button-mode-${m}`}
                  >
                    {m}
                  </button>
                ))}
              </div>
            </div>
            <div className="sm:col-span-3 flex flex-wrap gap-2">
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
          </div>

          {tagList && tagList.length > 0 && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-xs font-mono uppercase tracking-widest text-muted-foreground">
                  Discord tags {selectedTags.length > 0 && `(${selectedTags.length} selected)`}
                </label>
                {selectedTags.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setSelectedTags([])}
                    className="text-xs font-mono uppercase tracking-widest text-nc-magenta hover:text-nc-magenta/80"
                    data-testid="button-clear-tags"
                  >
                    Clear
                  </button>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                {tagList.map((t) => {
                  const active = selectedTags.includes(t);
                  return (
                    <button
                      key={t}
                      type="button"
                      onClick={() => toggleTag(t)}
                      className={`px-2 py-1 border font-mono text-xs uppercase tracking-wider transition ${
                        active
                          ? "border-nc-yellow text-nc-yellow bg-nc-yellow/10"
                          : "border-border text-muted-foreground hover:border-nc-yellow/40"
                      }`}
                      data-testid={`button-tag-${t}`}
                    >
                      {t}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {isLoading ? (
        <div className="text-nc-cyan font-mono animate-pulse">Loading archive...</div>
      ) : !data || data.length === 0 ? (
        <div className="text-muted-foreground font-mono italic">No characters found.</div>
      ) : (
        <>
          <div className="text-xs font-mono uppercase tracking-widest text-muted-foreground">
            {data.length} character{data.length === 1 ? "" : "s"}
          </div>
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
                    {(c.appliedTags ?? []).map((t) => (
                      <Badge
                        key={t}
                        variant="outline"
                        className="rounded-none border-nc-yellow/60 text-nc-yellow/80 text-[10px] font-mono"
                      >
                        {t}
                      </Badge>
                    ))}
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
