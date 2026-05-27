import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useParams } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useSubmitSheet,
  useUpdateSheet,
  useSubmitDraftSheet,
  useDeleteSheet,
  useGetSheet,
  getListMySheetsQueryKey,
  getGetSheetQueryKey,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Plus, Trash2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface Pair { name: string; value: number }
interface CW { slot: string; name: string; points: number; humanityLoss: number; notes: string }

const SLOTS = [
  "Arms & Arm Attachments (Left)",
  "Arms & Arm Attachments (Right)",
  "Auditory System",
  "Circulatory & Immune Systems",
  "Hands",
  "Feet",
  "Integumentary System",
  "Legs & Mobility (Left)",
  "Legs & Mobility (Right)",
  "Neural",
  "Ocular System",
  "Skeleton & Torso Musculature",
  "Universal Muscular (Arms/Legs/Tail)",
] as const;

function emptyChrome(): CW[] {
  return SLOTS.map((s) => ({ slot: s, name: "", points: 0, humanityLoss: 0, notes: "" }));
}

function pairsFromObject(o: unknown): Pair[] {
  if (!o || typeof o !== "object") return [{ name: "", value: 0 }];
  const entries = Object.entries(o as Record<string, unknown>);
  if (entries.length === 0) return [{ name: "", value: 0 }];
  return entries.map(([name, value]) => ({ name, value: Number(value) || 0 }));
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
  if (draftId && loaded && loaded.status !== "draft" && loaded.status !== "changes_requested") {
    return (
      <div className="max-w-4xl mx-auto py-8 space-y-3">
        <h1 className="text-2xl font-display text-destructive">SHEET LOCKED</h1>
        <p className="font-mono text-sm text-muted-foreground">
          This sheet has already been submitted and is in status: {loaded.status}. It can no longer be edited.
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
  const [startingEddies, setStartingEddies] = useState<number>(Number(init.startingEddies) || 0);
  const [attributes, setAttributes] = useState<Pair[]>(pairsFromObject(init.attributes));
  const [skills, setSkills] = useState<Pair[]>(pairsFromObject(init.skills));
  const [chrome, setChrome] = useState<CW[]>(() => {
    const incoming = Array.isArray(init.cyberwareBySlot) ? init.cyberwareBySlot : null;
    if (!incoming || incoming.length !== SLOTS.length) return emptyChrome();
    return SLOTS.map((s, i) => ({
      slot: s,
      name: String(incoming[i]?.name ?? ""),
      points: Number(incoming[i]?.points) || 0,
      humanityLoss: Number(incoming[i]?.humanityLoss) || 0,
      notes: String(incoming[i]?.notes ?? ""),
    }));
  });
  const [misc, setMisc] = useState<CW[]>(() => {
    const incoming = Array.isArray(init.cyberwareMisc) ? init.cyberwareMisc : [];
    return incoming.map((m: any) => ({
      slot: String(m?.slot ?? "Misc"),
      name: String(m?.name ?? ""),
      points: Number(m?.points) || 0,
      humanityLoss: Number(m?.humanityLoss) || 0,
      notes: String(m?.notes ?? ""),
    }));
  });
  const [gear, setGear] = useState<string[]>(
    Array.isArray(init.gear) && init.gear.length > 0 ? init.gear.map(String) : [""],
  );

  const filledChrome = chrome.filter((c) => c.name.trim().length > 0);
  const filledMisc = misc.filter((c) => c.name.trim().length > 0);
  const pointsSpent =
    filledChrome.reduce((s, c) => s + (Number(c.points) || 0), 0) +
    filledMisc.reduce((s, c) => s + (Number(c.points) || 0), 0);
  const overCap = pointsSpent > 6;
  const overSlots = filledChrome.length > SLOTS.length;

  const buildPayload = () => ({
    sheetType,
    fullName, nickname, pronouns, occupation, archetype,
    age: Number(age) || 0, gender,
    physicalDescription, appearance, psychProfile, background, notes,
    startingEddies: Number(startingEddies) || 0,
    attributes: attributes.filter((a) => a.name).reduce((o, a) => ({ ...o, [a.name]: Number(a.value) }), {}),
    skills: skills.filter((s) => s.name).reduce((o, s) => ({ ...o, [s.name]: Number(s.value) }), {}),
    cyberware: [...filledChrome, ...filledMisc],
    cyberwareBySlot: chrome,
    cyberwareMisc: filledMisc,
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
    [sheetType, fullName, nickname, pronouns, occupation, archetype, age, gender, physicalDescription, appearance, psychProfile, background, notes, startingEddies, attributes, skills, chrome, misc, gear],
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
        if (autoSaveStatus === "dirty" || autoSaveStatus === "saving") {
          // best-effort fire-and-forget
          saveDraft({ silent: true });
        }
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (overCap || overSlots) return;
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
            Cyberpunk Red rules · max 11 cyberware slots · 6 humanity pts at creation.
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

      <Card className="rounded-none border-border bg-card/50">
        <CardHeader><CardTitle className="font-display tracking-widest">IDENTITY</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field label="Sheet Type">
            <select data-testid="select-sheet-type" className="w-full h-9 bg-background border border-border px-2 text-sm font-mono" value={sheetType} onChange={(e) => setSheetType(e.target.value as "PC" | "NPC")}>
              <option value="PC">PC</option>
              <option value="NPC">NPC</option>
            </select>
          </Field>
          <Field label="Full Name"><Input data-testid="input-fullname" value={fullName} onChange={(e) => setFullName(e.target.value)} /></Field>
          <Field label="Nickname / Handle"><Input data-testid="input-nickname" value={nickname} onChange={(e) => setNickname(e.target.value)} /></Field>
          <Field label="Pronouns"><Input data-testid="input-pronouns" value={pronouns} onChange={(e) => setPronouns(e.target.value)} /></Field>
          <Field label="Occupation / Role"><Input data-testid="input-occupation" value={occupation} onChange={(e) => setOccupation(e.target.value)} /></Field>
          <Field label="Archetype"><Input data-testid="input-archetype" value={archetype} onChange={(e) => setArchetype(e.target.value)} /></Field>
          <Field label="Age"><Input data-testid="input-age" type="number" value={age} onChange={(e) => setAge(e.target.value)} /></Field>
          <Field label="Gender"><Input data-testid="input-gender" value={gender} onChange={(e) => setGender(e.target.value)} /></Field>
          <Field label="Starting Eddies"><Input data-testid="input-eddies" type="number" value={startingEddies} onChange={(e) => setStartingEddies(Number(e.target.value))} /></Field>
        </CardContent>
      </Card>

      <Card className="rounded-none border-border bg-card/50">
        <CardHeader><CardTitle className="font-display tracking-widest">PHYSICAL DESCRIPTION</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <Field label="Build, Height, Distinguishing Features"><Textarea data-testid="input-physical" rows={3} value={physicalDescription} onChange={(e) => setPhysicalDescription(e.target.value)} /></Field>
          <Field label="Style & Visible Cyberware"><Textarea data-testid="input-appearance" rows={3} value={appearance} onChange={(e) => setAppearance(e.target.value)} /></Field>
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

      <PairsCard title="ATTRIBUTES" pairs={attributes} setPairs={setAttributes} placeholder="INT, REF, etc." testid="attr" />
      <PairsCard title="SKILLS" pairs={skills} setPairs={setSkills} placeholder="Handgun, Stealth..." testid="skill" />

      <Card className="rounded-none border-border bg-card/50">
        <CardHeader>
          <CardTitle className="font-display tracking-widest">
            FOUNDATIONAL CHROME — {SLOTS.length} SLOTS <span className={overSlots ? "text-destructive" : "text-nc-cyan"}>({filledChrome.length}/{SLOTS.length})</span>
            <span className={`ml-4 ${overCap ? "text-destructive" : "text-nc-yellow"}`}>HUM PTS: {pointsSpent}/6</span>
          </CardTitle>
          <p className="text-xs font-mono text-muted-foreground mt-1">One install per named slot (per-arm, per-leg semantics). Leave INSTALL blank to mark slot empty.</p>
        </CardHeader>
        <CardContent className="space-y-3">
          {chrome.map((cw, i) => (
            <div key={cw.slot} className="grid grid-cols-12 gap-2 items-end border border-border/50 p-3" data-testid={`row-cyberware-${i}`}>
              <div className="col-span-3">
                <Label className="text-xs font-mono">SLOT</Label>
                <div className="h-9 flex items-center px-2 text-sm font-mono text-nc-cyan border border-border bg-background/50">{cw.slot}</div>
              </div>
              <div className="col-span-4"><Label className="text-xs font-mono">INSTALL</Label><Input value={cw.name} placeholder="(empty)" onChange={(e) => setChrome(chrome.map((c, j) => j === i ? { ...c, name: e.target.value } : c))} data-testid={`input-cyberware-name-${i}`} /></div>
              <div className="col-span-1"><Label className="text-xs font-mono">PTS</Label><Input type="number" min={0} value={cw.points} onChange={(e) => setChrome(chrome.map((c, j) => j === i ? { ...c, points: Number(e.target.value) } : c))} /></div>
              <div className="col-span-1"><Label className="text-xs font-mono">HL</Label><Input type="number" min={0} value={cw.humanityLoss} onChange={(e) => setChrome(chrome.map((c, j) => j === i ? { ...c, humanityLoss: Number(e.target.value) } : c))} /></div>
              <div className="col-span-3"><Label className="text-xs font-mono">NOTES</Label><Input value={cw.notes} onChange={(e) => setChrome(chrome.map((c, j) => j === i ? { ...c, notes: e.target.value } : c))} /></div>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card className="rounded-none border-border bg-card/50">
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="font-display tracking-widest">
            MISC CHROME — UNLIMITED <span className="text-nc-cyan">({filledMisc.length})</span>
          </CardTitle>
          <Button type="button" onClick={() => setMisc([...misc, { slot: "Misc", name: "", points: 0, humanityLoss: 0, notes: "" }])} className="rounded-none bg-nc-cyan text-background hover:bg-nc-cyan/80 font-display" data-testid="button-add-misc"><Plus className="w-4 h-4 mr-1" /> ADD</Button>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs font-mono text-muted-foreground">Fashionware, internal/external, borgware, cyberweapons, other implants. Counted toward the 6 humanity-pt cap at creation.</p>
          {misc.length === 0 && <p className="text-muted-foreground font-mono text-sm">No misc chrome.</p>}
          {misc.map((cw, i) => (
            <div key={i} className="grid grid-cols-12 gap-2 items-end border border-border/50 p-3" data-testid={`row-misc-${i}`}>
              <div className="col-span-2"><Label className="text-xs font-mono">CATEGORY</Label><Input value={cw.slot} placeholder="Fashionware" onChange={(e) => setMisc(misc.map((c, j) => j === i ? { ...c, slot: e.target.value } : c))} /></div>
              <div className="col-span-4"><Label className="text-xs font-mono">INSTALL</Label><Input value={cw.name} onChange={(e) => setMisc(misc.map((c, j) => j === i ? { ...c, name: e.target.value } : c))} data-testid={`input-misc-name-${i}`} /></div>
              <div className="col-span-1"><Label className="text-xs font-mono">PTS</Label><Input type="number" min={0} value={cw.points} onChange={(e) => setMisc(misc.map((c, j) => j === i ? { ...c, points: Number(e.target.value) } : c))} /></div>
              <div className="col-span-1"><Label className="text-xs font-mono">HL</Label><Input type="number" min={0} value={cw.humanityLoss} onChange={(e) => setMisc(misc.map((c, j) => j === i ? { ...c, humanityLoss: Number(e.target.value) } : c))} /></div>
              <div className="col-span-3"><Label className="text-xs font-mono">NOTES</Label><Input value={cw.notes} onChange={(e) => setMisc(misc.map((c, j) => j === i ? { ...c, notes: e.target.value } : c))} /></div>
              <Button type="button" variant="ghost" size="icon" onClick={() => setMisc(misc.filter((_, j) => j !== i))} className="text-destructive" data-testid={`button-remove-misc-${i}`}><Trash2 className="w-4 h-4" /></Button>
            </div>
          ))}
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
        <CardHeader><CardTitle className="font-display tracking-widest">NOTES</CardTitle></CardHeader>
        <CardContent><Textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} data-testid="input-notes" /></CardContent>
      </Card>

      <div className="flex flex-wrap gap-3 justify-end items-center">
        <Button type="button" variant="outline" onClick={() => setLocation("/characters")} className="rounded-none font-display">CANCEL</Button>
        {draftId && (
          <Button type="button" variant="destructive" onClick={onDeleteDraft} disabled={deleteMut.isPending} className="rounded-none font-display" data-testid="button-discard-draft">
            DISCARD DRAFT
          </Button>
        )}
        <Button type="button" onClick={() => saveDraft()} disabled={saving || createMut.isPending} className="rounded-none border border-nc-cyan bg-transparent text-nc-cyan hover:bg-nc-cyan/10 font-display" data-testid="button-save-draft">
          {saving ? "SAVING..." : "SAVE DRAFT"}
        </Button>
        <Button type="submit" disabled={submitting || overCap || overSlots} className="rounded-none bg-nc-cyan text-background hover:bg-nc-cyan/80 font-display tracking-widest" data-testid="button-submit-sheet">
          {submitting ? "TRANSMITTING..." : "SUBMIT FOR REVIEW"}
        </Button>
      </div>
    </form>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><Label className="text-xs font-mono text-muted-foreground tracking-widest">{label.toUpperCase()}</Label>{children}</div>;
}

function PairsCard({ title, pairs, setPairs, placeholder, testid }: {
  title: string; pairs: Pair[]; setPairs: (p: Pair[]) => void; placeholder: string; testid: string;
}) {
  return (
    <Card className="rounded-none border-border bg-card/50">
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="font-display tracking-widest">{title}</CardTitle>
        <Button type="button" onClick={() => setPairs([...pairs, { name: "", value: 0 }])} className="rounded-none bg-nc-cyan text-background hover:bg-nc-cyan/80 font-display" data-testid={`button-add-${testid}`}><Plus className="w-4 h-4 mr-1" /> ADD</Button>
      </CardHeader>
      <CardContent className="space-y-2">
        {pairs.map((p, i) => (
          <div key={i} className="flex gap-2 items-center">
            <Input className="flex-1" placeholder={placeholder} value={p.name} onChange={(e) => setPairs(pairs.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} data-testid={`input-${testid}-name-${i}`} />
            <Input className="w-24" type="number" value={p.value} onChange={(e) => setPairs(pairs.map((x, j) => j === i ? { ...x, value: Number(e.target.value) } : x))} data-testid={`input-${testid}-value-${i}`} />
            <Button type="button" variant="ghost" size="icon" onClick={() => setPairs(pairs.filter((_, j) => j !== i))} className="text-destructive"><Trash2 className="w-4 h-4" /></Button>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
