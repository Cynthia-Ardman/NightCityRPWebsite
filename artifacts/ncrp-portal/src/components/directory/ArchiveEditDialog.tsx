import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  useListArchiveUsers,
  useUpdateArchiveCharacter,
  useDeleteCharacter,
  getListArchiveUsersQueryKey,
  type ArchiveCharacter,
} from "@workspace/api-client-react";
import { invalidateCharacterQueries } from "@/lib/characterQueries";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { X, AlertTriangle } from "lucide-react";
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
  isAdmin = false,
}: {
  character: ArchiveCharacter;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  isAdmin?: boolean;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [, navigate] = useLocation();

  const sheet = (character.sheetData ?? {}) as {
    preamble?: string;
    sections?: Record<string, string>;
    ripperDoc?: boolean;
    fbc?: boolean;
    ncpd?: boolean;
    organic?: boolean;
  };

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
  // RipperDoc flag (parity with the player/staff edit dialog). Persisted into
  // sheetData; saving with this on grants the RipperDoc Discord role to the owner.
  const [ripperDoc, setRipperDoc] = useState<boolean>(sheet.ripperDoc === true);
  // Full Body Conversion flag (parity with the player/staff edit dialogs).
  // Self-declared, no programmatic effect; persisted into sheetData.
  const [fbc, setFbc] = useState<boolean>(sheet.fbc === true);
  // NCPD officer flag (parity with the other edit dialogs). Self-declared, no
  // programmatic effect; persisted into sheetData and drives the officer roster.
  const [ncpd, setNcpd] = useState<boolean>(sheet.ncpd === true);
  // Organic flag (parity with the other edit dialogs). NO implants at all;
  // self-declared, no programmatic effect; persisted into sheetData.
  const [organic, setOrganic] = useState<boolean>(sheet.organic === true);
  const [commitMessage, setCommitMessage] = useState("");
  // Admin-only destructive delete lives at the bottom of this dialog. The
  // delete button stays disabled until the admin types the literal word DELETE.
  const [deleteConfirm, setDeleteConfirm] = useState("");

  const [ownerSearch, setOwnerSearch] = useState("");
  const ownerSearchParams = { q: ownerSearch || undefined };
  const { data: ownerResults } = useListArchiveUsers(ownerSearchParams, {
    query: {
      queryKey: getListArchiveUsersQueryKey(ownerSearchParams),
      enabled: open && ownerSearch.trim().length > 0,
    },
  });

  const update = useUpdateArchiveCharacter();

  // Permanent deletion (admin only) — hits DELETE /characters/:id, which
  // cascades all character-scoped rows. On success we close and bounce back to
  // the archive roster since this detail page no longer exists.
  const del = useDeleteCharacter({
    mutation: {
      onSuccess: () => {
        toast({
          title: "Character deleted",
          description: `${character.name} has been permanently removed.`,
        });
        void invalidateCharacterQueries(qc);
        onOpenChange(false);
        navigate("/directory/characters");
      },
      onError: (err) => {
        const data = (err as { response?: { data?: { error?: string } } } | null)?.response?.data;
        toast({
          title: "Delete failed",
          description: data?.error ?? "Could not delete this character.",
          variant: "destructive",
        });
      },
    },
  });
  const canDelete = deleteConfirm === "DELETE" && !del.isPending;

  // Re-arm the delete confirmation every time the dialog opens or switches to a
  // different character, so a previously typed DELETE can never carry over.
  useEffect(() => {
    if (open) setDeleteConfirm("");
  }, [open, character.id]);

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
          sheetData: { preamble, sections: rowsToSections(rows), ripperDoc, fbc, ncpd, organic },
        },
      },
      {
        onSuccess: (res) => {
          toast({
            title: "Character updated",
            description: res.changed.length > 0 ? `Changed: ${res.changed.join(", ")}` : "Saved.",
          });
          void invalidateCharacterQueries(qc, character.id);
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

  // Tab-trigger styling lifted from EditCharacterDialog so the admin archive
  // editor reads like the player/staff edit + creation flows.
  const tabTriggerClass =
    "rounded-none border border-border bg-transparent px-3 py-1.5 font-display text-xs tracking-widest text-muted-foreground data-[state=active]:border-nc-cyan data-[state=active]:bg-nc-cyan/10 data-[state=active]:text-nc-cyan data-[state=active]:shadow-none";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="rounded-none border-nc-cyan/40 bg-card max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-display tracking-widest text-nc-cyan">EDIT CHARACTER</DialogTitle>
        </DialogHeader>

        <Tabs defaultValue="identity" className="space-y-4">
          <TabsList className="h-auto flex-wrap justify-start gap-1 rounded-none bg-transparent p-0">
            <TabsTrigger value="identity" className={tabTriggerClass} data-testid="tab-archive-identity">
              IDENTITY
            </TabsTrigger>
            <TabsTrigger value="status" className={tabTriggerClass} data-testid="tab-archive-status">
              STATUS
            </TabsTrigger>
            <TabsTrigger value="owner" className={tabTriggerClass} data-testid="tab-archive-owner">
              OWNER &amp; TAGS
            </TabsTrigger>
            <TabsTrigger value="story" className={tabTriggerClass} data-testid="tab-archive-story">
              STORY
            </TabsTrigger>
            {isAdmin && (
              <TabsTrigger
                value="danger"
                className="rounded-none border border-destructive/40 bg-transparent px-3 py-1.5 font-display text-xs tracking-widest text-destructive data-[state=active]:border-destructive data-[state=active]:bg-destructive/10 data-[state=active]:text-destructive data-[state=active]:shadow-none"
                data-testid="tab-archive-danger"
              >
                DANGER
              </TabsTrigger>
            )}
          </TabsList>

          {/* IDENTITY */}
          <TabsContent value="identity" className="mt-0 space-y-5">
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
              <Label className="text-xs font-mono uppercase tracking-widest text-muted-foreground">CWP band</Label>
              <Toggle
                options={CWP_OPTIONS.map((b) => ({ label: b.toUpperCase(), value: b }))}
                value={cwpBand}
                onChange={(v) => setCwpBand(v as CwpBand)}
                testid="toggle-cwp"
              />
            </div>

            <div>
              <Label className="text-xs font-mono uppercase tracking-widest text-muted-foreground">Ripper Doc</Label>
              <label className="flex h-10 items-center gap-3 border border-input bg-background px-3">
                <input
                  type="checkbox"
                  checked={ripperDoc}
                  onChange={(e) => setRipperDoc(e.target.checked)}
                  className="accent-nc-cyan"
                  data-testid="checkbox-edit-ripper-doc"
                />
                <span className="text-xs font-mono uppercase tracking-widest text-nc-cyan">
                  {ripperDoc ? "Yes" : "No"}
                </span>
              </label>
              <p className="text-[10px] text-muted-foreground mt-1">
                Grants the RipperDoc Discord role to the owner when saved.
              </p>
            </div>

            <div>
              <Label className="text-xs font-mono uppercase tracking-widest text-muted-foreground">Full Body Conversion (FBC)</Label>
              <label className="flex h-10 items-center gap-3 border border-input bg-background px-3">
                <input
                  type="checkbox"
                  checked={fbc}
                  onChange={(e) => setFbc(e.target.checked)}
                  className="accent-nc-cyan"
                  data-testid="checkbox-edit-fbc"
                />
                <span className="text-xs font-mono uppercase tracking-widest text-nc-cyan">
                  {fbc ? "Yes" : "No"}
                </span>
              </label>
              <p className="text-[10px] text-muted-foreground mt-1">
                Medical-grade only, no advantages. Self-declared, not enforced.
              </p>
            </div>

            <div>
              <Label className="text-xs font-mono uppercase tracking-widest text-muted-foreground">Organic</Label>
              <label className="flex h-10 items-center gap-3 border border-input bg-background px-3">
                <input
                  type="checkbox"
                  checked={organic}
                  onChange={(e) => setOrganic(e.target.checked)}
                  className="accent-nc-cyan"
                  data-testid="checkbox-edit-organic"
                />
                <span className="text-xs font-mono uppercase tracking-widest text-nc-cyan">
                  {organic ? "Yes" : "No"}
                </span>
              </label>
              <p className="text-[10px] text-muted-foreground mt-1">
                No implants at all — can't connect to the net, use smart-linked guns, etc. Self-declared.
              </p>
            </div>

            <div>
              <Label className="text-xs font-mono uppercase tracking-widest text-muted-foreground">NCPD Officer</Label>
              <label className="flex h-10 items-center gap-3 border border-input bg-background px-3">
                <input
                  type="checkbox"
                  checked={ncpd}
                  onChange={(e) => setNcpd(e.target.checked)}
                  className="accent-nc-cyan"
                  data-testid="checkbox-edit-ncpd"
                />
                <span className="text-xs font-mono uppercase tracking-widest text-nc-cyan">
                  {ncpd ? "Yes" : "No"}
                </span>
              </label>
              <p className="text-[10px] text-muted-foreground mt-1">
                Lists this character on the NCPD officer roster. Self-declared.
              </p>
            </div>
          </TabsContent>

          {/* STATUS */}
          <TabsContent value="status" className="mt-0 space-y-5">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
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
          </TabsContent>

          {/* OWNER & TAGS */}
          <TabsContent value="owner" className="mt-0 space-y-5">
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
          </TabsContent>

          {/* STORY */}
          <TabsContent value="story" className="mt-0 space-y-5">
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
          </TabsContent>

          {/* DANGER */}
          {isAdmin && (
            <TabsContent value="danger" className="mt-0">
              <div className="border border-destructive/50 p-4 space-y-3" data-testid="section-danger-zone">
                <div className="flex items-center gap-2 text-destructive font-display tracking-widest">
                  <AlertTriangle className="w-4 h-4" /> DANGER ZONE
                </div>
                <p className="text-xs text-muted-foreground">
                  Permanently delete{" "}
                  <span className="text-foreground font-bold">{character.name}</span> and everything
                  tied to them — inventory, wallet, housing, status, and update history. This{" "}
                  <span className="text-destructive font-bold">cannot be undone</span>.
                </p>
                <div>
                  <Label className="text-xs font-mono uppercase tracking-widest text-muted-foreground">
                    Type <span className="text-destructive">DELETE</span> to confirm
                  </Label>
                  <Input
                    value={deleteConfirm}
                    onChange={(e) => setDeleteConfirm(e.target.value)}
                    autoComplete="off"
                    placeholder="DELETE"
                    className="rounded-none"
                    data-testid="input-delete-confirm"
                  />
                </div>
                <Button
                  type="button"
                  disabled={!canDelete}
                  onClick={() => del.mutate({ id: character.id })}
                  className="rounded-none bg-destructive text-destructive-foreground hover:bg-destructive/80 font-display disabled:opacity-50"
                  data-testid="button-confirm-delete"
                >
                  {del.isPending ? "DELETING..." : "DELETE CHARACTER"}
                </Button>
              </div>
            </TabsContent>
          )}
        </Tabs>

        {/* Commit message + actions stay outside the tabs: a non-empty rationale
            is required for EVERY save regardless of which tab was edited. */}
        <div className="border-t border-border pt-4 mt-4">
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
