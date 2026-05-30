import { useParams, useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetSheet,
  useDecideSheet,
  useListCyberware,
  getGetSheetQueryKey,
  getListPendingSheetsQueryKey,
} from "@workspace/api-client-react";
import { useAuthMe } from "@/hooks/useAuthMe";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import Markdown from "@/components/Markdown";
import { useMemo, useState } from "react";

export default function SheetDetail() {
  const { id } = useParams<{ id: string }>();
  const sheetId = Number(id);
  const [, setLocation] = useLocation();
  const qc = useQueryClient();
  const { data: sheet, isLoading } = useGetSheet(sheetId);
  const { data: me } = useAuthMe();
  const { data: catalog } = useListCyberware();
  const [note, setNote] = useState("");

  // Mirror the server's catalog-authoritative CWP resolution
  // (loadCyberwareCostMap / entryPoints in api-server sheets.ts): cost is keyed
  // by normalized name and where multiple catalog rows share a name the highest
  // CWP wins, so the reviewer sees exactly what the cap was enforced against.
  const cwpCostMap = useMemo(() => {
    const map = new Map<string, number>();
    (catalog ?? []).forEach((c) => {
      const key = String(c.name ?? "").trim().toLowerCase();
      if (!key) return;
      const cost = Number(c.cwp) || 0;
      const prev = map.get(key);
      if (prev === undefined || cost > prev) map.set(key, cost);
    });
    return map;
  }, [catalog]);
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

  // While a sheet is in review, both the owner and staff (reviewers) may edit
  // any part of it before it's approved.
  const isOwner = (me as any)?.id != null && (sheet as any).ownerId === (me as any).id;
  const isStaff = !!(me?.isCsApprover || me?.isAdmin || me?.isFixer);
  const canEdit = sheet.status === "pending" && (isOwner || isStaff);

  const data = sheet.data as unknown as Record<string, unknown>;
  const legacyCw = [
    ...((data.cyberwareBySlot as Array<{ slot: string; name: string; points: number }>) ?? []),
    ...((data.cyberwareMisc as Array<{ slot: string; name: string; points: number }>) ?? []),
  ];
  const cwRaw = (data.cyberware as Array<{ slot: string; name: string; points: number }>) ?? [];
  const cwBase = (cwRaw.length > 0 ? cwRaw : legacyCw).filter((c) => c?.name && String(c.name).trim().length > 0);
  // Resolve each entry against the catalog the same way the server did. Catalog
  // matches show the authoritative CWP (and flag a disagreement with the stored
  // value); custom entries keep their stored value.
  const cw = cwBase.map((c) => {
    const stored = Number(c.points) || 0;
    const catalogCost = cwpCostMap.get(String(c.name ?? "").trim().toLowerCase());
    const isCatalog = catalogCost !== undefined;
    const effective = isCatalog ? catalogCost : stored;
    return { ...c, stored, effective, isCatalog, mismatch: isCatalog && catalogCost !== stored };
  });
  const totalCwp = cw.reduce((s, c) => s + c.effective, 0);
  const skills = typeof data.skills === "string"
    ? data.skills
    : data.skills && typeof data.skills === "object"
    ? Object.entries(data.skills as Record<string, unknown>).map(([k, v]) => (v != null && v !== "" ? `${k} ${v}` : k)).join("\n")
    : "";
  const gear = (data.gear as string[]) ?? [];
  const occupation = String(data.occupation ?? "");
  const background = String(data.background ?? "");
  const physicalDescription = String(data.physicalDescription ?? "");
  const appearance = String(data.appearance ?? "");
  const psychProfile = String(data.psychProfile ?? "");

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
        {canEdit && (
          <Button
            onClick={() => setLocation(`/sheets/${sheetId}/edit`)}
            className="rounded-none bg-nc-cyan text-background hover:bg-nc-cyan/80 font-display"
            data-testid="button-edit-sheet"
          >
            EDIT
          </Button>
        )}
      </div>

      <Card className="rounded-none border-border bg-card/50">
        <CardHeader><CardTitle className="font-display tracking-widest">PROFILE</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-2 gap-3 text-sm font-mono">
          {["fullName", "nickname", "archetype", "age", "gender"].map((k) => (
            <div key={k} className="break-words [overflow-wrap:anywhere]"><span className="text-muted-foreground uppercase tracking-widest">{k}: </span>{String(data[k] ?? "—")}</div>
          ))}
        </CardContent>
      </Card>

      <Card className="rounded-none border-border bg-card/50">
        <CardHeader><CardTitle className="font-display tracking-widest">OCCUPATION / ROLE</CardTitle></CardHeader>
        <CardContent>
          {occupation.trim()
            ? <Markdown className="font-mono text-sm text-foreground/90 leading-relaxed">{occupation}</Markdown>
            : <span className="font-mono text-sm text-muted-foreground">—</span>}
        </CardContent>
      </Card>

      <Card className="rounded-none border-border bg-card/50">
        <CardHeader><CardTitle className="font-display tracking-widest">PHYSICAL DESCRIPTION</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div>
            <p className="text-xs font-mono uppercase tracking-widest text-muted-foreground mb-1">Build, Height, Distinguishing Features</p>
            {physicalDescription.trim()
              ? <Markdown className="font-mono text-sm text-foreground/90 leading-relaxed">{physicalDescription}</Markdown>
              : <span className="font-mono text-sm text-muted-foreground">—</span>}
          </div>
          <div>
            <p className="text-xs font-mono uppercase tracking-widest text-muted-foreground mb-1">Style</p>
            {appearance.trim()
              ? <Markdown className="font-mono text-sm text-foreground/90 leading-relaxed">{appearance}</Markdown>
              : <span className="font-mono text-sm text-muted-foreground">—</span>}
          </div>
        </CardContent>
      </Card>

      <Card className="rounded-none border-border bg-card/50">
        <CardHeader><CardTitle className="font-display tracking-widest">PSYCHOLOGICAL PROFILE</CardTitle></CardHeader>
        <CardContent>
          {psychProfile.trim()
            ? <Markdown className="font-mono text-sm text-foreground/90 leading-relaxed">{psychProfile}</Markdown>
            : <span className="font-mono text-sm text-muted-foreground">—</span>}
        </CardContent>
      </Card>

      <Card className="rounded-none border-border bg-card/50">
        <CardHeader><CardTitle className="font-display tracking-widest">BACKGROUND</CardTitle></CardHeader>
        <CardContent>
          {background.trim()
            ? <Markdown className="font-mono text-sm text-foreground/90 leading-relaxed">{background}</Markdown>
            : <span className="font-mono text-sm text-muted-foreground">—</span>}
        </CardContent>
      </Card>

      <Card className="rounded-none border-border bg-card/50">
        <CardHeader><CardTitle className="font-display tracking-widest">SKILLS</CardTitle></CardHeader>
        <CardContent>
          {skills.trim()
            ? <Markdown className="font-mono text-sm text-foreground/90 leading-relaxed">{skills}</Markdown>
            : <span className="font-mono text-sm text-muted-foreground">—</span>}
        </CardContent>
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
            CYBERWARE ({cw.length}) · CWP:{" "}
            <span className={totalCwp > 6 ? "text-destructive" : "text-nc-yellow"} data-testid="text-total-cwp">
              {totalCwp}
            </span>
            /6
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-1">
          {cw.length === 0 ? <p className="text-muted-foreground font-mono text-sm">None — fully organic.</p> :
            cw.map((c, i) => (
              <div key={i} className="grid grid-cols-4 gap-2 border-b border-border/30 py-1 text-sm font-mono" data-testid={`row-cyberware-${i}`}>
                <span className="text-nc-cyan">{c.slot}</span>
                <span className="col-span-2">
                  {c.name}
                  {!c.isCatalog && <span className="ml-2 text-[10px] uppercase tracking-widest text-muted-foreground">custom</span>}
                </span>
                <span className="text-nc-yellow" data-testid={`text-cwp-${i}`}>
                  CWP {c.effective}
                  {c.mismatch && (
                    <span className="ml-2 text-[10px] text-destructive" title={`Sheet stored CWP ${c.stored}; catalog says ${c.effective}`} data-testid={`badge-cwp-mismatch-${i}`}>
                      (sheet said {c.stored})
                    </span>
                  )}
                </span>
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
          <CardContent className="font-mono text-sm whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{sheet.decisionNote}</CardContent>
        </Card>
      )}
    </div>
  );
}
