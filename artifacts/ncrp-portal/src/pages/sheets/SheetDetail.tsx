import { useParams, useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetSheet,
  useVoteSheet,
  useOverrideSheet,
  useSubmitDraftSheet,
  useListCyberware,
  getGetSheetQueryKey,
  getListPendingSheetsQueryKey,
  getGetDashboardSummaryQueryKey,
  getGetReviewUnseenCountsQueryKey,
} from "@workspace/api-client-react";
import { useEffectiveMe } from "@/contexts/ViewAsContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { Check, X, ShieldCheck, RotateCcw } from "lucide-react";
import Markdown from "@/components/Markdown";
import ReviewCommentThread, { AwaitingVoteBanner } from "@/components/ReviewCommentThread";
import DiscordThreadPanel from "@/components/DiscordThreadPanel";
import { ReviewerRoster } from "@/components/review/ReviewerRoster";
import { useMemo, useState } from "react";

function sheetStatusBadge(status: string) {
  const map: Record<string, string> = {
    pending: "border-nc-yellow text-nc-yellow",
    approved: "border-nc-green text-nc-green",
    rejected: "border-destructive text-destructive",
    changes_requested: "border-nc-magenta text-nc-magenta",
    draft: "border-muted-foreground text-muted-foreground",
  };
  return (
    <Badge variant="outline" className={`rounded-none uppercase ${map[status] ?? "border-nc-cyan text-nc-cyan"}`} data-testid="badge-status">
      {status.replace("_", " ")}
    </Badge>
  );
}

