import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  useUpdateCharacter,
  useDeleteCharacter,
  useGetCharacterInventory,
  useAddInventoryItem,
  useUpdateInventoryItem,
  useRemoveInventoryItem,
  useListCyberware,
  getGetCharacterInventoryQueryKey,
  getGetCharacterPendingEditQueryKey,
  getGetCharacterQueryKey,
  getListPendingEditsQueryKey,
  getListMyCharactersQueryKey,
  getListArchiveCharactersQueryKey,
  getGetArchiveCharacterQueryKey,
  type Character,
} from "@workspace/api-client-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import MarkdownEditor from "@/components/MarkdownEditor";
import ImageEditor from "@/components/ImageEditor";
import CyberwareEditor, {
  type CyberRow,
  parseCyberNotes,
  reconcileCyberware,
} from "@/components/CyberwareEditor";
import StaffGrantSections from "@/components/StaffGrantSections";
import { useEffectiveMe } from "@/contexts/ViewAsContext";
import { Plus, Trash2, AlertTriangle } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

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

export default function EditCharacterDialog({
  character,
  open,
  onOpenChange,
  canDelete = false,
}: {
  character: Character;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  // Whether the viewer may permanently delete this character (the DANGER tab):
  // admins, archivists and coordinators. All non-cosmetic character edits now
  // go through review regardless of role, so the save button copy is uniform.
  canDelete?: boolean;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const { data: me } = useEffectiveMe();
  const isStaff = !!me && (me.isAdmin === true || me.isFixer === true);

  const [name, setName] = useState(character.name);
  const [archetype, setArchetype] = useState(character.archetype ?? "");
  const [background, setBackground] = useState(character.background ?? "");
  const [preamble, setPreamble] = useState(character.sheetData?.preamble ?? "");
  const [rows, setRows] = useState<SectionRow[]>(
    sectionsToRows(character.sheetData?.sections),
  );
  const [portraitUrl, setPortraitUrl] = useState<string | null>(character.portraitUrl ?? null);
  const [portraitUrls, setPortraitUrls] = useState<string[]>(character.portraitUrls ?? []);
  const [statsImageUrls, setStatsImageUrls] = useState<string[]>(character.statsImageUrls ?? []);
  const [lifeStatus, setLifeStatus] = useState<string>(character.lifeStatus ?? "active");
  const [traumaTeamTier, setTraumaTeamTier] = useState<string>(character.traumaTeamTier ?? "");
  const [xanaduGold, setXanaduGold] = useState<boolean>(character.xanaduGold ?? false);
  const [updateNote, setUpdateNote] = useState<string>("");
  // Admin-only destructive delete lives at the bottom of this dialog. The
  // delete button stays disabled until the admin types the literal word DELETE.
  const [deleteConfirm, setDeleteConfirm] = useState<string>("");

  // Cyberware is stored as inventory_items, not on the character row, so it is
  // edited independently of the review-queued character fields above. We load
  // the current chrome, let staff edit rows, then reconcile (create / update /
  // delete) against the inventory endpoints — applying immediately.
  const { data: inventory } = useGetCharacterInventory(character.id, {
    query: { queryKey: getGetCharacterInventoryQueryKey(character.id), enabled: open },
  });
  const { data: cyberCatalog } = useListCyberware();
  const [cyberRows, setCyberRows] = useState<CyberRow[]>([]);
  const [savingCyber, setSavingCyber] = useState(false);
  const addInventory = useAddInventoryItem();
  const updateInventory = useUpdateInventoryItem();
  const removeInventory = useRemoveInventoryItem();

  // Snapshot the original cyberware rows so reconcile can diff against them
  // (which rows were deleted, which changed) instead of re-writing everything.
  const [cyberOriginal, setCyberOriginal] = useState<CyberRow[]>([]);

  useEffect(() => {
    if (!open) return;
    // Re-hydrate from server inventory only when there are no unsaved edits, so
    // a late cyberware-catalog load or a background refetch can't clobber rows
    // the staffer is editing. The catalog dep lets a not-yet-edited grid
    // re-parse once slot names arrive (bare-slot recognition).
    const dirty = JSON.stringify(cyberRows) !== JSON.stringify(cyberOriginal);
    if (dirty) return;
    const slotNames = (cyberCatalog ?? []).map((c) => c.slot);
    const rows: CyberRow[] = (inventory ?? [])
      .filter((it) => it.category === "cyberware")
      .map((it) => {
        const parsed = parseCyberNotes(it.notes, slotNames);
        return {
          id: it.id,
          slot: parsed.slot,
          name: it.name,
          points: parsed.points,
          notes: parsed.notes,
        };
      });
    setCyberRows(rows);
    setCyberOriginal(rows);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, inventory, cyberCatalog]);

  // Reset form state every time we re-open with a different character or after
  // server-side changes (avoids leaking stale form state across opens).
  useEffect(() => {
    if (!open) return;
    setName(character.name);
    setArchetype(character.archetype ?? "");
    setBackground(character.background ?? "");
    setPreamble(character.sheetData?.preamble ?? "");
    setRows(sectionsToRows(character.sheetData?.sections));
    setPortraitUrl(character.portraitUrl ?? null);
    setPortraitUrls(character.portraitUrls ?? []);
    setStatsImageUrls(character.statsImageUrls ?? []);
    setLifeStatus(character.lifeStatus ?? "active");
    setTraumaTeamTier(character.traumaTeamTier ?? "");
    setXanaduGold(character.xanaduGold ?? false);
    setUpdateNote("");
    setDeleteConfirm("");
  }, [open, character]);

  // Saving no longer applies the change directly — the API now queues the
  // edit as a pending_character_edit awaiting a fixer-majority approval.
  // The 202 response carries the queued edit id; on 409 we point the
  // user at the existing pending edit so they can amend it instead.
  const update = useUpdateCharacter({
    mutation: {
      onSuccess: (resp) => {
        // Cosmetic-only edits (portrait, bio, archetype, sheet preamble) are
        // applied immediately by the API and come back with autoApplied:true —
        // no review queue, no redirect, just refresh the character in place.
        if ((resp as { autoApplied?: boolean } | undefined)?.autoApplied) {
          toast({
            title: "Saved",
            description: `${character.name}'s changes are live.`,
          });
          qc.invalidateQueries({ queryKey: getGetCharacterPendingEditQueryKey(character.id) });
          qc.invalidateQueries({ queryKey: getGetCharacterQueryKey(character.id) });
          qc.invalidateQueries({ queryKey: getListMyCharactersQueryKey() });
          onOpenChange(false);
          return;
        }
        const editId = (resp as { pendingEditId?: number } | undefined)?.pendingEditId;
        toast({
          title: "Submitted for review",
          description: `${character.name}'s edit is awaiting fixer approval.`,
        });
        qc.invalidateQueries({ queryKey: getGetCharacterPendingEditQueryKey(character.id) });
        qc.invalidateQueries({ queryKey: getListPendingEditsQueryKey() });
        onOpenChange(false);
        if (editId) navigate(`/pending-edits/${editId}`);
      },
      onError: (err) => {
        const data = (err as { response?: { data?: { error?: string; pendingEditId?: number } } } | null)?.response?.data;
        if (data?.pendingEditId) {
          toast({
            title: "Edit already pending",
            description: "There's already a pending edit for this character. Opening it now.",
          });
          onOpenChange(false);
          navigate(`/pending-edits/${data.pendingEditId}`);
          return;
        }
        toast({ title: "Save failed", description: data?.error ?? "Save failed", variant: "destructive" });
      },
    },
  });

  // Permanent deletion (admin only). Mirrors the success/error handling of the
  // former standalone delete dialog: toast, invalidate the character list, close
  // and bounce back to the roster.
  const del = useDeleteCharacter({
    mutation: {
      onSuccess: () => {
        toast({
          title: "Character deleted",
          description: `${character.name} has been permanently removed.`,
        });
        qc.invalidateQueries({ queryKey: getListMyCharactersQueryKey() });
        onOpenChange(false);
        navigate("/characters");
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
  const canConfirmDelete = deleteConfirm === "DELETE" && !del.isPending;

  function save(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      toast({ title: "Name required", variant: "destructive" });
      return;
    }
    update.mutate({
      id: character.id,
      data: {
        name: name.trim(),
        archetype: archetype.trim() || undefined,
        background: background,
        portraitUrl: portraitUrl,
        portraitUrls,
        statsImageUrls,
        sheetData: { preamble, sections: rowsToSections(rows) },
        lifeStatus: lifeStatus as "active" | "dead" | "missing" | "loa" | "retired",
        traumaTeamTier: (traumaTeamTier || null) as "silver" | "gold" | "platinum" | "diamond" | null,
        xanaduGold,
        updateNote: updateNote.trim() || undefined,
      },
    });
  }

  // Apply cyberware changes immediately (independent of the review-queued
  // character fields). Diff the edited rows against the original snapshot:
  // delete removed rows, patch changed rows, insert new ones — then refresh.
  async function saveCyberware() {
    if (savingCyber) return;
    setSavingCyber(true);
    // `working` mirrors the user's full row list and is mutated in place as rows
    // persist (folding in server-assigned ids) so nothing the user typed is lost
    // even on a mid-sequence failure. `survivingOriginal` tracks what is actually
    // on the server keyed by id, so a retry after a partial failure neither
    // re-creates already-created rows nor re-deletes already-deleted ones.
    const working: CyberRow[] = cyberRows.map((r) => ({ ...r }));
    const survivingOriginal = new Map<number, CyberRow>();
    for (const o of cyberOriginal) if (o.id != null) survivingOriginal.set(o.id, o);
    try {
      await reconcileCyberware({
        characterId: character.id,
        working,
        survivingOriginal,
        mutations: {
          add: (a) => addInventory.mutateAsync(a),
          update: (a) => updateInventory.mutateAsync(a),
          remove: (a) => removeInventory.mutateAsync(a),
        },
      });

      await qc.invalidateQueries({ queryKey: getGetCharacterInventoryQueryKey(character.id) });
      await qc.invalidateQueries({ queryKey: getGetCharacterQueryKey(character.id) });
      // Refresh the character-archive list AND detail so the derived CWP band
      // badge reflects the edited chrome (list key prefix-matched to hit every
      // filtered variation).
      await qc.invalidateQueries({ queryKey: getListArchiveCharactersQueryKey() });
      await qc.invalidateQueries({ queryKey: getGetArchiveCharacterQueryKey(character.id) });
      toast({ title: "Cyberware saved", description: `${character.name}'s chrome is updated.` });
    } catch (err) {
      const data = (err as { response?: { data?: { error?: string } } } | null)?.response?.data;
      toast({
        title: "Cyberware save failed",
        description: data?.error ?? "Could not update cyberware. Re-saving is safe.",
        variant: "destructive",
      });
    } finally {
      // Commit whatever actually happened back to local state: the form keeps all
      // rows (with real ids for created ones) and the diff baseline reflects the
      // true server state, so a retry only applies what's still outstanding.
      setCyberRows(working);
      setCyberOriginal(Array.from(survivingOriginal.values()));
      setSavingCyber(false);
    }
  }

  const tabTriggerClass =
    "rounded-none border border-border bg-transparent px-3 py-1.5 font-display text-xs tracking-widest text-muted-foreground data-[state=active]:border-nc-cyan data-[state=active]:bg-nc-cyan/10 data-[state=active]:text-nc-cyan data-[state=active]:shadow-none";
  const accTriggerClass =
    "font-display text-xs tracking-widest text-nc-cyan hover:no-underline";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="w-[95vw] max-w-[1400px] max-h-[90vh] flex flex-col gap-0 overflow-hidden rounded-none border-nc-cyan bg-background p-0"
        data-testid="dialog-edit-character"
      >
        <DialogHeader className="shrink-0 border-b border-border px-6 py-4">
          <DialogTitle className="font-display tracking-widest text-nc-cyan text-2xl">
            EDIT: {character.name}
          </DialogTitle>
        </DialogHeader>

        <form className="flex min-h-0 flex-1 flex-col font-mono text-sm" onSubmit={save}>
          <Tabs defaultValue="identity" className="flex min-h-0 flex-1 flex-col">
            <TabsList className="mx-6 mt-4 h-auto shrink-0 flex-wrap justify-start gap-1 rounded-none bg-transparent p-0">
              <TabsTrigger value="identity" className={tabTriggerClass} data-testid="tab-edit-identity">
                IDENTITY
              </TabsTrigger>
              <TabsTrigger value="story" className={tabTriggerClass} data-testid="tab-edit-story">
                STORY
              </TabsTrigger>
              <TabsTrigger value="media" className={tabTriggerClass} data-testid="tab-edit-media">
                MEDIA
              </TabsTrigger>
              <TabsTrigger value="cyberware" className={tabTriggerClass} data-testid="tab-edit-cyberware">
                CYBERWARE
              </TabsTrigger>
              {isStaff && (
                <TabsTrigger value="staff" className={tabTriggerClass} data-testid="tab-edit-staff">
                  STAFF
                </TabsTrigger>
              )}
              {canDelete && (
                <TabsTrigger
                  value="danger"
                  className="rounded-none border border-destructive/40 bg-transparent px-3 py-1.5 font-display text-xs tracking-widest text-destructive data-[state=active]:border-destructive data-[state=active]:bg-destructive/10 data-[state=active]:text-destructive data-[state=active]:shadow-none"
                  data-testid="tab-edit-danger"
                >
                  DANGER
                </TabsTrigger>
              )}
            </TabsList>

            <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
              {/* IDENTITY */}
              <TabsContent value="identity" className="mt-0">
                <Accordion type="multiple" defaultValue={["basics", "status"]}>
                  <AccordionItem value="basics" className="border-border">
                    <AccordionTrigger className={accTriggerClass}>BASICS</AccordionTrigger>
                    <AccordionContent>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div>
                          <Label className="text-xs">NAME</Label>
                          <Input
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            required
                            data-testid="input-edit-name"
                          />
                        </div>
                        <div>
                          <Label className="text-xs">ARCHETYPE</Label>
                          <Input
                            value={archetype}
                            onChange={(e) => setArchetype(e.target.value)}
                            data-testid="input-edit-archetype"
                          />
                        </div>
                      </div>
                    </AccordionContent>
                  </AccordionItem>

                  <AccordionItem value="status" className="border-border">
                    <AccordionTrigger className={accTriggerClass}>STATUS &amp; SUBSCRIPTIONS</AccordionTrigger>
                    <AccordionContent className="space-y-4">
                      <div>
                        <Label className="text-xs">STATUS</Label>
                        <select
                          value={lifeStatus}
                          onChange={(e) => setLifeStatus(e.target.value)}
                          className="flex h-10 w-full rounded-none border border-input bg-background px-3 py-2 text-sm font-mono uppercase tracking-widest text-nc-cyan focus:outline-none focus:ring-1 focus:ring-nc-cyan"
                          data-testid="select-edit-life-status"
                        >
                          <option value="active">Active</option>
                          <option value="dead">Dead</option>
                          <option value="missing">Missing</option>
                          <option value="loa">LOA</option>
                          <option value="retired">Retired</option>
                        </select>
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div>
                          <Label className="text-xs">TRAUMA TEAM SUBSCRIPTION</Label>
                          <select
                            value={traumaTeamTier}
                            onChange={(e) => setTraumaTeamTier(e.target.value)}
                            className="flex h-10 w-full rounded-none border border-input bg-background px-3 py-2 text-sm font-mono uppercase tracking-widest text-nc-cyan focus:outline-none focus:ring-1 focus:ring-nc-cyan"
                            data-testid="select-edit-trauma-tier"
                          >
                            <option value="">None</option>
                            <option value="silver">Silver</option>
                            <option value="gold">Gold</option>
                            <option value="platinum">Platinum</option>
                            <option value="diamond">Diamond</option>
                          </select>
                          <p className="text-[10px] text-muted-foreground mt-1">
                            Billed monthly. Paused while on LOA.
                          </p>
                        </div>
                        <div>
                          <Label className="text-xs">XANADU GOLD</Label>
                          <label className="flex h-10 items-center gap-3 border border-input bg-background px-3">
                            <input
                              type="checkbox"
                              checked={xanaduGold}
                              onChange={(e) => setXanaduGold(e.target.checked)}
                              className="accent-nc-cyan"
                              data-testid="checkbox-edit-xanadu-gold"
                            />
                            <span className="text-xs font-mono uppercase tracking-widest text-nc-cyan">
                              {xanaduGold ? "Active" : "Inactive"}
                            </span>
                          </label>
                          <p className="text-[10px] text-muted-foreground mt-1">
                            Flat monthly fee. Paused while on LOA.
                          </p>
                        </div>
                      </div>
                    </AccordionContent>
                  </AccordionItem>
                </Accordion>
              </TabsContent>

              {/* STORY */}
              <TabsContent value="story" className="mt-0">
                <Accordion type="multiple" defaultValue={["background", "sections"]}>
                  <AccordionItem value="background" className="border-border">
                    <AccordionTrigger className={accTriggerClass}>BACKGROUND / DOSSIER SUMMARY</AccordionTrigger>
                    <AccordionContent>
                      <MarkdownEditor
                        value={background}
                        onChange={setBackground}
                        rows={6}
                        testId="input-edit-background"
                      />
                    </AccordionContent>
                  </AccordionItem>

                  <AccordionItem value="sections" className="border-border">
                    <AccordionTrigger className={accTriggerClass}>SHEET SECTIONS</AccordionTrigger>
                    <AccordionContent className="space-y-3">
                      <div className="flex items-center justify-end">
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="rounded-none font-display"
                          onClick={() => setRows((r) => [...r, { key: "", value: "" }])}
                          data-testid="button-add-section"
                        >
                          <Plus className="w-3 h-3 mr-1" /> ADD SECTION
                        </Button>
                      </div>
                      {rows.length === 0 && (
                        <div className="text-muted-foreground italic">No sections. Add one above.</div>
                      )}
                      {rows.map((row, idx) => (
                        <div
                          key={idx}
                          className="border border-border/40 p-3 space-y-2 bg-card/30"
                          data-testid={`section-row-${idx}`}
                        >
                          <div className="flex items-center gap-2">
                            <Input
                              value={row.key}
                              onChange={(e) =>
                                setRows((rs) => rs.map((r, i) => (i === idx ? { ...r, key: e.target.value } : r)))
                              }
                              placeholder="Section name (e.g. Backstory)"
                              className="flex-1"
                              data-testid={`input-section-key-${idx}`}
                            />
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="text-destructive h-8 w-8 shrink-0"
                              onClick={() => setRows((rs) => rs.filter((_, i) => i !== idx))}
                              data-testid={`button-remove-section-${idx}`}
                            >
                              <Trash2 className="w-4 h-4" />
                            </Button>
                          </div>
                          <MarkdownEditor
                            value={row.value}
                            onChange={(v) =>
                              setRows((rs) => rs.map((r, i) => (i === idx ? { ...r, value: v } : r)))
                            }
                            rows={4}
                            testId={`input-section-value-${idx}`}
                          />
                        </div>
                      ))}
                      <div>
                        <Label className="text-xs">PREAMBLE (text above the labeled sections)</Label>
                        <MarkdownEditor
                          value={preamble}
                          onChange={setPreamble}
                          rows={3}
                          testId="input-edit-preamble"
                        />
                      </div>
                    </AccordionContent>
                  </AccordionItem>

                  <AccordionItem value="note" className="border-border">
                    <AccordionTrigger className={accTriggerClass}>UPDATE NOTE (OPTIONAL)</AccordionTrigger>
                    <AccordionContent>
                      <Textarea
                        value={updateNote}
                        onChange={(e) => setUpdateNote(e.target.value)}
                        placeholder="What changed? e.g. Installed Sandevistan MK.3, retconned backstory, etc."
                        rows={3}
                        maxLength={2000}
                        data-testid="input-edit-update-note"
                      />
                      <p className="text-xs font-mono text-muted-foreground mt-1">
                        If filled in, this note is appended to the character's update log (visible at the bottom of the profile).
                      </p>
                    </AccordionContent>
                  </AccordionItem>
                </Accordion>
              </TabsContent>

              {/* MEDIA */}
              <TabsContent value="media" className="mt-0 space-y-6">
                <ImageEditor
                  title="PORTRAITS"
                  urls={portraitUrls}
                  onChange={setPortraitUrls}
                  profileUrl={portraitUrl}
                  onSetProfile={setPortraitUrl}
                  allowProfile
                  testIdPrefix="portrait"
                />
                <ImageEditor
                  title="STATS / SHEET IMAGES"
                  urls={statsImageUrls}
                  onChange={setStatsImageUrls}
                  testIdPrefix="stats"
                />
              </TabsContent>

              {/* CYBERWARE — staff edit it directly here (applied immediately). For
                  players, direct edits are hidden: their cyberware changes must go
                  through review via the request flow on the character's Cyberware
                  tab, so we only show a pointer instead of the immediate editor. */}
              <TabsContent value="cyberware" className="mt-0">
                {isStaff ? (
                  <div className="border border-nc-cyan/30 p-4 space-y-3 bg-card/20">
                    <CyberwareEditor rows={cyberRows} onChange={setCyberRows} testIdPrefix="edit" />
                    <div className="flex items-center justify-between gap-2 border-t border-border pt-3">
                      <p className="text-[10px] font-mono text-muted-foreground">
                        Staff edits apply immediately and do not go through review.
                      </p>
                      <Button
                        type="button"
                        size="sm"
                        disabled={savingCyber}
                        onClick={saveCyberware}
                        className="rounded-none font-display text-xs bg-nc-cyan text-background"
                        data-testid="button-save-cyberware"
                      >
                        {savingCyber ? "SAVING…" : "SAVE CYBERWARE"}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="border border-nc-cyan/30 p-4 bg-card/20">
                    <p className="text-xs font-mono text-muted-foreground" data-testid="text-cyberware-review-note">
                      Cyberware changes go through review. Request an install or removal
                      from the <span className="text-nc-cyan">Cyberware</span> tab on the
                      character page and a fixer will approve it.
                    </p>
                  </div>
                )}
              </TabsContent>

              {/* STAFF one-stop-shop: grant gear / guns / property to any character */}
              {isStaff && (
                <TabsContent value="staff" className="mt-0">
                  <StaffGrantSections characterId={character.id} characterName={character.name} />
                </TabsContent>
              )}

              {/* DANGER — permanent deletion (admins, archivists, coordinators) */}
              {canDelete && (
                <TabsContent value="danger" className="mt-0">
                  <div className="space-y-3" data-testid="section-danger-zone">
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
                      <Label className="text-xs">
                        Type <span className="text-destructive">DELETE</span> to confirm
                      </Label>
                      <Input
                        value={deleteConfirm}
                        onChange={(e) => setDeleteConfirm(e.target.value)}
                        autoComplete="off"
                        placeholder="DELETE"
                        data-testid="input-delete-confirm"
                      />
                    </div>
                    <Button
                      type="button"
                      disabled={!canConfirmDelete}
                      onClick={() => del.mutate({ id: character.id })}
                      className="rounded-none bg-destructive text-destructive-foreground hover:bg-destructive/80 font-display disabled:opacity-50"
                      data-testid="button-confirm-delete"
                    >
                      {del.isPending ? "DELETING..." : "DELETE CHARACTER"}
                    </Button>
                  </div>
                </TabsContent>
              )}
            </div>
          </Tabs>

          {/* Persistent footer actions */}
          <div className="flex shrink-0 justify-end gap-2 border-t border-border px-6 py-4">
            <Button
              type="button"
              variant="outline"
              className="rounded-none font-display"
              onClick={() => onOpenChange(false)}
              data-testid="button-cancel-edit"
            >
              CANCEL
            </Button>
            <Button
              type="submit"
              disabled={update.isPending}
              className="rounded-none bg-nc-cyan text-background hover:bg-nc-cyan/80 font-display"
              data-testid="button-save-edit"
            >
              {update.isPending ? "SAVING..." : "SUBMIT FOR REVIEW"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
