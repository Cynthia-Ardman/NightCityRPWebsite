import { useState } from "react";
import { Link } from "wouter";
import {
  useListArchiveCharacters,
  useListPublicCharacterTags,
  type ArchiveCharacterSummary,
} from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Plus, Tag } from "lucide-react";
import {
  KindBadge,
  StatusBadge,
  ClaimBadge,
  CwpBadge,
  TagPill,
  type CwpBand,
  type LifeStatus,
} from "@/components/directory/CharacterBadges";
import AddTagsDialog from "@/components/directory/AddTagsDialog";
import CreateTagsDialog from "@/components/directory/CreateTagsDialog";

type Scope = "all" | "claimed" | "unclaimed" | "pc" | "npc";
type Mode = "name" | "content";
type Sort = "recent" | "name";

const STATUS_OPTIONS: LifeStatus[] = ["active", "retired", "loa", "missing", "dead"];
const BAND_OPTIONS: CwpBand[] = ["organic", "none", "medium", "high", "extreme"];
const BAND_LABELS: Record<CwpBand, string> = {
  organic: "Organic",
  none: "None",
  medium: "Medium",
  high: "High",
  extreme: "Extreme",
};

export default function DirectoryCharacters() {
  const [q, setQ] = useState("");
  const [scope, setScope] = useState<Scope>("all");
  const [mode, setMode] = useState<Mode>("name");
  const [sort, setSort] = useState<Sort>("recent");
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [selectedStatuses, setSelectedStatuses] = useState<LifeStatus[]>([]);
  const [selectedBands, setSelectedBands] = useState<CwpBand[]>([]);
  const [createTagsOpen, setCreateTagsOpen] = useState(false);
  const [addTagsTarget, setAddTagsTarget] = useState<ArchiveCharacterSummary | null>(null);

  const { data: tagList } = useListPublicCharacterTags();
  const { data, isLoading } = useListArchiveCharacters({
    q: q || undefined,
    scope,
    mode,
    sort,
    tags: selectedTags.length > 0 ? selectedTags.join(",") : undefined,
    status: selectedStatuses.length > 0 ? selectedStatuses.join(",") : undefined,
    bands: selectedBands.length > 0 ? selectedBands.join(",") : undefined,
  });

  const toggleTag = (tag: string) => {
    setSelectedTags((cur) =>
      cur.includes(tag) ? cur.filter((t) => t !== tag) : [...cur, tag],
    );
  };
  const toggleStatus = (s: LifeStatus) => {
    setSelectedStatuses((cur) =>
      cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s],
    );
  };
  const toggleBand = (b: CwpBand) => {
    setSelectedBands((cur) =>
      cur.includes(b) ? cur.filter((x) => x !== b) : [...cur, b],
    );
  };

  return (
    <div className="space-y-6 max-w-5xl mx-auto pb-12">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-3xl md:text-4xl font-display text-nc-cyan tracking-widest">CHARACTER ARCHIVE</h1>
          <p className="text-muted-foreground font-mono text-sm mt-1">
            Fixer / admin roster of every identity. Includes retired and unclaimed characters.
          </p>
        </div>
        <Button
          onClick={() => setCreateTagsOpen(true)}
          className="rounded-none font-display tracking-widest"
          data-testid="button-open-create-tags"
        >
          <Plus className="h-4 w-4 mr-1" /> Create Tags
        </Button>
      </div>

      <Card className="rounded-none border-border bg-card/50">
        <CardContent className="pt-6 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-12 gap-3 items-end">
            <div className="sm:col-span-5">
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
            <div className="sm:col-span-4">
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
            <div className="sm:col-span-3">
              <label className="text-xs font-mono uppercase tracking-widest text-muted-foreground">
                Sort
              </label>
              <div className="flex gap-2 mt-1">
                {(["recent", "name"] as Sort[]).map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setSort(s)}
                    className={`flex-1 px-3 py-2 border font-display text-xs uppercase tracking-widest ${
                      sort === s
                        ? "border-nc-cyan text-nc-cyan bg-nc-cyan/10"
                        : "border-border text-muted-foreground hover:border-nc-cyan/40"
                    }`}
                    data-testid={`button-sort-${s}`}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            {(["all", "pc", "npc", "claimed", "unclaimed"] as Scope[]).map((s) => (
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

          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-mono uppercase tracking-widest text-muted-foreground">
                Status {selectedStatuses.length > 0 && `(${selectedStatuses.length} selected)`}
              </label>
              {selectedStatuses.length > 0 && (
                <button
                  type="button"
                  onClick={() => setSelectedStatuses([])}
                  className="text-xs font-mono uppercase tracking-widest text-nc-magenta hover:text-nc-magenta/80"
                  data-testid="button-clear-statuses"
                >
                  Clear
                </button>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              {STATUS_OPTIONS.map((s) => {
                const active = selectedStatuses.includes(s);
                return (
                  <button
                    key={s}
                    type="button"
                    onClick={() => toggleStatus(s)}
                    className={`px-3 py-2 border font-display text-xs uppercase tracking-widest ${
                      active
                        ? "border-nc-cyan text-nc-cyan bg-nc-cyan/10"
                        : "border-border text-muted-foreground hover:border-nc-cyan/40"
                    }`}
                    data-testid={`button-status-${s}`}
                  >
                    {s}
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-mono uppercase tracking-widest text-muted-foreground">
                Cyberware {selectedBands.length > 0 && `(${selectedBands.length} selected)`}
              </label>
              {selectedBands.length > 0 && (
                <button
                  type="button"
                  onClick={() => setSelectedBands([])}
                  className="text-xs font-mono uppercase tracking-widest text-nc-magenta hover:text-nc-magenta/80"
                  data-testid="button-clear-bands"
                >
                  Clear
                </button>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              {BAND_OPTIONS.map((b) => {
                const active = selectedBands.includes(b);
                return (
                  <button
                    key={b}
                    type="button"
                    onClick={() => toggleBand(b)}
                    className={`px-3 py-2 border font-display text-xs uppercase tracking-widest ${
                      active
                        ? "border-nc-cyan text-nc-cyan bg-nc-cyan/10"
                        : "border-border text-muted-foreground hover:border-nc-cyan/40"
                    }`}
                    data-testid={`button-band-${b}`}
                  >
                    {BAND_LABELS[b]}
                  </button>
                );
              })}
            </div>
          </div>

          {tagList && tagList.length > 0 && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-xs font-mono uppercase tracking-widest text-muted-foreground">
                  Tags {selectedTags.length > 0 && `(${selectedTags.length} selected)`}
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
          <div className="flex flex-col gap-3" data-testid="grid-public-characters">
            {data.map((c) => (
              <Link
                key={c.id}
                href={`/directory/characters/${c.id}`}
                className="border border-border bg-card/50 hover:border-nc-cyan transition p-4 flex gap-4"
                data-testid={`row-public-character-${c.id}`}
              >
                <div className="w-20 h-20 border border-border bg-background flex-shrink-0">
                  {c.portraitUrl ? (
                    <img src={c.portraitUrl} alt={c.name} className="w-full h-full object-cover" loading="lazy" />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center font-display text-nc-cyan/40 text-2xl">
                      {c.name.substring(0, 2).toUpperCase()}
                    </div>
                  )}
                </div>
                <div className="flex-1 min-w-0 space-y-2">
                  <div className="flex items-baseline justify-between gap-3 flex-wrap">
                    <div className="font-display text-lg text-foreground truncate" data-testid={`text-char-name-${c.id}`}>
                      {c.name}
                    </div>
                    <div className="text-xs font-mono text-muted-foreground truncate">
                      {c.ownerName ? (
                        <>OWNER: <span className="text-nc-cyan">@{c.ownerName}</span></>
                      ) : c.legacyDiscordUsername ? (
                        <>LEGACY: <span className="text-muted-foreground">{c.legacyDiscordUsername}</span></>
                      ) : (
                        <span className="text-muted-foreground">NO OWNER</span>
                      )}
                    </div>
                  </div>
                  <div className="text-xs font-mono text-muted-foreground truncate">
                    {c.archetype ?? "—"}
                  </div>
                  {c.vrchatUsername ? (
                    <div className="text-xs font-mono text-muted-foreground truncate" data-testid={`text-char-vrchat-${c.id}`}>
                      VRCHAT: <span className="text-nc-magenta">{c.vrchatUsername}</span>
                    </div>
                  ) : null}
                  <div className="flex flex-wrap gap-1">
                    <KindBadge kind={c.kind} />
                    <StatusBadge status={c.lifeStatus ?? "active"} />
                    <ClaimBadge claimed={c.claimed} />
                    <CwpBadge band={c.cwpBand as CwpBand} />
                  </div>
                  {(c.tags ?? []).length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {(c.tags ?? []).map((t) => (
                        <TagPill key={t} tag={t} />
                      ))}
                    </div>
                  )}
                </div>
                <div className="flex-shrink-0 self-start">
                  <Button
                    variant="outline"
                    size="sm"
                    className="rounded-none font-display text-xs"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setAddTagsTarget(c);
                    }}
                    data-testid={`button-add-tags-${c.id}`}
                  >
                    <Tag className="h-3 w-3 mr-1" /> Add Tags
                  </Button>
                </div>
              </Link>
            ))}
          </div>
        </>
      )}

      <CreateTagsDialog open={createTagsOpen} onOpenChange={setCreateTagsOpen} />
      <AddTagsDialog
        character={addTagsTarget}
        open={!!addTagsTarget}
        onOpenChange={(v) => !v && setAddTagsTarget(null)}
      />
    </div>
  );
}
