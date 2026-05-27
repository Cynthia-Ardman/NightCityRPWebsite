import { useState } from "react";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { useSubmitSheet, getListMySheetsQueryKey } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Plus, Trash2 } from "lucide-react";

interface Pair { name: string; value: number }
interface CW { slot: string; name: string; points: number; humanityLoss: number; notes: string }

const SLOTS = ["Head", "Eyes", "Arms", "Hands", "Operating System", "Nervous System",
  "Circulatory System", "Skin", "Skeleton", "Legs", "Internal Organs"];

export default function NewSheet() {
  const qc = useQueryClient();
  const [, setLocation] = useLocation();
  const submit = useSubmitSheet({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getListMySheetsQueryKey() });
        setLocation("/sheets");
      },
    },
  });

  const [fullName, setFullName] = useState("");
  const [nickname, setNickname] = useState("");
  const [archetype, setArchetype] = useState("");
  const [age, setAge] = useState("");
  const [gender, setGender] = useState("");
  const [appearance, setAppearance] = useState("");
  const [background, setBackground] = useState("");
  const [notes, setNotes] = useState("");
  const [startingEddies, setStartingEddies] = useState(0);
  const [attributes, setAttributes] = useState<Pair[]>([{ name: "", value: 0 }]);
  const [skills, setSkills] = useState<Pair[]>([{ name: "", value: 0 }]);
  const [cyberware, setCyberware] = useState<CW[]>([]);
  const [gear, setGear] = useState<string[]>([""]);

  const pointsSpent = cyberware.reduce((s, c) => s + (Number(c.points) || 0), 0);
  const overCap = pointsSpent > 6;
  const overSlots = cyberware.length > 11;

  function addCW() {
    if (cyberware.length >= 11) return;
    setCyberware([...cyberware, { slot: SLOTS[0], name: "", points: 0, humanityLoss: 0, notes: "" }]);
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (overCap || overSlots || !fullName) return;
    submit.mutate({
      data: {
        name: fullName,
        characterId: null,
        data: {
          fullName, nickname, archetype, age: Number(age) || 0, gender, appearance, background, notes,
          startingEddies: Number(startingEddies) || 0,
          attributes: attributes.filter((a) => a.name).reduce((o, a) => ({ ...o, [a.name]: Number(a.value) }), {}),
          skills: skills.filter((s) => s.name).reduce((o, s) => ({ ...o, [s.name]: Number(s.value) }), {}),
          cyberware, cyberwarePointsSpent: pointsSpent,
          gear: gear.filter(Boolean),
        },
      },
    });
  }

  return (
    <form onSubmit={onSubmit} className="space-y-6 max-w-4xl mx-auto pb-12">
      <div>
        <h1 className="text-4xl font-display font-bold text-foreground" data-testid="text-new-sheet-title">NEW CHARACTER SHEET</h1>
        <p className="text-muted-foreground font-mono mt-2">Cyberpunk Red rules · max 11 cyberware slots · 6 humanity pts at creation.</p>
      </div>

      <Card className="rounded-none border-border bg-card/50">
        <CardHeader><CardTitle className="font-display tracking-widest">IDENTITY</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field label="Full Name"><Input data-testid="input-fullname" required value={fullName} onChange={(e) => setFullName(e.target.value)} /></Field>
          <Field label="Nickname / Handle"><Input data-testid="input-nickname" value={nickname} onChange={(e) => setNickname(e.target.value)} /></Field>
          <Field label="Archetype"><Input data-testid="input-archetype" value={archetype} onChange={(e) => setArchetype(e.target.value)} /></Field>
          <Field label="Age"><Input data-testid="input-age" type="number" value={age} onChange={(e) => setAge(e.target.value)} /></Field>
          <Field label="Gender"><Input data-testid="input-gender" value={gender} onChange={(e) => setGender(e.target.value)} /></Field>
          <Field label="Starting Eddies"><Input data-testid="input-eddies" type="number" value={startingEddies} onChange={(e) => setStartingEddies(Number(e.target.value))} /></Field>
        </CardContent>
      </Card>

      <Card className="rounded-none border-border bg-card/50">
        <CardHeader><CardTitle className="font-display tracking-widest">APPEARANCE & BACKGROUND</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <Field label="Appearance"><Textarea data-testid="input-appearance" rows={3} value={appearance} onChange={(e) => setAppearance(e.target.value)} /></Field>
          <Field label="Background"><Textarea data-testid="input-background" rows={5} value={background} onChange={(e) => setBackground(e.target.value)} /></Field>
        </CardContent>
      </Card>

      <PairsCard title="ATTRIBUTES" pairs={attributes} setPairs={setAttributes} placeholder="INT, REF, etc." testid="attr" />
      <PairsCard title="SKILLS" pairs={skills} setPairs={setSkills} placeholder="Handgun, Stealth..." testid="skill" />

      <Card className="rounded-none border-border bg-card/50">
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="font-display tracking-widest">
            CYBERWARE <span className={overSlots ? "text-destructive" : "text-nc-cyan"}>({cyberware.length}/11)</span>
            <span className={`ml-4 ${overCap ? "text-destructive" : "text-nc-yellow"}`}>HUM PTS: {pointsSpent}/6</span>
          </CardTitle>
          <Button type="button" onClick={addCW} disabled={cyberware.length >= 11} className="rounded-none bg-nc-cyan text-background hover:bg-nc-cyan/80 font-display" data-testid="button-add-cyberware">
            <Plus className="w-4 h-4 mr-1" /> ADD
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          {cyberware.length === 0 && <p className="text-muted-foreground font-mono text-sm">No cyberware installed.</p>}
          {cyberware.map((cw, i) => (
            <div key={i} className="grid grid-cols-12 gap-2 items-end border border-border/50 p-3" data-testid={`row-cyberware-${i}`}>
              <div className="col-span-3"><Label className="text-xs font-mono">SLOT</Label>
                <select className="w-full h-9 bg-background border border-border px-2 text-sm font-mono" value={cw.slot} onChange={(e) => setCyberware(cyberware.map((c, j) => j === i ? { ...c, slot: e.target.value } : c))}>
                  {SLOTS.map((s) => <option key={s}>{s}</option>)}
                </select>
              </div>
              <div className="col-span-4"><Label className="text-xs font-mono">NAME</Label><Input value={cw.name} onChange={(e) => setCyberware(cyberware.map((c, j) => j === i ? { ...c, name: e.target.value } : c))} /></div>
              <div className="col-span-1"><Label className="text-xs font-mono">PTS</Label><Input type="number" min={0} value={cw.points} onChange={(e) => setCyberware(cyberware.map((c, j) => j === i ? { ...c, points: Number(e.target.value) } : c))} /></div>
              <div className="col-span-1"><Label className="text-xs font-mono">HL</Label><Input type="number" min={0} value={cw.humanityLoss} onChange={(e) => setCyberware(cyberware.map((c, j) => j === i ? { ...c, humanityLoss: Number(e.target.value) } : c))} /></div>
              <div className="col-span-2"><Label className="text-xs font-mono">NOTES</Label><Input value={cw.notes} onChange={(e) => setCyberware(cyberware.map((c, j) => j === i ? { ...c, notes: e.target.value } : c))} /></div>
              <Button type="button" variant="ghost" size="icon" onClick={() => setCyberware(cyberware.filter((_, j) => j !== i))} className="text-destructive" data-testid={`button-remove-cyberware-${i}`}><Trash2 className="w-4 h-4" /></Button>
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

      <div className="flex gap-3 justify-end">
        <Button type="button" variant="outline" onClick={() => setLocation("/sheets")} className="rounded-none font-display">CANCEL</Button>
        <Button type="submit" disabled={submit.isPending || overCap || overSlots} className="rounded-none bg-nc-cyan text-background hover:bg-nc-cyan/80 font-display tracking-widest" data-testid="button-submit-sheet">
          {submit.isPending ? "TRANSMITTING..." : "SUBMIT FOR REVIEW"}
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
