import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListMissions,
  useCreateMission,
  getListMissionsQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Briefcase } from "lucide-react";
import CharacterPicker, { type CharacterPickerValue } from "@/components/CharacterPicker";

const STATUSES = ["planned", "completed", "failed", "cancelled"] as const;

export default function FixerMissions() {
  const qc = useQueryClient();
  const { data: missions, isLoading } = useListMissions();
  const create = useCreateMission({
    mutation: { onSuccess: () => qc.invalidateQueries({ queryKey: getListMissionsQueryKey() }) },
  });
  const [title, setTitle] = useState("");
  const [character, setCharacter] = useState<CharacterPickerValue>(null);
  const [payout, setPayout] = useState(0);
  const [summary, setSummary] = useState("");
  const [status, setStatus] = useState<(typeof STATUSES)[number]>("completed");
  const [pay, setPay] = useState(true);

  const errMsg =
    (create.error as { response?: { data?: { error?: string } } } | null)?.response?.data?.error ??
    (create.error ? "Create failed" : null);

  return (
    <div className="max-w-6xl mx-auto space-y-6 pb-12">
      <h1 className="text-4xl font-display flex items-center gap-3" data-testid="text-missions-title">
        <Briefcase className="w-7 h-7 text-nc-magenta" /> MISSION LOG
      </h1>

      <Card className="rounded-none border-border bg-card/50">
        <CardHeader>
          <CardTitle className="font-display tracking-widest">NEW MISSION</CardTitle>
        </CardHeader>
        <CardContent>
          <form
            className="grid grid-cols-1 md:grid-cols-12 gap-3 font-mono text-sm"
            onSubmit={(e) => {
              e.preventDefault();
              if (!title.trim()) return;
              create.mutate(
                {
                  data: {
                    title: title.trim(),
                    characterId: character?.id ?? undefined,
                    summary: summary || undefined,
                    payoutEddies: payout,
                    status,
                    pay: pay && payout > 0,
                  },
                },
                {
                  onSuccess: () => {
                    setTitle("");
                    setSummary("");
                    setPayout(0);
                    setCharacter(null);
                  },
                },
              );
            }}
          >
            <div className="md:col-span-5">
              <Label className="text-xs">TITLE</Label>
              <Input value={title} onChange={(e) => setTitle(e.target.value)} required data-testid="input-mission-title" />
            </div>
            <div className="md:col-span-3">
              <Label className="text-xs">CHARACTER</Label>
              <CharacterPicker value={character} onChange={setCharacter} testId="input-mission-char" />
            </div>
            <div className="md:col-span-2">
              <Label className="text-xs">PAYOUT €$</Label>
              <Input type="number" min={0} value={payout || ""} onChange={(e) => setPayout(Number(e.target.value))} data-testid="input-mission-payout" />
            </div>
            <div className="md:col-span-2">
              <Label className="text-xs">STATUS</Label>
              <select
                value={status}
                onChange={(e) => setStatus(e.target.value as (typeof STATUSES)[number])}
                className="w-full h-10 bg-background border border-border px-2 font-mono text-sm"
                data-testid="select-mission-status"
              >
                {STATUSES.map((s) => (
                  <option key={s} value={s}>{s.toUpperCase()}</option>
                ))}
              </select>
            </div>
            <div className="md:col-span-12">
              <Label className="text-xs">SUMMARY</Label>
              <Textarea value={summary} onChange={(e) => setSummary(e.target.value)} rows={2} data-testid="input-mission-summary" />
            </div>
            <div className="md:col-span-8 flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                id="pay-toggle"
                checked={pay}
                onChange={(e) => setPay(e.target.checked)}
                data-testid="checkbox-mission-pay"
              />
              <label htmlFor="pay-toggle" className="text-muted-foreground">
                Auto-pay character via UnbelievaBoat (debits your fixer wallet)
              </label>
            </div>
            <div className="md:col-span-4 flex items-end">
              <Button
                type="submit"
                disabled={create.isPending || !title.trim()}
                className="w-full rounded-none bg-nc-magenta text-background hover:bg-nc-magenta/80 font-display"
                data-testid="button-create-mission"
              >
                {create.isPending ? "LOGGING..." : "LOG MISSION"}
              </Button>
            </div>
            {errMsg && (
              <div className="md:col-span-12 text-destructive text-xs" data-testid="text-mission-error">{errMsg}</div>
            )}
          </form>
        </CardContent>
      </Card>

      <Card className="rounded-none border-border bg-card/50">
        <CardHeader>
          <CardTitle className="font-display tracking-widest">RECENT MISSIONS</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="font-mono text-nc-cyan animate-pulse">Loading mission log...</div>
          ) : !missions || missions.length === 0 ? (
            <p className="font-mono text-muted-foreground italic">No missions logged.</p>
          ) : (
            <table className="w-full font-mono text-sm">
              <thead className="border-b border-border bg-card">
                <tr className="text-nc-cyan uppercase text-xs tracking-widest">
                  <th className="text-left p-2">When</th>
                  <th className="text-left p-2">Title</th>
                  <th className="text-left p-2">Character</th>
                  <th className="text-left p-2">Fixer</th>
                  <th className="text-right p-2">Payout</th>
                  <th className="text-left p-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {missions.map((m) => (
                  <tr key={m.id} className="border-b border-border/30 hover:bg-card/80" data-testid={`row-mission-${m.id}`}>
                    <td className="p-2 text-muted-foreground text-xs">{new Date(m.createdAt).toLocaleDateString()}</td>
                    <td className="p-2 text-foreground">
                      <div>{m.title}</div>
                      {m.summary && <div className="text-xs text-muted-foreground">{m.summary}</div>}
                    </td>
                    <td className="p-2">{m.characterName ?? <span className="text-muted-foreground">—</span>}</td>
                    <td className="p-2 text-nc-magenta">{m.fixerName ?? "—"}</td>
                    <td className="p-2 text-right text-nc-yellow">
                      {m.payoutEddies ? `€$${m.payoutEddies.toLocaleString()}` : "—"}
                    </td>
                    <td className="p-2">
                      <Badge
                        variant="outline"
                        className={`rounded-none text-[10px] px-1 py-0 ${
                          m.status === "completed"
                            ? "border-nc-cyan text-nc-cyan"
                            : m.status === "failed"
                              ? "border-destructive text-destructive"
                              : m.status === "cancelled"
                                ? "border-muted-foreground text-muted-foreground"
                                : "border-nc-yellow text-nc-yellow"
                        }`}
                      >
                        {m.status.toUpperCase()}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
