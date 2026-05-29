import { useParams } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetSheet,
  useDecideSheet,
  getGetSheetQueryKey,
  getListPendingSheetsQueryKey,
} from "@workspace/api-client-react";
import { useAuthMe } from "@/hooks/useAuthMe";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { useState } from "react";

export default function SheetDetail() {
  const { id } = useParams<{ id: string }>();
  const sheetId = Number(id);
  const qc = useQueryClient();
  const { data: sheet, isLoading } = useGetSheet(sheetId);
  const { data: me } = useAuthMe();
  const [note, setNote] = useState("");
  const decide = useDecideSheet({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getGetSheetQueryKey(sheetId) });
        qc.invalidateQueries({ queryKey: getListPendingSheetsQueryKey() });
      },
    },
  });

  if (isLoading) return <div className="font-display text-nc-cyan animate-pulse">LOADING SHEET...</div>;
  if (!sheet) return <div className="font-display text-destructive">SHEET NOT FOUND</div>;

  const data = sheet.data as unknown as Record<string, unknown>;
  const legacyCw = [
    ...((data.cyberwareBySlot as Array<{ slot: string; name: string; points: number }>) ?? []),
    ...((data.cyberwareMisc as Array<{ slot: string; name: string; points: number }>) ?? []),
  ];
  const cwRaw = (data.cyberware as Array<{ slot: string; name: string; points: number }>) ?? [];
  const cw = (cwRaw.length > 0 ? cwRaw : legacyCw).filter((c) => c?.name && String(c.name).trim().length > 0);
  const skills = typeof data.skills === "string"
    ? data.skills
    : data.skills && typeof data.skills === "object"
    ? Object.entries(data.skills as Record<string, unknown>).map(([k, v]) => (v != null && v !== "" ? `${k} ${v}` : k)).join("\n")
    : "";
  const gear = (data.gear as string[]) ?? [];

  return (
    <div className="max-w-4xl mx-auto space-y-6 pb-12">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-4xl font-display text-foreground" data-testid="text-sheet-name">{sheet.name}</h1>
          <p className="font-mono text-xs text-muted-foreground mt-1">
            Submitted {new Date(sheet.createdAt).toLocaleString()} · Status:{" "}
            <Badge variant="outline" className="rounded-none border-nc-cyan text-nc-cyan uppercase" data-testid="badge-status">
              {sheet.status}
            </Badge>
          </p>
        </div>
      </div>

      <Card className="rounded-none border-border bg-card/50">
        <CardHeader><CardTitle className="font-display tracking-widest">PROFILE</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-2 gap-3 text-sm font-mono">
          {["fullName", "nickname", "archetype", "age", "gender", "occupation"].map((k) => (
            <div key={k}><span className="text-muted-foreground uppercase tracking-widest">{k}: </span>{String(data[k] ?? "—")}</div>
          ))}
        </CardContent>
      </Card>

      <Card className="rounded-none border-border bg-card/50">
        <CardHeader><CardTitle className="font-display tracking-widest">BACKGROUND</CardTitle></CardHeader>
        <CardContent className="whitespace-pre-wrap font-mono text-sm">{String(data.background ?? "—")}</CardContent>
      </Card>

      <Card className="rounded-none border-border bg-card/50">
        <CardHeader><CardTitle className="font-display tracking-widest">SKILLS</CardTitle></CardHeader>
        <CardContent className="whitespace-pre-wrap font-mono text-sm">{skills || "—"}</CardContent>
      </Card>

      <Card className="rounded-none border-border bg-card/50">
        <CardHeader><CardTitle className="font-display tracking-widest">GEAR</CardTitle></CardHeader>
        <CardContent className="font-mono text-sm">
          {gear.filter((g) => g && g.trim()).length === 0 ? (
            <p className="text-muted-foreground">—</p>
          ) : (
            <ul className="list-disc list-inside space-y-1">
              {gear.filter((g) => g && g.trim()).map((g, i) => <li key={i}>{g}</li>)}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card className="rounded-none border-border bg-card/50">
        <CardHeader>
          <CardTitle className="font-display tracking-widest">
            CYBERWARE ({cw.length}) · CWP: {data.cyberwarePointsSpent as number ?? cw.reduce((s, c) => s + (Number(c.points) || 0), 0)}/6
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-1">
          {cw.length === 0 ? <p className="text-muted-foreground font-mono text-sm">None — fully organic.</p> :
            cw.map((c, i) => (
              <div key={i} className="grid grid-cols-4 gap-2 border-b border-border/30 py-1 text-sm font-mono">
                <span className="text-nc-cyan">{c.slot}</span>
                <span className="col-span-2">{c.name}</span>
                <span className="text-nc-yellow">CWP {c.points}</span>
              </div>
            ))}
        </CardContent>
      </Card>

      {me?.isCsApprover && sheet.status === "pending" && (
        <Card className="rounded-none border-nc-yellow bg-card/50">
          <CardHeader><CardTitle className="font-display tracking-widest text-nc-yellow">APPROVAL DECISION</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <Textarea placeholder="Optional note for the player..." value={note} onChange={(e) => setNote(e.target.value)} data-testid="input-decision-note" />
            <div className="flex gap-2">
              <Button onClick={() => decide.mutate({ id: sheetId, data: { decision: "approved", note } })} disabled={decide.isPending} className="rounded-none bg-nc-cyan text-background hover:bg-nc-cyan/80 font-display" data-testid="button-approve">APPROVE</Button>
              <Button onClick={() => decide.mutate({ id: sheetId, data: { decision: "changes_requested", note } })} disabled={decide.isPending} variant="outline" className="rounded-none border-nc-yellow text-nc-yellow font-display" data-testid="button-request-changes">REQUEST CHANGES</Button>
              <Button onClick={() => decide.mutate({ id: sheetId, data: { decision: "rejected", note } })} disabled={decide.isPending} variant="destructive" className="rounded-none font-display" data-testid="button-reject">REJECT</Button>
            </div>
          </CardContent>
        </Card>
      )}

      {sheet.decisionNote && (
        <Card className="rounded-none border-border bg-card/50">
          <CardHeader><CardTitle className="font-display tracking-widest">APPROVER NOTE</CardTitle></CardHeader>
          <CardContent className="font-mono text-sm">{sheet.decisionNote}</CardContent>
        </Card>
      )}
    </div>
  );
}
