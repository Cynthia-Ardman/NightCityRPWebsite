import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListArchiveUsers,
  useUpdateArchiveCharacter,
  getGetArchiveCharacterQueryKey,
  getListArchiveCharactersQueryKey,
  getListArchiveUsersQueryKey,
  getGetPublicCharacterQueryKey,
  getListPublicCharactersQueryKey,
  getListPublicCharacterTagsQueryKey,
  type ArchiveCharacter,
} from "@workspace/api-client-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { X } from "lucide-react";
import type { CwpBand } from "@/components/directory/CharacterBadges";

type SectionRow = { key: string; value: string };

function sectionsToRows(sections: Record<string, string> | undefined): SectionRow[] {
  if (!sections) return [];
  return Object.entries(sections).map(([key, value]) => ({ key, value: value ?? "" }));
}
function rowsToSections(rows: SectionRow[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of rows) {
    const k = r.key.trim();
    if (!k) continue;
    out[k] = r.value;
  }
  return out;
}

const CWP_OPTIONS: CwpBand[] = ["organic", "none", "medium", "high", "extreme"];
const LIFE_STATUS_OPTIONS = ["active", "dead", "missing", "loa", "retired"] as const;
type LifeStatusValue = (typeof LIFE_STATUS_OPTIONS)[number];

