import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useParams } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useSubmitSheet,
  useUpdateSheet,
  useSubmitDraftSheet,
  useDeleteSheet,
  useGetSheet,
  useListCyberware,
  getListMySheetsQueryKey,
  getGetSheetQueryKey,
} from "@workspace/api-client-react";
import { useAuthMe } from "@/hooks/useAuthMe";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Plus, Trash2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface CW {
  slot: string;
  name: string;
  points: number;
  humanityLoss: number;
  notes: string;
  isCustom: boolean;
}

const CUSTOM_SLOT = "__custom__";

// Turn whatever skills shape an older sheet stored (object of skill->rank, or a
// plain string) into the free-text value the form now uses.
function skillsToText(o: unknown): string {
  if (typeof o === "string") return o;
  if (o && typeof o === "object") {
    return Object.entries(o as Record<string, unknown>)
      .map(([k, v]) => (v != null && v !== "" ? `${k} ${v}` : k))
      .join("\n");
  }
  return "";
}

// Load cyberware from the current `cyberware` list, falling back to the legacy
// foundational-by-slot + misc lists so older drafts can still be edited.
function loadCyberware(init: Record<string, any>): CW[] {
  const current = Array.isArray(init.cyberware) ? init.cyberware : null;
  const legacy = current
    ? null
    : [
        ...(Array.isArray(init.cyberwareBySlot) ? init.cyberwareBySlot : []),
        ...(Array.isArray(init.cyberwareMisc) ? init.cyberwareMisc : []),
      ];
  const src: any[] = current ?? legacy ?? [];
  return src
    .filter((c) => typeof c?.name === "string" && c.name.trim().length > 0)
    .map((c) => ({
      slot: String(c.slot ?? ""),
      name: String(c.name ?? ""),
      points: Number(c.points) || 0,
      humanityLoss: Number(c.humanityLoss) || 0,
      notes: String(c.notes ?? ""),
      isCustom: false,
    }));
}

export default function NewSheet() {
  const params = useParams<{ id?: string }>();
  const draftId = params.id ? Number(params.id) : null;
  const { data: loaded, isLoading: isLoadingDraft } = useGetSheet(draftId ?? 0, {
    query: { enabled: !!draftId } as any,
  });

  if (draftId && isLoadingDraft) {
    return <div className="font-display text-nc-cyan animate-pulse">LOADING DRAFT...</div>;
  }
  if (
    draftId &&
    loaded &&
    loaded.status !== "draft" &&
    loaded.status !== "changes_requested" &&
    loaded.status !== "pending"
  ) {
    return (
      <div className="max-w-4xl mx-auto py-8 space-y-3">
        <h1 className="text-2xl font-display text-destructive">SHEET LOCKED</h1>
        <p className="font-mono text-sm text-muted-foreground">
          This sheet has already been {loaded.status} and can no longer be edited.
        </p>
      </div>
    );
  }
  return <SheetForm key={draftId ?? "new"} initialSheet={loaded ?? null} draftId={draftId} />;
}

interface SheetFormProps {
  initialSheet: { id: number; name: string; status: string; data: any } | null;
  draftId: number | null;
}