export default function SheetDetail() {
  const { id } = useParams<{ id: string }>();
  const sheetId = Number(id);
  const [, setLocation] = useLocation();
  const qc = useQueryClient();
  const { data: sheet, isLoading } = useGetSheet(sheetId);
  const { data: me } = useEffectiveMe();
  const { data: catalog } = useListCyberware();
  const { toast } = useToast();
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
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: getGetSheetQueryKey(sheetId) });
    qc.invalidateQueries({ queryKey: getListPendingSheetsQueryKey() });
    // The dashboard "Pending Sheets" card counts pending sheets the viewer
    // hasn't voted on (server-side NOT EXISTS against review_votes), and the
    // sidebar sheet badge comes from the review unseen-counts — both go stale
    // after a vote/override/resubmit unless we refetch them here.
    qc.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
    qc.invalidateQueries({ queryKey: getGetReviewUnseenCountsQueryKey() });
  };
  const errMsg = (err: unknown, fallback: string) =>
    (err as { response?: { data?: { error?: string } } } | null)?.response?.data?.error ?? fallback;

  const vote = useVoteSheet({
    mutation: {
      onSuccess: () => { setNote(""); invalidate(); },
      onError: (err) => toast({ title: "Vote failed", description: errMsg(err, "Vote failed"), variant: "destructive" }),
    },
  });
  const override = useOverrideSheet({
    mutation: {
      onSuccess: () => { toast({ title: "Sheet approved via override" }); invalidate(); },
      onError: (err) => toast({ title: "Override failed", description: errMsg(err, "Override failed"), variant: "destructive" }),
    },
  });
  const resubmit = useSubmitDraftSheet({
    mutation: {
      onSuccess: () => { toast({ title: "Resubmitted for review" }); invalidate(); },
      onError: (err) => toast({ title: "Resubmit failed", description: errMsg(err, "Resubmit failed"), variant: "destructive" }),
    },
  });

  if (isLoading) return <div className="font-display text-nc-cyan animate-pulse">LOADING SHEET...</div>;
  if (!sheet) return <div className="font-display text-destructive">SHEET NOT FOUND</div>;

  // While a sheet is in review, both the owner and staff (reviewers) may edit
  // any part of it before it's approved.
  const isOwner = (me as any)?.id != null && (sheet as any).ownerId === (me as any).id;
  const isStaff = !!(me?.isCsApprover || me?.isAdmin || me?.isFixer);
  const canEdit = ((sheet.status === "pending" && (isOwner || isStaff)) || (sheet.status === "changes_requested" && isOwner));

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
  const guns = (data.guns as string[]) ?? [];
  const occupation = String(data.occupation ?? "");
  const background = String(data.background ?? "");
  const hooks = String(data.hooks ?? "");
  const physicalDescription = String(data.physicalDescription ?? "");
  const appearance = String(data.appearance ?? "");
  const psychProfile = String(data.psychProfile ?? "");

  // Images submitted with the sheet so the reviewer can actually see the
  // character. Portraits combine the gallery (portraitUrls) with the single
  // profile image; stat screenshots are shown separately. De-duped so the same
  // URL isn't rendered twice.
  const portraitImages = Array.from(
    new Set(
      [
        ...(Array.isArray(data.portraitUrls) ? (data.portraitUrls as unknown[]).map(String) : []),
        ...(typeof data.profileUrl === "string" ? [data.profileUrl] : []),
      ].filter((u) => u && u.trim()),
    ),
  );
  const statsImages = Array.from(
    new Set(
      (Array.isArray(data.statsImageUrls) ? (data.statsImageUrls as unknown[]).map(String) : []).filter(
        (u) => u && u.trim(),
      ),
    ),
  );

  return (
    <div className="max-w-7xl mx-auto space-y-6 pb-12">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-4xl font-display text-foreground" data-testid="text-sheet-name">{sheet.name}</h1>
          <p className="font-mono text-xs text-muted-foreground mt-1">
            Submitted {new Date(sheet.createdAt).toLocaleString()}
            {sheet.ownerName ? <> by <span className="text-foreground">{sheet.ownerName}</span></> : null} · Status:{" "}
            {sheetStatusBadge(sheet.status)}
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

      <AwaitingVoteBanner show={!!sheet.canVote && !sheet.myVote} />

      {isStaff && sheet.eligibleReviewers && sheet.eligibleReviewers.length > 0 && (
        <Card className="rounded-none border-border bg-card/30">
          <CardHeader className="pb-2">
            <CardTitle className="font-display text-sm tracking-widest text-nc-cyan">REVIEW STATUS</CardTitle>
          </CardHeader>
          <CardContent className="font-mono text-sm space-y-1">
            <div>
              <span className="text-nc-green">{sheet.approveCount ?? 0}</span> approve ·{" "}
              <span className="text-destructive">{sheet.rejectCount ?? 0}</span> reject ·{" "}
              threshold <span className="text-nc-cyan">{sheet.threshold ?? "?"}</span> of{" "}
              {sheet.eligibleVoterCount ?? sheet.eligibleReviewers.length} eligible reviewers
            </div>
            <ReviewerRoster
              className="pt-3 border-t border-border/40"
              eligibleReviewers={sheet.eligibleReviewers}
              voters={(sheet.votes ?? []).map((v) => ({ id: v.voterId, vote: v.vote }))}
            />
          </CardContent>
        </Card>
      )}

      <Card className="rounded-none border-border bg-card/50">
        <CardHeader><CardTitle className="font-display tracking-widest">PROFILE</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-2 gap-3 text-sm font-mono">
          {["fullName", "nickname", "archetype", "age", "gender"].map((k) => (
            <div key={k} className="break-words [overflow-wrap:anywhere]"><span className="text-muted-foreground uppercase tracking-widest">{k}: </span>{String(data[k] ?? "—")}</div>
          ))}
        </CardContent>
      </Card>

      {(portraitImages.length > 0 || statsImages.length > 0) && (
        <Card className="rounded-none border-border bg-card/50">
          <CardHeader><CardTitle className="font-display tracking-widest">SUBMITTED IMAGES</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            {portraitImages.length > 0 && (
              <div>
                <p className="text-xs font-mono uppercase tracking-widest text-muted-foreground mb-2">Portraits</p>
                <div className="flex flex-wrap gap-3">
                  {portraitImages.map((url, i) => (
                    <a key={url} href={url} target="_blank" rel="noopener noreferrer" data-testid={`link-sheet-portrait-${i}`}>
                      <img
                        src={url}
                        alt={`Portrait ${i + 1}`}
                        loading="lazy"
                        className="h-40 w-40 object-contain border border-border hover:border-nc-cyan transition-colors"
                        data-testid={`img-sheet-portrait-${i}`}
                      />
                    </a>
                  ))}
                </div>
              </div>
            )}
            {statsImages.length > 0 && (
              <div>
                <p className="text-xs font-mono uppercase tracking-widest text-muted-foreground mb-2">Stat Screenshots</p>
                <div className="flex flex-wrap gap-3">
                  {statsImages.map((url, i) => (
                    <a key={url} href={url} target="_blank" rel="noopener noreferrer" data-testid={`link-sheet-stats-${i}`}>
                      <img
                        src={url}
                        alt={`Stats ${i + 1}`}
                        loading="lazy"
                        className="max-h-80 w-auto object-contain border border-border hover:border-nc-cyan transition-colors"
                        data-testid={`img-sheet-stats-${i}`}
                      />
                    </a>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

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
        <CardHeader><CardTitle className="font-display tracking-widest">HOOKS</CardTitle></CardHeader>
        <CardContent>
          {hooks.trim()
            ? <Markdown className="font-mono text-sm text-foreground/90 leading-relaxed">{hooks}</Markdown>
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
              {gear.filter((g) => g && g.trim()).map((g, i) => <li key={i} className="break-words [overflow-wrap:anywhere]">{g}</li>)}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card className="rounded-none border-border bg-card/50">
        <CardHeader><CardTitle className="font-display tracking-widest">FIREARMS</CardTitle></CardHeader>
        <CardContent className="font-mono text-sm">
          {guns.filter((g) => g && g.trim()).length === 0 ? (
            <p className="text-muted-foreground">—</p>
          ) : (
            <ul className="list-disc list-inside space-y-1">
              {guns.filter((g) => g && g.trim()).map((g, i) => <li key={i} className="break-words [overflow-wrap:anywhere]">{g}</li>)}
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
                <span className="text-nc-cyan break-words [overflow-wrap:anywhere]">{c.slot}</span>
                <span className="col-span-2 break-words [overflow-wrap:anywhere]">
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

      {/* Vote tally — visible to reviewers and the owner while in review */}
      {(sheet.status === "pending" || sheet.status === "changes_requested") && (isStaff || isOwner) && (
        <Card className="rounded-none border-border bg-card/30">
          <CardHeader className="pb-2"><CardTitle className="font-display text-sm tracking-widest text-nc-cyan">VOTE TALLY</CardTitle></CardHeader>
          <CardContent className="font-mono text-sm">
            <span className="text-nc-green">{sheet.approveCount}</span> approve ·{" "}
            <span className="text-destructive">{sheet.rejectCount}</span> reject ·{" "}
            threshold <span className="text-nc-cyan">{sheet.threshold}</span> of {sheet.eligibleVoterCount} eligible reviewers
          </CardContent>
        </Card>
      )}

      {/* Self-review notice */}
      {isStaff && sheet.status === "pending" && isOwner && (
        <Card className="rounded-none border-border bg-card/50">
          <CardContent className="font-mono text-sm text-muted-foreground py-4" data-testid="text-self-review-blocked">
            You submitted this sheet, so another reviewer must approve it.
          </CardContent>
        </Card>
      )}

      {/* Reviewer vote panel */}
      {sheet.canVote && (
        <Card className="rounded-none border-nc-yellow bg-card/50">
          <CardHeader><CardTitle className="font-display tracking-widest text-nc-yellow">YOUR VOTE</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            {sheet.myVote && (
              <div className="font-mono text-xs text-muted-foreground">
                Current vote: <span className={sheet.myVote.vote === "approve" ? "text-nc-green" : "text-destructive"}>{sheet.myVote.vote.toUpperCase()}</span>
                {sheet.myVote.note ? <span className="italic"> — "{sheet.myVote.note}"</span> : null}
              </div>
            )}
            <Textarea placeholder="Optional note for the player..." value={note} onChange={(e) => setNote(e.target.value)} data-testid="input-decision-note" />
            <div className="flex gap-2">
              <Button onClick={() => vote.mutate({ id: sheetId, data: { vote: "approve", note: note || undefined } })} disabled={vote.isPending} className="rounded-none bg-nc-green text-background hover:bg-nc-green/80 font-display" data-testid="button-approve"><Check className="w-4 h-4 mr-1" /> APPROVE</Button>
              <Button onClick={() => vote.mutate({ id: sheetId, data: { vote: "reject", note: note || undefined } })} disabled={vote.isPending} variant="destructive" className="rounded-none font-display" data-testid="button-reject"><X className="w-4 h-4 mr-1" /> REJECT</Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Read-only mirror of the cs-approver Discord thread. Staff only. */}
      {isStaff && <DiscordThreadPanel subjectType="sheet" subjectId={sheetId} />}

      {/* Two-way discussion thread (player <-> reviewers). Never blocks approval. */}
      {(isStaff || isOwner) && (
        <ReviewCommentThread subjectType="sheet" subjectId={sheetId} markSeenOnMount={isStaff} />
      )}

      {/* Admin override */}
      {sheet.canOverride && (
        <div className="border-t border-border pt-4">
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => override.mutate({ id: sheetId, data: { decision: "approve" } })} disabled={override.isPending} className="rounded-none bg-nc-yellow text-background hover:bg-nc-yellow/80 font-display" data-testid="button-override"><ShieldCheck className="w-4 h-4 mr-1" /> ADMIN OVERRIDE — APPROVE NOW</Button>
            <Button onClick={() => override.mutate({ id: sheetId, data: { decision: "deny" } })} disabled={override.isPending} variant="outline" className="rounded-none border-destructive text-destructive hover:bg-destructive/10 font-display" data-testid="button-override-deny"><X className="w-4 h-4 mr-1" /> ADMIN OVERRIDE — DENY NOW</Button>
          </div>
          <p className="font-mono text-xs text-muted-foreground mt-1">Bypasses the majority vote and resolves immediately. Records you as the override decider.</p>
        </div>
      )}

      {/* Owner resubmit after changes requested */}
      {sheet.canResubmit && (
        <div className="border-t border-border pt-4">
          <Button onClick={() => resubmit.mutate({ id: sheetId })} disabled={resubmit.isPending} className="rounded-none bg-nc-cyan text-background hover:bg-nc-cyan/80 font-display" data-testid="button-resubmit"><RotateCcw className="w-4 h-4 mr-1" /> RESUBMIT FOR REVIEW</Button>
          <p className="font-mono text-xs text-muted-foreground mt-1">Edit your sheet first if needed, then resubmit. This clears prior votes and returns it to the queue.</p>
        </div>
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