function Toggle({
  options,
  value,
  onChange,
  testid,
}: {
  options: { label: string; value: string }[];
  value: string;
  onChange: (v: string) => void;
  testid: string;
}) {
  return (
    <div className="flex gap-2 flex-wrap">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={`px-3 py-2 border font-display text-xs uppercase tracking-widest ${
            value === o.value
              ? "border-nc-cyan text-nc-cyan bg-nc-cyan/10"
              : "border-border text-muted-foreground hover:border-nc-cyan/40"
          }`}
          data-testid={`${testid}-${o.value}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export default function ArchiveEditDialog({
  character,
  open,
  onOpenChange,
}: {
  character: ArchiveCharacter;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();

  const sheet = (character.sheetData ?? {}) as { preamble?: string; sections?: Record<string, string> };

  const [name, setName] = useState(character.name);
  const [archetype, setArchetype] = useState(character.archetype ?? "");
  const [kind, setKind] = useState(character.kind === "npc" ? "npc" : "pc");
  const [archived, setArchived] = useState(character.archived);
  const [lifeStatus, setLifeStatus] = useState<string>(character.lifeStatus ?? "active");
  const [claimed, setClaimed] = useState(character.claimed);
  const [ownerId, setOwnerId] = useState<string | null>(character.ownerId ?? null);
  const [ownerName, setOwnerName] = useState<string | null>(character.ownerName ?? null);
  const [cwpBand, setCwpBand] = useState<CwpBand>((character.cwpBand as CwpBand) ?? "none");
  const [fixerDiscordId, setFixerDiscordId] = useState(character.fixerDiscordId ?? "");
  const [playerDiscordId, setPlayerDiscordId] = useState(character.playerDiscordId ?? "");
  const [tags, setTags] = useState<string[]>(character.tags ?? []);
  const [tagInput, setTagInput] = useState("");
  const [preamble, setPreamble] = useState(sheet.preamble ?? "");
  const [rows, setRows] = useState<SectionRow[]>(sectionsToRows(sheet.sections));
  const [commitMessage, setCommitMessage] = useState("");

  const [ownerSearch, setOwnerSearch] = useState("");
  const ownerSearchParams = { q: ownerSearch || undefined };
  const { data: ownerResults } = useListArchiveUsers(ownerSearchParams, {
    query: {
      queryKey: getListArchiveUsersQueryKey(ownerSearchParams),
      enabled: open && ownerSearch.trim().length > 0,
    },
  });

  const update = useUpdateArchiveCharacter();

  const addTag = (raw: string) => {
    const t = raw.trim().replace(/\s+/g, " ");
    if (!t) return;
    if (tags.some((x) => x.toLowerCase() === t.toLowerCase())) {
      setTagInput("");
      return;
    }
    setTags((cur) => [...cur, t]);
    setTagInput("");
  };

  const commitValid = commitMessage.trim().length > 0;

  const save = () => {
    if (!commitValid) return;
    update.mutate(
      {
        id: character.id,
        data: {
          commitMessage: commitMessage.trim(),
          name: name.trim(),
          archetype: archetype.trim() ? archetype.trim() : null,
          kind: kind === "npc" ? "npc" : "pc",
          archived,
          lifeStatus: lifeStatus as LifeStatusValue,
          claimed,
          ownerId,
          cwpBand,
          fixerDiscordId: fixerDiscordId.trim() ? fixerDiscordId.trim() : null,
          playerDiscordId: playerDiscordId.trim() ? playerDiscordId.trim() : null,
          tags,
          sheetData: { preamble, sections: rowsToSections(rows) },
        },
      },
      {
        onSuccess: (res) => {
          toast({
            title: "Character updated",
            description: res.changed.length > 0 ? `Changed: ${res.changed.join(", ")}` : "Saved.",
          });
          void qc.invalidateQueries({ queryKey: getGetArchiveCharacterQueryKey(character.id) });
          void qc.invalidateQueries({ queryKey: getListArchiveCharactersQueryKey() });
          void qc.invalidateQueries({ queryKey: getGetPublicCharacterQueryKey(character.id) });
          void qc.invalidateQueries({ queryKey: getListPublicCharactersQueryKey() });
          void qc.invalidateQueries({ queryKey: getListPublicCharacterTagsQueryKey() });
          onOpenChange(false);
        },
        onError: (err) => {
          const msg = (err as { error?: string })?.error;
          toast({
            title: "Update failed",
            description: msg === "No changes" ? "No changes to save." : "Could not apply edit.",
            variant: "destructive",
          });
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="rounded-none border-nc-cyan/40 bg-card max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-display tracking-widest text-nc-cyan">EDIT CHARACTER</DialogTitle>
        </DialogHeader>

        <div className="space-y-5">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <Label className="text-xs font-mono uppercase tracking-widest text-muted-foreground">Name</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} className="rounded-none" data-testid="input-edit-name" />
            </div>
            <div>
              <Label className="text-xs font-mono uppercase tracking-widest text-muted-foreground">Archetype</Label>
              <Input value={archetype} onChange={(e) => setArchetype(e.target.value)} className="rounded-none" data-testid="input-edit-archetype" />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <Label className="text-xs font-mono uppercase tracking-widest text-muted-foreground">Type</Label>
              <Toggle
                options={[{ label: "PC", value: "pc" }, { label: "NPC", value: "npc" }]}
                value={kind}
                onChange={setKind}
                testid="toggle-kind"
              />
            </div>
            <div>
              <Label className="text-xs font-mono uppercase tracking-widest text-muted-foreground">Lifecycle</Label>
              <Toggle
                options={[{ label: "Active", value: "active" }, { label: "Retired", value: "retired" }]}
                value={archived ? "retired" : "active"}
                onChange={(v) => setArchived(v === "retired")}
                testid="toggle-lifecycle"
              />
            </div>
            <div>
              <Label className="text-xs font-mono uppercase tracking-widest text-muted-foreground">Claim</Label>
              <Toggle
                options={[{ label: "Claimed", value: "claimed" }, { label: "Unclaimed", value: "unclaimed" }]}
                value={claimed ? "claimed" : "unclaimed"}
                onChange={(v) => setClaimed(v === "claimed")}
                testid="toggle-claim"
              />
            </div>
          </div>

          <div>
            <Label className="text-xs font-mono uppercase tracking-widest text-muted-foreground">Status</Label>
            <Toggle
              options={LIFE_STATUS_OPTIONS.map((s) => ({ label: s.toUpperCase(), value: s }))}
              value={lifeStatus}
              onChange={setLifeStatus}
              testid="toggle-status"
            />
          </div>

          <div>
            <Label className="text-xs font-mono uppercase tracking-widest text-muted-foreground">CWP band</Label>
            <Toggle
              options={CWP_OPTIONS.map((b) => ({ label: b.toUpperCase(), value: b }))}
              value={cwpBand}
              onChange={(v) => setCwpBand(v as CwpBand)}
              testid="toggle-cwp"
            />
          </div>

          {kind === "npc" && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <Label className="text-xs font-mono uppercase tracking-widest text-muted-foreground">Fixer Discord ID</Label>
                <Input
                  value={fixerDiscordId}
                  onChange={(e) => setFixerDiscordId(e.target.value)}
                  placeholder="e.g. 123456789012345678"
                  className="rounded-none font-mono"
                  data-testid="input-edit-fixer-discord"
                />
              </div>
              <div>
                <Label className="text-xs font-mono uppercase tracking-widest text-muted-foreground">Player Discord ID</Label>
                <Input
                  value={playerDiscordId}
                  onChange={(e) => setPlayerDiscordId(e.target.value)}
                  placeholder="e.g. 123456789012345678"
                  className="rounded-none font-mono"
                  data-testid="input-edit-player-discord"
                />
              </div>
            </div>
          )}

          <div>
            <Label className="text-xs font-mono uppercase tracking-widest text-muted-foreground">Assigned user</Label>
            <div className="flex items-center gap-2 mb-2">
              <span className="font-mono text-sm text-foreground" data-testid="text-edit-owner">
                {ownerName ? `@${ownerName}` : "— unassigned —"}
              </span>
              {ownerId && (
                <button
                  type="button"
                  onClick={() => {
                    setOwnerId(null);
                    setOwnerName(null);
                    setClaimed(false);
                  }}
                  className="text-xs font-mono uppercase text-nc-magenta hover:text-nc-magenta/80"
                  data-testid="button-edit-clear-owner"
                >
                  Clear (unclaim)
                </button>
              )}
            </div>
            <Input
              value={ownerSearch}
              onChange={(e) => setOwnerSearch(e.target.value)}
              placeholder="Search users to assign…"
              className="rounded-none"
              data-testid="input-edit-owner-search"
            />
            {ownerResults && ownerResults.length > 0 && ownerSearch.trim().length > 0 && (
              <div className="mt-2 max-h-40 overflow-y-auto border border-border divide-y divide-border">
                {ownerResults.map((u) => (
                  <button
                    key={u.id}
                    type="button"
                    onClick={() => {
                      setOwnerId(u.id);
                      setOwnerName(u.username);
                      setClaimed(true);
                      setOwnerSearch("");
                    }}
                    className="w-full text-left px-3 py-2 hover:bg-nc-cyan/10 font-mono text-sm"
                    data-testid={`option-edit-owner-${u.id}`}
                  >
                    @{u.username}
                    {u.globalName ? <span className="text-muted-foreground"> · {u.globalName}</span> : null}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div>
            <Label className="text-xs font-mono uppercase tracking-widest text-muted-foreground">Tags</Label>
            <div className="flex gap-2">
              <Input
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addTag(tagInput);
                  }
                }}
                placeholder="Type a tag and press Enter"
                className="rounded-none"
                data-testid="input-edit-tag"
              />
              <Button type="button" variant="outline" className="rounded-none" onClick={() => addTag(tagInput)} data-testid="button-edit-add-tag">
                Add
              </Button>
            </div>
            {tags.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-2">
                {tags.map((t) => (
                  <span
                    key={t}
                    className="inline-flex items-center gap-1 px-2 py-1 border border-nc-yellow/60 text-nc-yellow/90 font-mono text-[10px] uppercase tracking-wider"
                  >
                    {t}
                    <button type="button" onClick={() => setTags((cur) => cur.filter((x) => x !== t))} data-testid={`button-edit-remove-tag-${t}`}>
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>

          <div>
            <Label className="text-xs font-mono uppercase tracking-widest text-muted-foreground">Sheet preamble</Label>
            <Textarea value={preamble} onChange={(e) => setPreamble(e.target.value)} className="rounded-none font-mono text-sm" rows={3} data-testid="input-edit-preamble" />
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-xs font-mono uppercase tracking-widest text-muted-foreground">Sheet sections</Label>
              <Button
                type="button"
                variant="outline"
                className="rounded-none text-xs"
                onClick={() => setRows((cur) => [...cur, { key: "", value: "" }])}
                data-testid="button-edit-add-section"
              >
                Add section
              </Button>
            </div>
            {rows.map((r, i) => (
              <div key={i} className="border border-border p-2 space-y-1">
                <div className="flex gap-2 items-center">
                  <Input
                    value={r.key}
                    onChange={(e) => setRows((cur) => cur.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))}
                    placeholder="Section heading"
                    className="rounded-none"
                    data-testid={`input-edit-section-key-${i}`}
                  />
                  <button type="button" onClick={() => setRows((cur) => cur.filter((_, j) => j !== i))} data-testid={`button-edit-remove-section-${i}`}>
                    <X className="h-4 w-4 text-nc-magenta" />
                  </button>
                </div>
                <Textarea
                  value={r.value}
                  onChange={(e) => setRows((cur) => cur.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
                  className="rounded-none font-mono text-sm"
                  rows={3}
                  data-testid={`input-edit-section-value-${i}`}
                />
              </div>
            ))}
          </div>

          <div className="border-t border-border pt-4">
            <Label className="text-xs font-mono uppercase tracking-widest text-nc-yellow">
              Commit message (required)
            </Label>
            <Input
              value={commitMessage}
              onChange={(e) => setCommitMessage(e.target.value)}
              placeholder="Describe what you changed and why"
              className="rounded-none"
              data-testid="input-edit-commit"
            />
            {!commitValid && (
              <p className="text-[11px] font-mono text-muted-foreground mt-1">
                A commit message is required — this is recorded in the audit log.
              </p>
            )}
            {tags.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-3">
                {tags.map((t) => (
                  <Badge key={t} variant="outline" className="rounded-none text-[10px] font-mono border-border text-muted-foreground">
                    {t}
                  </Badge>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" className="rounded-none" onClick={() => onOpenChange(false)} data-testid="button-edit-cancel">
            Cancel
          </Button>
          <Button className="rounded-none" disabled={!commitValid || update.isPending} onClick={save} data-testid="button-edit-save">
            {update.isPending ? "Saving…" : "Save changes"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