function SheetForm({ initialSheet, draftId: initialDraftId }: SheetFormProps) {
  const qc = useQueryClient();
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const init = (initialSheet?.data ?? {}) as Record<string, any>;

  const { data: me, isLoading: meLoading } = useAuthMe();
  const isFixer = !!(me?.isFixer || me?.isAdmin);
  // A pending sheet is being edited in place (by its owner or a reviewer)
  // while it is still in review — no re-submit, just save changes.
  const isInReview = initialSheet?.status === "pending";
  const { data: catalog } = useListCyberware();

  // Distinct slot names from the cyberware catalog, plus a quick lookup set.
  const catalogSlots = useMemo(() => {
    const set = new Set<string>();
    (catalog ?? []).forEach((c) => {
      if (c.slot) set.add(c.slot);
    });
    return Array.from(set).sort();
  }, [catalog]);
  const catalogSlotSet = useMemo(() => new Set(catalogSlots), [catalogSlots]);

  const [draftId, setDraftId] = useState<number | null>(initialDraftId);
  const [sheetType, setSheetType] = useState<"PC" | "NPC">(init.sheetType === "NPC" ? "NPC" : "PC");
  const [fullName, setFullName] = useState<string>(init.fullName ?? initialSheet?.name ?? "");
  const [nickname, setNickname] = useState<string>(init.nickname ?? "");
  const [pronouns, setPronouns] = useState<string>(init.pronouns ?? "");
  const [occupation, setOccupation] = useState<string>(init.occupation ?? "");
  const [archetype, setArchetype] = useState<string>(init.archetype ?? "");
  const [age, setAge] = useState<string>(init.age != null ? String(init.age) : "");
  const [gender, setGender] = useState<string>(init.gender ?? "");
  const [physicalDescription, setPhysicalDescription] = useState<string>(init.physicalDescription ?? "");
  const [appearance, setAppearance] = useState<string>(init.appearance ?? "");
  const [psychProfile, setPsychProfile] = useState<string>(init.psychProfile ?? "");
  const [background, setBackground] = useState<string>(init.background ?? "");
  const [notes, setNotes] = useState<string>(init.notes ?? "");
  const [skills, setSkills] = useState<string>(skillsToText(init.skills));
  const [chrome, setChrome] = useState<CW[]>(() => loadCyberware(init));
  const [gear, setGear] = useState<string[]>(
    Array.isArray(init.gear) && init.gear.length > 0 ? init.gear.map(String) : [""],
  );

  // Non-fixers may only create PCs — force PC if a stale NPC value slips in.
  // Wait for auth to resolve first so a fixer's NPC draft is never downgraded
  // during the brief window before `me` loads. Never coerce a sheet that is
  // already in review: staff (e.g. a CS approver who isn't a fixer) may be
  // editing an existing NPC sheet, and coercing it would corrupt the type.
  useEffect(() => {
    if (!meLoading && !isFixer && !isInReview && sheetType !== "PC") setSheetType("PC");
  }, [meLoading, isFixer, isInReview, sheetType]);

  const filledChrome = chrome.filter((c) => c.name.trim().length > 0);
  const pointsSpent = filledChrome.reduce((s, c) => s + (Number(c.points) || 0), 0);
  const overCap = pointsSpent > 6;

  // A row renders in "custom" mode when the user explicitly chose Custom, or
  // when a loaded slot isn't part of the catalog (e.g. legacy free-text slots).
  const rowIsCustom = (cw: CW) => cw.isCustom || (cw.slot !== "" && !catalogSlotSet.has(cw.slot));

  function updateRow(i: number, patch: Partial<CW>) {
    setChrome(chrome.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  }

  function onSlotChange(i: number, value: string) {
    if (value === CUSTOM_SLOT) {
      updateRow(i, { isCustom: true, slot: "", name: "", points: 0, humanityLoss: 0, notes: "" });
    } else {
      updateRow(i, { isCustom: false, slot: value, name: "", points: 0, humanityLoss: 0, notes: "" });
    }
  }

  function onInstallChange(i: number, name: string, slot: string) {
    const item = (catalog ?? []).find((c) => c.slot === slot && c.name === name);
    updateRow(i, {
      name,
      points: item ? Number(item.cwp) || 0 : 0,
      humanityLoss: item ? Number(item.humanityLoss) || 0 : 0,
      notes: item?.description ?? "",
    });
  }

  const buildPayload = () => ({
    sheetType,
    fullName, nickname, pronouns, occupation, archetype,
    age: Number(age) || 0, gender,
    physicalDescription, appearance, psychProfile, background, notes,
    skills,
    cyberware: filledChrome.map((c) => ({
      slot: c.slot.trim() || "Custom",
      name: c.name,
      points: Number(c.points) || 0,
      humanityLoss: Number(c.humanityLoss) || 0,
      notes: c.notes,
    })),
    cyberwarePointsSpent: pointsSpent,
    gear: gear.filter(Boolean),
  });

  const createMut = useSubmitSheet();
  const updateMut = useUpdateSheet();
  const submitDraftMut = useSubmitDraftSheet();
  const deleteMut = useDeleteSheet();

  // Snapshot of last persisted form state to detect dirty, and a debounce timer.
  const lastPersistedRef = useRef<string>(JSON.stringify({ fullName: init.fullName ?? "", payload: init }));
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [autoSaveStatus, setAutoSaveStatus] = useState<"idle" | "dirty" | "saving" | "saved" | "error">("idle");
  // Mirror of autoSaveStatus so the unmount cleanup (which has empty deps) can
  // read the *latest* value instead of the stale mount-time closure value.
  const autoSaveStatusRef = useRef(autoSaveStatus);
  autoSaveStatusRef.current = autoSaveStatus;

  function invalidateLists() {
    qc.invalidateQueries({ queryKey: getListMySheetsQueryKey() });
    if (draftId) qc.invalidateQueries({ queryKey: getGetSheetQueryKey(draftId) });
  }

  async function saveDraft(opts?: { silent?: boolean }): Promise<number | null> {
    // Need at least a name to identify the draft on the server.
    const draftName = fullName.trim() || "(untitled draft)";
    const data = buildPayload();
    setAutoSaveStatus("saving");
    try {
      if (draftId) {
        await updateMut.mutateAsync({ id: draftId, data: { name: draftName, data: data as any } });
        lastPersistedRef.current = JSON.stringify({ fullName: draftName, payload: data });
        invalidateLists();
        setAutoSaveStatus("saved");
        if (!opts?.silent) toast({ title: "Draft saved" });
        return draftId;
      } else {
        const created = await createMut.mutateAsync({
          data: { name: draftName, data: data as any, status: "draft" } as any,
        });
        setDraftId(created.id);
        lastPersistedRef.current = JSON.stringify({ fullName: draftName, payload: data });
        invalidateLists();
        setAutoSaveStatus("saved");
        if (!opts?.silent) toast({ title: "Draft saved" });
        // Update the URL so a refresh keeps editing the same draft.
        setLocation(`/sheets/${created.id}/edit`, { replace: true });
        return created.id;
      }
    } catch (e: any) {
      setAutoSaveStatus("error");
      if (!opts?.silent) {
        toast({ title: "Could not save draft", description: String(e?.message ?? e), variant: "destructive" });
      }
      return null;
    }
  }

  // Debounced auto-save: every change marks dirty; 3s of inactivity triggers a silent save.
  const payloadSig = useMemo(
    () => JSON.stringify({ fullName: fullName.trim() || "(untitled draft)", payload: buildPayload() }),
    // We want this to recompute whenever any field changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sheetType, fullName, nickname, pronouns, occupation, archetype, age, gender, physicalDescription, appearance, psychProfile, background, notes, skills, chrome, gear],
  );

  useEffect(() => {
    if (payloadSig === lastPersistedRef.current) return;
    // Don't autosave a completely empty form (no name + still default scaffolding).
    if (!fullName.trim() && !draftId) {
      setAutoSaveStatus("idle");
      return;
    }
    setAutoSaveStatus("dirty");
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveDraft({ silent: true });
    }, 3000);
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payloadSig]);

  // Flush pending autosave on unmount/navigation.
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        if (autoSaveStatusRef.current === "dirty" || autoSaveStatusRef.current === "saving") {
          // best-effort fire-and-forget
          saveDraft({ silent: true });
        }
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (overCap) return;
    // A sheet already in review is saved in place — never re-submitted.
    if (isInReview) {
      await saveDraft();
      return;
    }
    if (!fullName.trim()) {
      toast({ title: "Name required", variant: "destructive" });
      return;
    }
    try {
      // Make sure the latest edits are persisted, then promote/submit.
      const id = await saveDraft({ silent: true });
      if (id) {
        await submitDraftMut.mutateAsync({ id });
        invalidateLists();
        toast({ title: "Sheet submitted", description: "CS approvers have been notified." });
        setLocation("/characters");
      } else {
        // Fallback path: no draft id, attempt a direct submission.
        await createMut.mutateAsync({
          data: { name: fullName, data: buildPayload() as any },
        });
        invalidateLists();
        toast({ title: "Sheet submitted" });
        setLocation("/characters");
      }
    } catch (e: any) {
      toast({ title: "Submission failed", description: String(e?.message ?? e), variant: "destructive" });
    }
  }

  async function onDeleteDraft() {
    if (!draftId) return;
    if (!window.confirm("Discard this draft?")) return;
    try {
      await deleteMut.mutateAsync({ id: draftId });
      invalidateLists();
      toast({ title: "Draft discarded" });
      setLocation("/characters");
    } catch (e: any) {
      toast({ title: "Could not discard", description: String(e?.message ?? e), variant: "destructive" });
    }
  }

  const submitting = createMut.isPending || submitDraftMut.isPending;
  const saving = updateMut.isPending || (createMut.isPending && autoSaveStatus !== "idle");
  const statusLabel = autoSaveStatus === "saving" || saving
    ? "Saving..."
    : autoSaveStatus === "dirty"
    ? "Unsaved changes"
    : autoSaveStatus === "saved"
    ? "Draft saved"
    : autoSaveStatus === "error"
    ? "Save failed"
    : draftId ? "Draft loaded" : "";

  return (
    <form onSubmit={onSubmit} className="space-y-6 max-w-4xl mx-auto pb-12">
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
        <div>
          <h1 className="text-4xl font-display font-bold text-foreground" data-testid="text-new-sheet-title">
            {draftId ? "EDIT CHARACTER" : "NEW CHARACTER"}
          </h1>
          <p className="text-muted-foreground font-mono mt-2 text-sm">
            Night City RP · cyberware is optional · up to 6 CWP at creation.
          </p>
        </div>
        <div className="font-mono text-xs text-muted-foreground">
          {statusLabel && (
            <span
              className={
                autoSaveStatus === "error"
                  ? "text-destructive"
                  : autoSaveStatus === "saved"
                  ? "text-nc-cyan"
                  : "text-nc-yellow"
              }
              data-testid="text-autosave-status"
            >
              {statusLabel}
            </span>
          )}
        </div>
      </div>

      {initialSheet?.status === "changes_requested" && initialSheet && (
        <Card className="rounded-none border-nc-yellow bg-card/50">
          <CardHeader>
            <CardTitle className="font-display tracking-widest text-nc-yellow">CHANGES REQUESTED</CardTitle>
          </CardHeader>
          <CardContent className="font-mono text-sm">
            {(initialSheet as any).decisionNote || "An approver requested changes. Update the fields and resubmit."}
          </CardContent>
        </Card>
      )}

      {isInReview && (
        <Card className="rounded-none border-nc-cyan bg-card/50">
          <CardHeader>
            <CardTitle className="font-display tracking-widest text-nc-cyan">IN REVIEW</CardTitle>
          </CardHeader>
          <CardContent className="font-mono text-sm text-muted-foreground">
            This sheet is awaiting approval. Changes are saved in place and stay visible to reviewers — there's no need to resubmit.
          </CardContent>
        </Card>
      )}

      <Card className="rounded-none border-border bg-card/50">
        <CardHeader><CardTitle className="font-display tracking-widest">IDENTITY</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {isFixer && (
            <Field label="Sheet Type">
              <select data-testid="select-sheet-type" className="w-full h-9 bg-background border border-border px-2 text-sm font-mono" value={sheetType} onChange={(e) => setSheetType(e.target.value as "PC" | "NPC")}>
                <option value="PC">PC</option>
                <option value="NPC">NPC</option>
              </select>
            </Field>
          )}
          <Field label="Full Name"><Input data-testid="input-fullname" value={fullName} onChange={(e) => setFullName(e.target.value)} /></Field>
          <Field label="Nickname / Handle"><Input data-testid="input-nickname" value={nickname} onChange={(e) => setNickname(e.target.value)} /></Field>
          <Field label="Pronouns"><Input data-testid="input-pronouns" value={pronouns} onChange={(e) => setPronouns(e.target.value)} /></Field>
          <Field label="Occupation / Role"><Input data-testid="input-occupation" value={occupation} onChange={(e) => setOccupation(e.target.value)} /></Field>
          <Field label="Archetype"><Input data-testid="input-archetype" value={archetype} onChange={(e) => setArchetype(e.target.value)} /></Field>
          <Field label="Age"><Input data-testid="input-age" type="number" value={age} onChange={(e) => setAge(e.target.value)} /></Field>
          <Field label="Gender"><Input data-testid="input-gender" value={gender} onChange={(e) => setGender(e.target.value)} /></Field>
        </CardContent>
      </Card>

      <Card className="rounded-none border-border bg-card/50">
        <CardHeader><CardTitle className="font-display tracking-widest">PHYSICAL DESCRIPTION</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <Field label="Build, Height, Distinguishing Features"><Textarea data-testid="input-physical" rows={3} value={physicalDescription} onChange={(e) => setPhysicalDescription(e.target.value)} /></Field>
          <Field label="Style"><Textarea data-testid="input-appearance" rows={3} value={appearance} onChange={(e) => setAppearance(e.target.value)} /></Field>
        </CardContent>
      </Card>

      <Card className="rounded-none border-border bg-card/50">
        <CardHeader><CardTitle className="font-display tracking-widest">PSYCHOLOGICAL PROFILE</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <Field label="Personality, Motivations, Fears"><Textarea data-testid="input-psych" rows={4} value={psychProfile} onChange={(e) => setPsychProfile(e.target.value)} /></Field>
        </CardContent>
      </Card>

      <Card className="rounded-none border-border bg-card/50">
        <CardHeader><CardTitle className="font-display tracking-widest">BACKGROUND</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <Field label="Lifepath / Background"><Textarea data-testid="input-background" rows={5} value={background} onChange={(e) => setBackground(e.target.value)} /></Field>
        </CardContent>
      </Card>

      <Card className="rounded-none border-border bg-card/50">
        <CardHeader><CardTitle className="font-display tracking-widest">SKILLS</CardTitle></CardHeader>
        <CardContent>
          <Field label="What is your character good at?">
            <Textarea data-testid="input-skills" rows={4} value={skills} onChange={(e) => setSkills(e.target.value)} placeholder="Describe your character's skills and talents in your own words..." />
          </Field>
        </CardContent>
      </Card>

      <Card className="rounded-none border-border bg-card/50">
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="font-display tracking-widest">GEAR</CardTitle>
          <Button type="button" onClick={() => setGear([...gear, ""])} className="rounded-none bg-nc-cyan text-background hover:bg-nc-cyan/80 font-display" data-testid="button-add-gear"><Plus className="w-4 h-4 mr-1" /> ADD</Button>
        </CardHeader>
        <CardContent className="space-y-2">
          {gear.map((g, i) => (
            <div key={i} className="flex gap-2"><Input value={g} onChange={(e) => setGear(gear.map((x, j) => j === i ? e.target.value : x))} placeholder="Combat knife, medkit..." data-testid={`input-gear-${i}`} />
              <Button type="button" variant="ghost" size="icon" onClick={() => setGear(gear.filter((_, j) => j !== i))} className="text-destructive"><Trash2 className="w-4 h-4" /></Button>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card className="rounded-none border-border bg-card/50">
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="font-display tracking-widest">
            CYBERWARE <span className={`ml-2 ${overCap ? "text-destructive" : "text-nc-yellow"}`}>CWP: {pointsSpent}/6</span>
          </CardTitle>
          <Button type="button" onClick={() => setChrome([...chrome, { slot: "", name: "", points: 0, humanityLoss: 0, notes: "", isCustom: false }])} className="rounded-none bg-nc-cyan text-background hover:bg-nc-cyan/80 font-display" data-testid="button-add-cyberware"><Plus className="w-4 h-4 mr-1" /> ADD</Button>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs font-mono text-muted-foreground">
            Optional. Pick a slot, then choose an install from the NCRP catalog — CWP is set automatically.
            Fully organic characters can leave this empty. Total CWP is capped at 6 at character creation.
          </p>
          {chrome.length === 0 && <p className="text-muted-foreground font-mono text-sm">No cyberware — fully organic.</p>}
          {chrome.map((cw, i) => {
            const isCustom = rowIsCustom(cw);
            const installs = (catalog ?? []).filter((c) => c.slot === cw.slot);
            return (
              <div key={i} className="grid grid-cols-12 gap-2 items-end border border-border/50 p-3" data-testid={`row-cyberware-${i}`}>
                <div className="col-span-4">
                  <Label className="text-xs font-mono">SLOT</Label>
                  <select
                    className="w-full h-9 bg-background border border-border px-2 text-sm font-mono"
                    value={isCustom ? CUSTOM_SLOT : cw.slot}
                    onChange={(e) => onSlotChange(i, e.target.value)}
                    data-testid={`select-cyberware-slot-${i}`}
                  >
                    <option value="">— select slot —</option>
                    {catalogSlots.map((s) => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                    <option value={CUSTOM_SLOT}>Custom…</option>
                  </select>
                  {isCustom && (
                    <Input
                      className="mt-1"
                      value={cw.slot}
                      placeholder="Custom slot name"
                      onChange={(e) => updateRow(i, { slot: e.target.value })}
                      data-testid={`input-cyberware-customslot-${i}`}
                    />
                  )}
                </div>
                <div className="col-span-6">
                  <Label className="text-xs font-mono">INSTALL</Label>
                  {isCustom ? (
                    <Input
                      value={cw.name}
                      placeholder="Custom install name"
                      onChange={(e) => updateRow(i, { name: e.target.value })}
                      data-testid={`input-cyberware-name-${i}`}
                    />
                  ) : (
                    <select
                      className="w-full h-9 bg-background border border-border px-2 text-sm font-mono"
                      value={cw.name}
                      disabled={!cw.slot}
                      onChange={(e) => onInstallChange(i, e.target.value, cw.slot)}
                      data-testid={`select-cyberware-name-${i}`}
                    >
                      <option value="">{cw.slot ? "— select install —" : "select a slot first"}</option>
                      {installs.map((it) => (
                        <option key={it.id} value={it.name}>
                          {it.name}{it.cwp ? ` · CWP ${it.cwp}` : ""}
                        </option>
                      ))}
                    </select>
                  )}
                  {cw.notes && <p className="text-xs font-mono text-muted-foreground mt-1">{cw.notes}</p>}
                </div>
                <div className="col-span-1">
                  <Label className="text-xs font-mono">CWP</Label>
                  {isCustom ? (
                    <Input
                      type="number"
                      min={0}
                      className="h-9 text-nc-yellow"
                      value={cw.points || 0}
                      onChange={(e) => updateRow(i, { points: Math.max(0, Number(e.target.value) || 0) })}
                      data-testid={`input-cyberware-cwp-${i}`}
                    />
                  ) : (
                    <div className="h-9 flex items-center px-2 text-sm font-mono text-nc-yellow border border-border bg-background/50" data-testid={`text-cyberware-cwp-${i}`}>{cw.points || 0}</div>
                  )}
                </div>
                <div className="col-span-1 flex justify-end">
                  <Button type="button" variant="ghost" size="icon" onClick={() => setChrome(chrome.filter((_, j) => j !== i))} className="text-destructive" data-testid={`button-remove-cyberware-${i}`}><Trash2 className="w-4 h-4" /></Button>
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>

      <Card className="rounded-none border-border bg-card/50">
        <CardHeader><CardTitle className="font-display tracking-widest">NOTES</CardTitle></CardHeader>
        <CardContent><Textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} data-testid="input-notes" /></CardContent>
      </Card>

      <div className="flex flex-wrap gap-3 justify-end items-center">
        <Button type="button" variant="outline" onClick={() => setLocation("/characters")} className="rounded-none font-display">CANCEL</Button>
        {draftId && !isInReview && (
          <Button type="button" variant="destructive" onClick={onDeleteDraft} disabled={deleteMut.isPending} className="rounded-none font-display" data-testid="button-discard-draft">
            DISCARD DRAFT
          </Button>
        )}
        <Button type="button" onClick={() => saveDraft()} disabled={saving || createMut.isPending} className="rounded-none border border-nc-cyan bg-transparent text-nc-cyan hover:bg-nc-cyan/10 font-display" data-testid="button-save-draft">
          {saving ? "SAVING..." : isInReview ? "SAVE CHANGES" : "SAVE DRAFT"}
        </Button>
        {!isInReview && (
          <Button type="submit" disabled={submitting || overCap} className="rounded-none bg-nc-cyan text-background hover:bg-nc-cyan/80 font-display tracking-widest" data-testid="button-submit-sheet">
            {submitting ? "TRANSMITTING..." : "SUBMIT FOR REVIEW"}
          </Button>
        )}
      </div>
    </form>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><Label className="text-xs font-mono text-muted-foreground tracking-widest">{label.toUpperCase()}</Label>{children}</div>;
}
