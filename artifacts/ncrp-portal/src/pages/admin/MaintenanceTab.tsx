import { useAdminMissionThreadBackfill, useAdminEconomyReconcile, useAdminWalletMirrorHealth, useAdminWalletMirrorPush, useAdminRehostEventImages, useAdminGuidebookLinkRepair, useAdminUbBalanceRepair, type MissionThreadBackfillResult, type EconomyReconcileResult, type RehostEventImagesResult, type GuidebookLinkRepairResult, type UbBalanceRepairResult } from "@workspace/api-client-react";
import { formatEddies } from "@/lib/format";
import { useState } from "react";
import { Link } from "wouter";
import { Users } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";

export function MaintenanceTab() {
  const { toast } = useToast();
  const [importResult, setImportResult] = useState<null | {
    inserted: number;
    updated: number;
    skipped: number;
    errors: Array<{ name: string; error: string }>;
  }>(null);
  const [importing, setImporting] = useState(false);
  const [pasted, setPasted] = useState("");

  async function downloadExport() {
    const r = await fetch("/api/admin/maintenance/npc-export", { credentials: "include" });
    if (!r.ok) {
      toast({ title: "Export failed", description: `HTTP ${r.status}`, variant: "destructive" });
      return;
    }
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `ncrp-npcs-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    const json = await fetch(url).catch(() => null);
    toast({ title: "NPC export downloaded", description: `Saved ${a.download}` });
    void json;
  }

  async function runImport(jsonText: string) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch (e) {
      toast({ title: "Invalid JSON", description: (e as Error).message, variant: "destructive" });
      return;
    }
    setImporting(true);
    setImportResult(null);
    try {
      const r = await fetch("/api/admin/maintenance/npc-import", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(parsed),
      });
      const body = await r.json();
      if (!r.ok) {
        toast({ title: "Import failed", description: body.error ?? `HTTP ${r.status}`, variant: "destructive" });
        return;
      }
      setImportResult(body);
      toast({
        title: "NPC import complete",
        description: `${body.inserted} inserted, ${body.updated} updated, ${body.errors?.length ?? 0} errors`,
      });
    } finally {
      setImporting(false);
    }
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    await runImport(text);
    e.target.value = "";
  }

  return (
    <div className="space-y-6">
      <Card className="rounded-none border-border bg-card/50">
        <CardHeader>
          <CardTitle className="font-display tracking-widest">NPC SYNC</CardTitle>
          <CardDescription className="font-mono text-xs">
            Dev → Prod data sync for NPC characters. Production database writes go through this
            running app — export from dev, then deploy and re-import here in prod. Upsert is
            keyed on (kind='npc', name); admin-assigned owners are preserved across runs.
            Portrait URLs continue to resolve because dev and prod share the object-storage bucket.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-2">
            <Label className="font-display tracking-widest text-xs">1 · EXPORT (run in dev)</Label>
            <p className="text-xs font-mono text-muted-foreground">
              Downloads every NPC in this environment as a single JSON file.
            </p>
            <Button
              type="button"
              onClick={downloadExport}
              className="rounded-none bg-nc-cyan text-background hover:bg-nc-cyan/80 font-display tracking-widest"
              data-testid="button-npc-export"
            >
              DOWNLOAD NPC EXPORT
            </Button>
          </div>

          <div className="border-t border-border/50 pt-4 space-y-2">
            <Label className="font-display tracking-widest text-xs">2 · IMPORT (run in prod after deploy)</Label>
            <p className="text-xs font-mono text-muted-foreground">
              Upload the JSON file produced above (or paste it). Safe to run repeatedly.
            </p>
            <div className="flex flex-wrap gap-3 items-center">
              <input
                type="file"
                accept="application/json,.json"
                onChange={onFile}
                disabled={importing}
                className="font-mono text-xs"
                data-testid="input-npc-import-file"
              />
              {importing && <span className="text-xs font-mono text-nc-cyan animate-pulse">IMPORTING...</span>}
            </div>
            <details className="text-xs font-mono text-muted-foreground">
              <summary className="cursor-pointer hover:text-foreground">Or paste JSON directly</summary>
              <textarea
                value={pasted}
                onChange={(e) => setPasted(e.target.value)}
                placeholder='{ "npcs": [...] }'
                className="mt-2 w-full h-32 bg-background border border-border rounded-none p-2 text-xs font-mono"
                data-testid="textarea-npc-import-paste"
              />
              <Button
                type="button"
                size="sm"
                onClick={() => runImport(pasted)}
                disabled={importing || !pasted.trim()}
                className="mt-2 rounded-none bg-nc-cyan text-background hover:bg-nc-cyan/80 font-display tracking-widest"
                data-testid="button-npc-import-paste"
              >
                RUN IMPORT
              </Button>
            </details>
          </div>

          {importResult && (
            <div className="border-t border-border/50 pt-4 space-y-2" data-testid="block-npc-import-result">
              <Label className="font-display tracking-widest text-xs">RESULT</Label>
              <div className="grid grid-cols-3 gap-2 text-center">
                <div className="border border-nc-cyan/40 bg-nc-cyan/5 p-2">
                  <div className="text-2xl font-display text-nc-cyan">{importResult.inserted}</div>
                  <div className="text-xs font-mono text-muted-foreground uppercase">Inserted</div>
                </div>
                <div className="border border-nc-yellow/40 bg-nc-yellow/5 p-2">
                  <div className="text-2xl font-display text-nc-yellow">{importResult.updated}</div>
                  <div className="text-xs font-mono text-muted-foreground uppercase">Updated</div>
                </div>
                <div className="border border-destructive/40 bg-destructive/5 p-2">
                  <div className="text-2xl font-display text-destructive">{importResult.errors.length}</div>
                  <div className="text-xs font-mono text-muted-foreground uppercase">Errors</div>
                </div>
              </div>
              {importResult.errors.length > 0 && (
                <div className="space-y-1 max-h-48 overflow-y-auto">
                  {importResult.errors.map((e, i) => (
                    <div key={i} className="text-xs font-mono text-destructive border border-destructive/30 px-2 py-1">
                      <span className="font-bold">{e.name}:</span> {e.error}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <FullMigrationCard />
      <BotImportCard />
      <MergeAccountCard />
      <DuplicateCleanupCard />
      <ClaimByUsernameCard />
      <PortraitBackfillCard />
      <RipperdocBackfillCard />
      <MissionThreadBackfillCard />
      <WalletMirrorCard />
      <UbBalanceRepairCard />
      <EconomyReconcileCard />
      <RehostEventImagesCard />
      <GuidebookLinkRepairCard />
    </div>
  );
}

function MissionThreadBackfillCard() {
  const { toast } = useToast();
  const [result, setResult] = useState<MissionThreadBackfillResult | null>(null);
  const mutation = useAdminMissionThreadBackfill();

  async function call(dryRun: boolean) {
    try {
      const body = await mutation.mutateAsync({ data: { dryRun } });
      setResult(body);
      if (!dryRun) {
        toast({
          title: "Mission thread backfill complete",
          description: `Scanned ${body.scanned ?? 0}, created ${body.created ?? 0}, seeded ${body.seeded ?? 0}, failed ${body.failed ?? 0}.`,
        });
      }
    } catch (e) {
      toast({ title: dryRun ? "Preview failed" : "Backfill failed", description: (e as Error).message, variant: "destructive" });
    }
  }

  function run() {
    if (!result?.dryRun) return;
    const ok = window.confirm(
      `Backfill Discord threads for ${result.count ?? 0} mission(s)?\n\n` +
      `This creates a Discord forum thread (and/or seeds the snapshot post) for each posted mission missing one.\n` +
      (!result.externalWritesAllowed
        ? `\nWARNING: Discord writes are DISABLED in this environment — thread creation will be skipped. Run this from the published app.`
        : ""),
    );
    if (!ok) return;
    void call(false);
  }

  return (
    <Card className="rounded-none border-border bg-card/50">
      <CardHeader>
        <CardTitle className="font-display tracking-widest">MISSION THREAD BACKFILL</CardTitle>
        <CardDescription className="font-mono text-xs">
          Creates the missing Discord forum thread (and seeds the mission snapshot post) for every
          posted, still-active mission that lacks one. Idempotent — safe to re-run; failures are
          left un-marked and retried on the next run. Always PREVIEW first. Discord writes only
          happen when run from the published app.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" className="rounded-none" onClick={() => void call(true)} disabled={mutation.isPending} data-testid="button-mission-thread-scan">
            {mutation.isPending ? "Working…" : "Preview targets"}
          </Button>
          <Button variant="default" className="rounded-none" onClick={run} disabled={!result?.dryRun || mutation.isPending} data-testid="button-mission-thread-run">
            Backfill threads
          </Button>
        </div>
        {result && (
          <div className="font-mono text-xs space-y-2" data-testid="mission-thread-backfill-result">
            <div className="text-muted-foreground">
              {result.dryRun
                ? `Preview — ${result.count ?? 0} mission(s) need a thread or snapshot.`
                : `Done — scanned ${result.scanned ?? 0}, created ${result.created ?? 0}, seeded ${result.seeded ?? 0}, failed ${result.failed ?? 0}.`}
              {!result.externalWritesAllowed && (
                <span className="block text-destructive">Discord writes disabled here — run from the published app to create threads.</span>
              )}
            </div>
            {result.targets && result.targets.length > 0 && (
              <ul className="max-h-48 overflow-auto border border-border p-2 space-y-0.5">
                {result.targets.map((t) => (
                  <li key={t.id} className="flex justify-between gap-2">
                    <span>#{t.id} {t.title}</span>
                    <span className="text-nc-cyan">missing {t.missing}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function WalletMirrorCard() {
  const { toast } = useToast();
  const health = useAdminWalletMirrorHealth();
  const push = useAdminWalletMirrorPush();
  const h = health.data;

  async function pushNow() {
    try {
      const r = await push.mutateAsync({ data: {} });
      toast({
        title: "Mirror push complete",
        description: `Pushed ${r.pushed}, failed ${r.failed}, suppressed ${r.suppressed}.`,
      });
      void health.refetch();
    } catch (e) {
      toast({ title: "Mirror push failed", description: (e as Error).message, variant: "destructive" });
    }
  }

  return (
    <Card className="rounded-none border-border bg-card/50">
      <CardHeader>
        <CardTitle className="font-display tracking-widest">UNBELIEVABOAT MIRROR HEALTH</CardTitle>
        <CardDescription className="font-mono text-xs">
          The website wallet is the source of truth; every website-side balance change queues a push
          that mirrors it into UnbelievaBoat. This shows the push queue, recent failures, and any
          users whose Discord balance hasn't caught up yet.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 font-mono text-xs">
        <div className="flex flex-wrap gap-2 items-center">
          <Button variant="outline" className="rounded-none" onClick={() => void health.refetch()} disabled={health.isFetching} data-testid="button-mirror-refresh">
            {health.isFetching ? "Loading…" : "Refresh"}
          </Button>
          <Button variant="default" className="rounded-none" onClick={() => void pushNow()} disabled={push.isPending} data-testid="button-mirror-push-now">
            {push.isPending ? "Pushing…" : "Push now"}
          </Button>
        </div>
        {h && (
          <div className="space-y-3" data-testid="mirror-health-result">
            <div className="text-muted-foreground">
              Queue: <span className={h.counts.pending > 0 ? "text-nc-yellow" : "text-nc-cyan"}>{h.counts.pending} pending</span>, {h.counts.inflight} in-flight,
              {" "}{h.counts.pushed24h} pushed (24h), {h.counts.suppressed} suppressed.
              {" "}Oldest pending: {h.oldestPendingAt ? new Date(h.oldestPendingAt).toLocaleString() : "—"}.
              {" "}Last push: {h.lastPushedAt ? new Date(h.lastPushedAt).toLocaleString() : "never"}.
            </div>
            {h.recentFailures.length > 0 && (
              <div>
                <div className="text-destructive mb-1">Recent push failures</div>
                <ul className="max-h-40 overflow-auto border border-border p-2 space-y-0.5">
                  {h.recentFailures.map((f) => (
                    <li key={f.id} className="flex justify-between gap-2">
                      <span>{f.userId} {f.amount >= 0 ? "+" : ""}{f.amount.toLocaleString()} (try {f.attempts})</span>
                      <span className="text-muted-foreground truncate max-w-64">{f.lastError ?? ""}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {h.driftedCount > 0 && (
              <div className="text-nc-yellow">
                ⚠ {h.driftedCount} user(s) have a wallet/UB baseline mismatch — use the UB Balance Repair card below to fix.
              </div>
            )}
            {h.users.length > 0 ? (
              <div>
                <div className="mb-1">Users with queued pushes / drift</div>
                <ul className="max-h-48 overflow-auto border border-border p-2 space-y-0.5">
                  {h.users.map((u) => (
                    <li key={u.userId} className="flex justify-between gap-2">
                      <span>{u.username || u.userId}</span>
                      <span className="text-muted-foreground">
                        site {u.websiteBalance.toLocaleString()} · expected UB {u.expectedUbTotal?.toLocaleString() ?? "unseeded"} · queued {u.queuedCount} ({u.queuedAmount >= 0 ? "+" : ""}{u.queuedAmount.toLocaleString()})
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <div className={h.driftedCount === 0 ? "text-nc-cyan" : "text-muted-foreground"}>
                {h.driftedCount === 0 ? "Mirror is fully caught up." : "Push queue is clear."}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function UbBalanceRepairCard() {
  const { toast } = useToast();
  const [result, setResult] = useState<UbBalanceRepairResult | null>(null);
  const mutation = useAdminUbBalanceRepair();

  async function call(dryRun: boolean) {
    try {
      const body = await mutation.mutateAsync({ data: { dryRun } });
      setResult(body);
      if (!dryRun) {
        toast({
          title: "UB balance repair complete",
          description: `Repaired ${body.repaired} / ${body.totalDrifted} drifted user(s). Skipped: ${body.skippedNegativeTarget} negative-wallet, ${body.skippedPendingPushes} pending-push, ${body.skippedUbUnreachable} UB-unreachable.`,
        });
      }
    } catch (e) {
      toast({ title: dryRun ? "Preview failed" : "Repair failed", description: (e as Error).message, variant: "destructive" });
    }
  }

  function run() {
    if (!result?.dryRun) return;
    const ok = window.confirm(
      `Repair ${result.eligible} eligible drifted user(s) (${result.totalDrifted} total drifted)?\n\n` +
      `This patches each user's UnbelievaBoat balance to match their website wallet, advances the sync baseline, and writes a forensic ledger row. ` +
      `Users with a negative website balance (${result.skippedNegativeTarget}) or pending push outbox rows (${result.skippedPendingPushes}) are skipped.\n\n` +
      `Only run this in the DEPLOYED environment — UB writes are suppressed in dev.`,
    );
    if (!ok) return;
    void call(false);
  }

  const eligibleUsers = result?.users?.filter((u) => !u.skippedNegativeTarget && !u.skippedPendingPushes) ?? [];
  const skippedUsers = result?.users?.filter((u) => u.skippedNegativeTarget || u.skippedPendingPushes) ?? [];

  return (
    <Card className="rounded-none border-border bg-card/50">
      <CardHeader>
        <CardTitle className="font-display tracking-widest">UB BALANCE REPAIR</CardTitle>
        <CardDescription className="font-mono text-xs">
          Finds users whose Discord (UnbelievaBoat) balance is ahead of their website wallet due to
          historical charges that were never mirrored. Patches UB by the drift amount (bank preferred),
          advances the sync baseline, and writes a forensic ledger row per user. Preview first — the
          live run issues real UB writes and requires the deployed environment.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" className="rounded-none" onClick={() => void call(true)} disabled={mutation.isPending} data-testid="button-ub-repair-scan">
            {mutation.isPending && result === null ? "Working…" : "Preview drifted users"}
          </Button>
          <Button variant="default" className="rounded-none" onClick={run} disabled={!result?.dryRun || (result?.eligible ?? 0) === 0 || mutation.isPending} data-testid="button-ub-repair-run">
            {mutation.isPending && result?.dryRun ? "Repairing…" : "Run repair"}
          </Button>
        </div>
        {result && (
          <div className="font-mono text-xs space-y-2" data-testid="ub-repair-result">
            <div className="text-muted-foreground">
              {result.dryRun ? "Preview" : "Done"} — {result.totalDrifted} drifted, {result.eligible} eligible
              {!result.dryRun && `, repaired ${result.repaired}, failed ${result.failed}, raced ${result.skippedRaced}`}.
              {" "}Skipped: {result.skippedNegativeTarget} negative-wallet, {result.skippedPendingPushes} pending-push
              {!result.dryRun && `, ${result.skippedUbUnreachable} UB-unreachable`}.
              {result.dryRun && !result.externalWritesAllowed && (
                <span className="text-nc-yellow"> ⚠ External writes disabled — live run will suppress UB patches.</span>
              )}
            </div>
            {result.dryRun && eligibleUsers.length > 0 && (
              <div>
                <div className="mb-1 text-foreground">Eligible users ({eligibleUsers.length})</div>
                <ul className="max-h-48 overflow-auto border border-border p-2 space-y-0.5">
                  {eligibleUsers.map((u) => (
                    <li key={u.userId} className="flex justify-between gap-2">
                      <span>{u.username || u.userId}</span>
                      <span className={u.drift < 0 ? "text-nc-yellow" : "text-nc-cyan"}>
                        site {u.websiteBalance.toLocaleString()} · baseline {u.lastSyncedUbBalance.toLocaleString()} · drift {u.drift >= 0 ? "+" : ""}{u.drift.toLocaleString()}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {result.dryRun && skippedUsers.length > 0 && (
              <div>
                <div className="mb-1 text-muted-foreground">Skipped ({skippedUsers.length})</div>
                <ul className="max-h-32 overflow-auto border border-border/50 p-2 space-y-0.5 text-muted-foreground">
                  {skippedUsers.map((u) => (
                    <li key={u.userId} className="flex justify-between gap-2">
                      <span>{u.username || u.userId}</span>
                      <span>{u.skippedNegativeTarget ? "negative wallet" : "pending pushes"} · drift {u.drift >= 0 ? "+" : ""}{u.drift.toLocaleString()}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {!result.dryRun && result.outcomes && result.outcomes.length > 0 && (
              <div>
                <div className="mb-1 text-foreground">Outcomes</div>
                <ul className="max-h-48 overflow-auto border border-border p-2 space-y-0.5">
                  {result.outcomes.map((o, i) => (
                    <li key={`${o.userId}-${i}`} className="flex justify-between gap-2">
                      <span>{o.username || o.userId}</span>
                      <span className={o.status === "repaired" ? "text-nc-cyan" : "text-nc-yellow"}>
                        {o.status} · drift {o.drift >= 0 ? "+" : ""}{o.drift.toLocaleString()}
                        {o.error ? ` (${o.error})` : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function EconomyReconcileCard() {
  const { toast } = useToast();
  const [userId, setUserId] = useState("");
  const [result, setResult] = useState<EconomyReconcileResult | null>(null);
  const mutation = useAdminEconomyReconcile();

  async function call(dryRun: boolean) {
    try {
      const body = await mutation.mutateAsync({ data: { userId: userId.trim(), dryRun } });
      setResult(body);
      if (!dryRun) {
        toast({
          title: "Economy reconcile complete",
          description: `${body.username ?? body.userId}: ${body.status}, delta ${body.delta ?? 0}, balance ${body.balance ?? 0}.`,
        });
      }
    } catch (e) {
      toast({ title: dryRun ? "Preview failed" : "Reconcile failed", description: (e as Error).message, variant: "destructive" });
    }
  }

  function run() {
    if (!result?.dryRun) return;
    const ok = window.confirm(
      `Fold a delta of ${result.delta ?? 0} eddies into ${result.username ?? result.userId}'s website wallet?\n\n` +
      `Website balance ${result.walletBalance ?? 0} → UnbelievaBoat total ${result.ubBalance ?? 0} (baseline ${result.baseline ?? 0}).` +
      (result.wouldSeed ? `\n\nNo sync baseline yet — this SEEDS the wallet to the UnbelievaBoat total.` : ""),
    );
    if (!ok) return;
    void call(false);
  }

  return (
    <Card className="rounded-none border-border bg-card/50">
      <CardHeader>
        <CardTitle className="font-display tracking-widest">ECONOMY RECONCILE (ONE USER)</CardTitle>
        <CardDescription className="font-mono text-xs">
          Re-pulls one player's live UnbelievaBoat balance and folds any Discord-side delta into
          their website wallet with a reconciliation ledger row. Preview shows the exact delta
          before anything is written. The live run respects the economy mode (disabled/test = no
          real write).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-2 items-center">
          <Input
            value={userId}
            onChange={(e) => { setUserId(e.target.value); setResult(null); }}
            placeholder="User ID (Discord snowflake)"
            className="rounded-none w-64 font-mono text-xs"
            data-testid="input-economy-reconcile-user"
          />
          <Button variant="outline" className="rounded-none" onClick={() => void call(true)} disabled={!userId.trim() || mutation.isPending} data-testid="button-economy-reconcile-scan">
            {mutation.isPending ? "Working…" : "Preview delta"}
          </Button>
          <Button variant="default" className="rounded-none" onClick={run} disabled={!result?.dryRun || mutation.isPending} data-testid="button-economy-reconcile-run">
            Reconcile wallet
          </Button>
        </div>
        {result && (
          <div className="font-mono text-xs text-muted-foreground" data-testid="economy-reconcile-result">
            {result.dryRun ? (
              <>
                Preview for {result.username ?? result.userId}: website {result.walletBalance ?? 0}, UnbelievaBoat {result.ubBalance ?? 0},
                baseline {result.baseline ?? 0} → delta <span className={result.delta ? "text-nc-yellow" : "text-nc-cyan"}>{result.delta ?? 0}</span>
                {result.wouldSeed ? " (would seed baseline)" : ""}.
              </>
            ) : (
              <>Done — {result.status}, delta {result.delta ?? 0}, balance {result.balance ?? 0}.{result.error ? ` Error: ${result.error}` : ""}</>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function RehostEventImagesCard() {
  const { toast } = useToast();
  const [result, setResult] = useState<RehostEventImagesResult | null>(null);
  const mutation = useAdminRehostEventImages();

  async function call(dryRun: boolean) {
    try {
      const body = await mutation.mutateAsync({ data: { dryRun } });
      setResult(body);
      if (!dryRun) {
        toast({
          title: "Event image rehost complete",
          description: `Rehosted ${body.updated ?? 0}, failed ${body.failed ?? 0} of ${body.scanned ?? 0}.`,
        });
      }
    } catch (e) {
      toast({ title: dryRun ? "Preview failed" : "Rehost failed", description: (e as Error).message, variant: "destructive" });
    }
  }

  function run() {
    if (!result?.dryRun) return;
    const ok = window.confirm(
      `Re-host ${result.count ?? 0} event banner(s) from Discord's CDN to object storage?\n\n` +
      `Discord CDN links expire after ~24h; this fetches each banner at full resolution and rewrites the event to a permanent hosted copy.`,
    );
    if (!ok) return;
    void call(false);
  }

  return (
    <Card className="rounded-none border-border bg-card/50">
      <CardHeader>
        <CardTitle className="font-display tracking-widest">EVENT IMAGE REHOST</CardTitle>
        <CardDescription className="font-mono text-xs">
          Finds events whose banner still points at a raw (expiring) Discord CDN guild-events URL,
          re-fetches it at 2048px and re-hosts it to object storage. Idempotent — rewritten events
          no longer match the scan. Reads only from Discord's CDN, so it is safe to run anywhere.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" className="rounded-none" onClick={() => void call(true)} disabled={mutation.isPending} data-testid="button-rehost-images-scan">
            {mutation.isPending ? "Working…" : "Preview targets"}
          </Button>
          <Button variant="default" className="rounded-none" onClick={run} disabled={!result?.dryRun || mutation.isPending} data-testid="button-rehost-images-run">
            Rehost images
          </Button>
        </div>
        {result && (
          <div className="font-mono text-xs space-y-2" data-testid="rehost-images-result">
            <div className="text-muted-foreground">
              {result.dryRun
                ? `Preview — ${result.count ?? 0} event(s) with an expiring banner.`
                : `Done — rehosted ${result.updated ?? 0}, failed ${result.failed ?? 0} of ${result.scanned ?? 0}.`}
            </div>
            {result.targets && result.targets.length > 0 && (
              <ul className="max-h-48 overflow-auto border border-border p-2 space-y-0.5">
                {result.targets.map((t) => (
                  <li key={t.id}>#{t.id} {t.title}</li>
                ))}
              </ul>
            )}
            {result.failures && result.failures.length > 0 && (
              <ul className="max-h-32 overflow-auto border border-destructive/40 p-2 space-y-0.5 text-destructive">
                {result.failures.map((f) => (
                  <li key={f.id}>#{f.id} {f.title}: rehost failed</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function GuidebookLinkRepairCard() {
  const { toast } = useToast();
  const [result, setResult] = useState<GuidebookLinkRepairResult | null>(null);
  const mutation = useAdminGuidebookLinkRepair();

  async function call(dryRun: boolean) {
    try {
      const body = await mutation.mutateAsync({ data: { dryRun } });
      setResult(body);
      if (!dryRun) {
        toast({
          title: "Guidebook link repair complete",
          description: `Rewrote ${body.pagesChanged} page(s), ${body.brokenInternalLinks} broken internal link(s) reported.`,
        });
      }
    } catch (e) {
      toast({ title: dryRun ? "Scan failed" : "Repair failed", description: (e as Error).message, variant: "destructive" });
    }
  }

  function run() {
    if (!result?.dryRun) return;
    const ok = window.confirm(
      `Rewrite internal links on ${result.pagesChanged} guidebook page(s) (${result.totalRewrites} rewrite(s))?\n\n` +
      `Google Doc links and Discord channel links that now have a portal page are rewritten in place. Broken internal links are only reported, never guessed at.`,
    );
    if (!ok) return;
    void call(false);
  }

  return (
    <Card className="rounded-none border-border bg-card/50">
      <CardHeader>
        <CardTitle className="font-display tracking-widest">GUIDEBOOK LINK REPAIR</CardTitle>
        <CardDescription className="font-mono text-xs">
          Re-scans every guidebook page against the CURRENT link maps: Google Doc links and Discord
          channel links that now map to a portal page are rewritten; internal links pointing at
          deleted pages are reported. Pure database operation (no Discord calls), idempotent.
          Always SCAN first.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" className="rounded-none" onClick={() => void call(true)} disabled={mutation.isPending} data-testid="button-guidebook-repair-scan">
            {mutation.isPending ? "Working…" : "Scan links"}
          </Button>
          <Button variant="default" className="rounded-none" onClick={run} disabled={!result?.dryRun || mutation.isPending || (result?.pagesChanged ?? 0) === 0} data-testid="button-guidebook-repair-run">
            Repair links
          </Button>
        </div>
        {result && (
          <div className="font-mono text-xs space-y-2" data-testid="guidebook-repair-result">
            <div className="text-muted-foreground">
              {result.dryRun ? "Scan" : "Done"} — {result.scanned} page(s) scanned, {result.pagesChanged} with rewrites
              ({result.totalRewrites} total), {result.brokenInternalLinks} broken internal link(s).
            </div>
            {result.pages.length > 0 && (
              <ul className="max-h-48 overflow-auto border border-border p-2 space-y-1">
                {result.pages.map((p) => (
                  <li key={p.pageId}>
                    <span className="text-foreground">{p.title}</span>
                    {p.rewrites.length > 0 && (
                      <span className="block text-nc-cyan pl-2">{p.rewrites.join("; ")}</span>
                    )}
                    {p.brokenInternal.length > 0 && (
                      <span className="block text-destructive pl-2">broken: {p.brokenInternal.join(", ")}</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

interface RipperdocBackfillTarget {
  userId: string;
  username: string | null;
  sources: string;
}

interface RipperdocBackfillResult {
  dryRun?: boolean;
  count: number;
  granted?: number;
  failed?: number;
  grantable?: number;
  skipped: number;
  externalWritesAllowed: boolean;
  targets?: RipperdocBackfillTarget[];
  failures?: Array<{ userId: string; username: string | null; error: string }>;
}

function RipperdocBackfillCard() {
  const { toast } = useToast();
  const [preview, setPreview] = useState<RipperdocBackfillResult | null>(null);
  const [scanning, setScanning] = useState(false);
  const [running, setRunning] = useState(false);

  async function call(dryRun: boolean): Promise<RipperdocBackfillResult | null> {
    const r = await fetch("/api/admin/maintenance/ripperdoc-backfill", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dryRun }),
    });
    const body = await r.json();
    if (!r.ok) {
      toast({ title: dryRun ? "Preview failed" : "Backfill failed", description: body.error ?? `HTTP ${r.status}`, variant: "destructive" });
      return null;
    }
    return body as RipperdocBackfillResult;
  }

  async function scan() {
    setScanning(true);
    setPreview(null);
    try {
      const body = await call(true);
      if (body) setPreview(body);
    } finally {
      setScanning(false);
    }
  }

  async function run() {
    if (!preview) return;
    const ok = window.confirm(
      `Grant the RipperDoc role to ${preview.grantable ?? preview.count} ripper docs?\n\n` +
      `This grants the Discord "RipperDoc" role and sets the website role for each.\n` +
      (!preview.externalWritesAllowed
        ? `\nWARNING: Discord writes are DISABLED in this environment — the Discord grant will be skipped. Run this from the published app to actually grant Discord roles.`
        : ""),
    );
    if (!ok) return;
    setRunning(true);
    try {
      const body = await call(false);
      if (body) {
        setPreview(body);
        toast({
          title: "RipperDoc backfill complete",
          description: `Granted ${body.granted ?? 0}, failed ${body.failed ?? 0}, skipped ${body.skipped} of ${body.count}.`,
        });
      }
    } finally {
      setRunning(false);
    }
  }

  return (
    <Card className="rounded-none border-border bg-card/50">
      <CardHeader>
        <CardTitle className="font-display tracking-widest">RIPPERDOC ROLE BACKFILL</CardTitle>
        <CardDescription className="font-mono text-xs">
          One-time grant of the "RipperDoc" Discord role (and the matching website role) to every
          existing ripper doc: characters whose archetype or occupation says ripperdoc, plus everyone
          who owns or works at a ripperdoc clinic. Idempotent — safe to re-run. Always PREVIEW first.
          Discord roles are only granted when run from the published app.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" className="rounded-none" onClick={scan} disabled={scanning || running} data-testid="button-ripperdoc-scan">
            {scanning ? "Scanning…" : "Preview targets"}
          </Button>
          <Button variant="default" className="rounded-none" onClick={run} disabled={!preview || running || scanning} data-testid="button-ripperdoc-run">
            {running ? "Granting…" : "Grant RipperDoc role"}
          </Button>
        </div>
        {preview && (
          <div className="font-mono text-xs space-y-2" data-testid="ripperdoc-backfill-result">
            <div className="text-muted-foreground">
              {preview.dryRun ? "Preview" : "Done"} — {preview.count} target(s)
              {preview.grantable != null ? `, ${preview.grantable} grantable` : ""}
              {preview.granted != null ? `, granted ${preview.granted}` : ""}
              {preview.failed != null ? `, failed ${preview.failed}` : ""}
              {`, skipped ${preview.skipped}`}.
              {!preview.externalWritesAllowed && (
                <span className="block text-destructive">Discord writes disabled here — run from the published app to grant Discord roles.</span>
              )}
            </div>
            {preview.targets && preview.targets.length > 0 && (
              <ul className="max-h-48 overflow-auto border border-border p-2 space-y-0.5">
                {preview.targets.map((t) => (
                  <li key={t.userId} className="flex justify-between gap-2">
                    <span>{t.username ?? "(unknown)"} <span className="text-muted-foreground">{t.userId}</span></span>
                    <span className="text-nc-cyan">{t.sources}</span>
                  </li>
                ))}
              </ul>
            )}
            {preview.failures && preview.failures.length > 0 && (
              <ul className="max-h-32 overflow-auto border border-destructive/40 p-2 space-y-0.5 text-destructive">
                {preview.failures.map((f) => (
                  <li key={f.userId}>{f.username ?? f.userId}: {f.error}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

interface DupeRow {
  id: number;
  name: string;
  kind: string;
  ownerId: string | null;
  ownerName: string | null;
  archetype: string | null;
  portraitUrl: string | null;
  portraitCount: number;
  hasSheetData: boolean;
  importedFromThreadId: string | null;
  legacyDiscordUsername: string | null;
  approved: boolean;
  archived: boolean;
  lifeStatus: string;
  createdAt: string;
}

interface DupeGroup {
  key: string;
  kind: string;
  name: string;
  count: number;
  suggestedKeepId: number;
  rows: DupeRow[];
}

interface DupeResponse {
  groupCount: number;
  totalDuplicateRows: number;
  groups: DupeGroup[];
}

interface MergeResult {
  keepId: number;
  dropId: number;
  fieldsFilled: string[];
  repointed: Record<string, number>;
}

interface AccountMergePreview {
  dryRun: true;
  keep: Record<string, unknown>;
  drop: Record<string, unknown>;
  wouldTransferEddies: number;
  economyMode: "disabled" | "test" | "enabled";
  liveUbBalance: { keep: number | null; drop: number | null };
  wouldFillFields: string[];
  wouldRepoint: Record<string, number>;
}

function MergeAccountCard() {
  const { toast } = useToast();
  const [keepId, setKeepId] = useState("");
  const [dropId, setDropId] = useState("");
  const [preview, setPreview] = useState<AccountMergePreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [merging, setMerging] = useState(false);

  async function scan() {
    if (!keepId.trim() || !dropId.trim()) {
      toast({ title: "Missing IDs", description: "Enter both the KEEP and DROP Discord user IDs.", variant: "destructive" });
      return;
    }
    setLoading(true);
    setPreview(null);
    try {
      const r = await fetch("/api/admin/maintenance/merge-account", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ keepId: keepId.trim(), dropId: dropId.trim(), dryRun: true }),
      });
      const body = await r.json();
      if (!r.ok) {
        toast({ title: "Preview failed", description: body.error ?? `HTTP ${r.status}`, variant: "destructive" });
        return;
      }
      setPreview(body as AccountMergePreview);
    } finally {
      setLoading(false);
    }
  }

  async function doMerge() {
    if (!preview) return;
    const repointTotal = Object.values(preview.wouldRepoint).reduce((s, n) => s + n, 0);
    const ok = window.confirm(
      `MERGE ACCOUNT ${dropId.trim()} INTO ${keepId.trim()}?\n\n` +
      `• ${formatEddies(preview.wouldTransferEddies)} will be moved on UnbelievaBoat to the keep account.\n` +
      `• ~${repointTotal} child rows (characters, stores, wallet history, requests…) will be repointed.\n` +
      `• Empty fields on the keep account will be filled from the drop account.\n` +
      `• The drop account row will then be DELETED. This cannot be undone.\n\n` +
      (preview.economyMode !== "enabled"
        ? `WARNING: the economy is "${preview.economyMode}", not LIVE — the eddies transfer will NOT run and the merge will abort before deleting anything.`
        : ""),
    );
    if (!ok) return;
    setMerging(true);
    try {
      const r = await fetch("/api/admin/maintenance/merge-account", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ keepId: keepId.trim(), dropId: dropId.trim() }),
      });
      const body = await r.json();
      if (!r.ok) {
        toast({ title: "Merge failed", description: body.error ?? `HTTP ${r.status}`, variant: "destructive" });
        return;
      }
      const repointTotalDone = Object.values(body.repointed ?? {}).reduce((s: number, n) => s + (n as number), 0);
      toast({
        title: `Merged ${dropId.trim()} → ${keepId.trim()}`,
        description: `Transferred ${formatEddies(body.walletTransfer?.amount ?? 0)}, repointed ${repointTotalDone} rows, filled ${body.fieldsFilled?.length ?? 0} fields.`,
      });
      setPreview(null);
      setKeepId("");
      setDropId("");
    } finally {
      setMerging(false);
    }
  }

  return (
    <Card className="rounded-none border-destructive/40 bg-card/50">
      <CardHeader>
        <CardTitle className="font-display tracking-widest text-destructive">MERGE ACCOUNTS</CardTitle>
        <CardDescription className="font-mono text-xs">
          Fold a compromised or duplicate Discord account (DROP) into another one (KEEP). The KEEP
          account keeps its own login, roles and identity; everything the DROP account owns —
          characters, stores, wallet history, requests, missions — is repointed to KEEP, its eddies
          are transferred on UnbelievaBoat, and the DROP account is deleted. User IDs are the Discord
          snowflake (the long number). Always PREVIEW first. The eddies transfer only runs when the
          economy is LIVE; in any other mode the merge aborts before deleting anything.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 font-mono text-xs">
          <label className="space-y-1">
            <span className="text-nc-cyan tracking-widest">KEEP (surviving) user ID</span>
            <Input value={keepId} onChange={(e) => { setKeepId(e.target.value); setPreview(null); }} placeholder="e.g. 1519394891287756909" data-testid="input-merge-keep-id" />
          </label>
          <label className="space-y-1">
            <span className="text-destructive tracking-widest">DROP (deleted) user ID</span>
            <Input value={dropId} onChange={(e) => { setDropId(e.target.value); setPreview(null); }} placeholder="e.g. 288730657872412672" data-testid="input-merge-drop-id" />
          </label>
        </div>

        <div className="flex items-center gap-3">
          <Button
            type="button"
            onClick={scan}
            disabled={loading || merging}
            className="rounded-none bg-nc-cyan text-background hover:bg-nc-cyan/80 font-display tracking-widest"
            data-testid="button-merge-account-preview"
          >
            {loading ? "CHECKING..." : "PREVIEW MERGE"}
          </Button>
          {preview && (
            <Button
              type="button"
              onClick={doMerge}
              disabled={merging || loading}
              className="rounded-none bg-destructive text-foreground hover:bg-destructive/80 font-display tracking-widest"
              data-testid="button-merge-account-confirm"
            >
              {merging ? "MERGING..." : "MERGE & DELETE DROP"}
            </Button>
          )}
        </div>

        {preview && (
          <div className="border border-border/60 p-3 space-y-3 font-mono text-xs" data-testid="merge-account-preview">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div className="border border-nc-cyan/50 bg-nc-cyan/5 p-2 space-y-1">
                <div className="text-nc-cyan font-bold tracking-widest">KEEP · {String(preview.keep.username ?? "?")}</div>
                <div className="text-muted-foreground">id: {String(preview.keep.id)}</div>
                <div>balance: {formatEddies(Number(preview.keep.walletBalance ?? 0))}</div>
                <div className="text-muted-foreground">live UB: {preview.liveUbBalance.keep == null ? "—" : formatEddies(preview.liveUbBalance.keep)}</div>
              </div>
              <div className="border border-destructive/50 bg-destructive/5 p-2 space-y-1">
                <div className="text-destructive font-bold tracking-widest">DROP · {String(preview.drop.username ?? "?")}</div>
                <div className="text-muted-foreground">id: {String(preview.drop.id)}</div>
                <div>balance: {formatEddies(Number(preview.drop.walletBalance ?? 0))}</div>
                <div className="text-muted-foreground">live UB: {preview.liveUbBalance.drop == null ? "—" : formatEddies(preview.liveUbBalance.drop)}</div>
              </div>
            </div>
            <div className="space-y-1">
              <div>
                Eddies to transfer:{" "}
                <span className="text-nc-cyan font-bold">{formatEddies(preview.wouldTransferEddies)}</span>{" "}
                <span className={preview.economyMode === "enabled" ? "text-nc-cyan" : "text-destructive"}>
                  (economy: {preview.economyMode}{preview.economyMode !== "enabled" ? " — transfer will NOT run" : ""})
                </span>
              </div>
              <div>Fields to fill on KEEP: {preview.wouldFillFields.length ? preview.wouldFillFields.join(", ") : <em className="text-muted-foreground/50">none</em>}</div>
            </div>
            <div>
              <div className="text-muted-foreground tracking-widest mb-1">CHILD ROWS TO REPOINT</div>
              {Object.keys(preview.wouldRepoint).length === 0 ? (
                <em className="text-muted-foreground/50">none</em>
              ) : (
                <div className="grid grid-cols-2 md:grid-cols-3 gap-x-4 gap-y-0.5 text-[0.625rem]">
                  {Object.entries(preview.wouldRepoint).map(([k, n]) => (
                    <div key={k} className="flex justify-between gap-2">
                      <span className="truncate">{k}</span>
                      <span className="text-nc-cyan">{n}</span>
                    </div>
                  ))}
                </div>
              )}
              <div className="text-[0.625rem] text-muted-foreground/60 mt-1 italic">
                Preview shows ownership highlights only; the merge repoints every reference, including
                staff-action and review-vote rows not listed here.
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function DuplicateCleanupCard() {
  const { toast } = useToast();
  const [data, setData] = useState<DupeResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [merging, setMerging] = useState<string | null>(null);
  // groupKey -> the id the admin has picked as the keeper. Defaults to the
  // server's suggestion when the group is first loaded.
  const [keepers, setKeepers] = useState<Record<string, number>>({});

  async function load() {
    setLoading(true);
    try {
      const r = await fetch("/api/admin/maintenance/duplicate-characters", { credentials: "include" });
      const body = await r.json();
      if (!r.ok) {
        toast({ title: "Scan failed", description: body.error ?? `HTTP ${r.status}`, variant: "destructive" });
        return;
      }
      setData(body as DupeResponse);
      const init: Record<string, number> = {};
      for (const g of (body as DupeResponse).groups) init[g.key] = g.suggestedKeepId;
      setKeepers(init);
    } finally {
      setLoading(false);
    }
  }

  async function mergePair(group: DupeGroup, keepId: number, dropId: number) {
    const drop = group.rows.find((r) => r.id === dropId);
    const keep = group.rows.find((r) => r.id === keepId);
    if (!drop || !keep) return;
    const ok = window.confirm(
      `Merge "${drop.name}" #${drop.id} INTO #${keep.id}?\n\n` +
      `• Empty fields on #${keep.id} will be filled from #${drop.id}.\n` +
      `• All inventory, wallet, housing, sheet history pointing at #${drop.id} will be repointed to #${keep.id}.\n` +
      `• #${drop.id} will then be deleted. This cannot be undone.`,
    );
    if (!ok) return;
    setMerging(`${keepId}->${dropId}`);
    try {
      const r = await fetch("/api/admin/maintenance/merge-character", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ keepId, dropId }),
      });
      const body = await r.json();
      if (!r.ok) {
        toast({ title: "Merge failed", description: body.error ?? `HTTP ${r.status}`, variant: "destructive" });
        return;
      }
      const result = body as MergeResult;
      const repointTotal = Object.values(result.repointed).reduce((s, n) => s + n, 0);
      toast({
        title: `Merged #${dropId} → #${keepId}`,
        description: `Filled ${result.fieldsFilled.length} fields, repointed ${repointTotal} child rows.`,
      });
      await load();
    } finally {
      setMerging(null);
    }
  }

  return (
    <Card className="rounded-none border-destructive/40 bg-card/50">
      <CardHeader>
        <CardTitle className="font-display tracking-widest text-destructive">DUPLICATE CHARACTERS</CardTitle>
        <CardDescription className="font-mono text-xs">
          Lists every (kind, name) collision so you can review each pair before merging. Pre-fix
          imports could create a second empty NPC when the name drifted between dev and prod.
          The default "KEEP" pick is the row with the richest data (sheet body, portrait, owner) —
          override per row if you know the other one is canonical. Merging is destructive: the
          DROP row is deleted after all its inventory / wallet / housing references are
          repointed to the keeper.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-3">
          <Button
            type="button"
            onClick={load}
            disabled={loading}
            className="rounded-none bg-destructive text-foreground hover:bg-destructive/80 font-display tracking-widest"
            data-testid="button-scan-duplicates"
          >
            {loading ? "SCANNING..." : data ? "RE-SCAN" : "SCAN FOR DUPLICATES"}
          </Button>
          {data && (
            <span className="text-xs font-mono text-muted-foreground">
              {data.groupCount} group{data.groupCount === 1 ? "" : "s"} · {data.totalDuplicateRows} rows
            </span>
          )}
        </div>

        {data && data.groups.length === 0 && (
          <div className="text-xs font-mono text-muted-foreground italic">No duplicate characters detected.</div>
        )}

        {data && data.groups.map((g) => {
          const keepId = keepers[g.key] ?? g.suggestedKeepId;
          return (
            <div key={g.key} className="border border-border/60 p-3 space-y-2" data-testid={`dupe-group-${g.key}`}>
              <div className="flex items-baseline justify-between gap-3">
                <div className="font-display tracking-widest text-sm">
                  {g.name} <span className="text-muted-foreground">[{g.kind}]</span>
                </div>
                <div className="text-xs font-mono text-muted-foreground">{g.count} rows</div>
              </div>
              <div className="space-y-1">
                {g.rows.map((row) => {
                  const isKeep = row.id === keepId;
                  return (
                    <div
                      key={row.id}
                      className={`border px-3 py-2 text-xs font-mono flex items-center gap-3 ${
                        isKeep ? "border-nc-cyan/60 bg-nc-cyan/5" : "border-border/40"
                      }`}
                      data-testid={`dupe-row-${row.id}`}
                    >
                      <label className="flex items-center gap-2 shrink-0 cursor-pointer">
                        <input
                          type="radio"
                          name={`keep-${g.key}`}
                          checked={isKeep}
                          onChange={() => setKeepers((k) => ({ ...k, [g.key]: row.id }))}
                          className="cursor-pointer"
                          data-testid={`radio-keep-${row.id}`}
                        />
                        <span className={isKeep ? "text-nc-cyan font-bold" : "text-muted-foreground"}>
                          {isKeep ? "KEEP" : "drop"} #{row.id}
                        </span>
                      </label>
                      <div className="flex-1 min-w-0 grid grid-cols-2 md:grid-cols-4 gap-2 text-[0.625rem]">
                        <span title="archetype">{row.archetype || <em className="text-muted-foreground/50">no archetype</em>}</span>
                        <span title="portrait">{row.portraitUrl ? `${row.portraitCount} portrait${row.portraitCount === 1 ? "" : "s"}` : <em className="text-muted-foreground/50">no portrait</em>}</span>
                        <span title="sheet">{row.hasSheetData ? "sheet ✓" : <em className="text-muted-foreground/50">no sheet</em>}</span>
                        <span title="owner">{row.ownerName ? `@${row.ownerName}` : <em className="text-muted-foreground/50">unclaimed</em>}</span>
                        <span title="legacy username" className="md:col-span-2">{row.legacyDiscordUsername ? `legacy: ${row.legacyDiscordUsername}` : ""}</span>
                        <span title="thread id" className="md:col-span-2">{row.importedFromThreadId ? `thread: ${row.importedFromThreadId}` : ""}</span>
                      </div>
                      {!isKeep && (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={merging !== null}
                          onClick={() => mergePair(g, keepId, row.id)}
                          className="rounded-none border-destructive text-destructive hover:bg-destructive hover:text-foreground h-7 px-2 font-display tracking-widest text-xs shrink-0"
                          data-testid={`button-merge-${keepId}-${row.id}`}
                        >
                          {merging === `${keepId}->${row.id}` ? "MERGING..." : `MERGE → #${keepId}`}
                        </Button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

interface ClaimMatch {
  characterId: number;
  characterName: string;
  kind: string;
  legacyDiscordUsername: string;
  matchedUserIds: string[];
  matchedUsernames: string[];
}

interface ClaimPreview {
  candidateCount: number;
  ambiguousCount: number;
  matches: ClaimMatch[];
}

interface ClaimApplyResult {
  applied: Array<{ characterId: number; characterName: string; ownerId: string; matchedUsername: string }>;
  skipped: Array<{ characterId: number; characterName: string; reason: string }>;
}

function ClaimByUsernameCard() {
  const { toast } = useToast();
  const [preview, setPreview] = useState<ClaimPreview | null>(null);
  const [applyResult, setApplyResult] = useState<ClaimApplyResult | null>(null);
  const [busy, setBusy] = useState<"preview" | "apply" | null>(null);

  async function loadPreview() {
    setBusy("preview");
    setApplyResult(null);
    try {
      const r = await fetch("/api/admin/maintenance/claim-by-username", { credentials: "include" });
      const body = await r.json();
      if (!r.ok) {
        toast({ title: "Preview failed", description: body.error ?? `HTTP ${r.status}`, variant: "destructive" });
        return;
      }
      setPreview(body as ClaimPreview);
    } finally {
      setBusy(null);
    }
  }

  async function applyAll() {
    const unique = preview ? preview.matches.filter((m) => m.matchedUserIds.length === 1).length : 0;
    if (unique === 0) {
      toast({ title: "Nothing to apply", description: "No single-match candidates.", variant: "destructive" });
      return;
    }
    const ok = window.confirm(
      `Link ${unique} unclaimed character${unique === 1 ? "" : "s"} to their matched Discord user?\n\n` +
      `Ambiguous matches (multiple users with the same username) will be skipped. Existing ownerIds are never overwritten.`,
    );
    if (!ok) return;
    setBusy("apply");
    try {
      const r = await fetch("/api/admin/maintenance/claim-by-username", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const body = await r.json();
      if (!r.ok) {
        toast({ title: "Claim failed", description: body.error ?? `HTTP ${r.status}`, variant: "destructive" });
        return;
      }
      setApplyResult(body as ClaimApplyResult);
      toast({
        title: "Claim-by-username complete",
        description: `Linked ${body.applied?.length ?? 0}, skipped ${body.skipped?.length ?? 0}.`,
      });
      await loadPreview();
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card className="rounded-none border-nc-magenta/40 bg-card/50">
      <CardHeader>
        <CardTitle className="font-display tracking-widest text-nc-magenta">CLAIM UNCLAIMED BY USERNAME</CardTitle>
        <CardDescription className="font-mono text-xs">
          For every character with no ownerId but a <code>legacy_discord_username</code>, looks for a
          single matching <code>users</code> row (case-insensitive on username or global name) and
          links them. Ambiguous matches (multiple Discord users sharing the handle) are reported but
          never auto-linked. Existing owners are never overwritten.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-3">
          <Button
            type="button"
            onClick={loadPreview}
            disabled={busy !== null}
            className="rounded-none bg-nc-magenta text-foreground hover:bg-nc-magenta/80 font-display tracking-widest"
            data-testid="button-claim-preview"
          >
            {busy === "preview" ? "SCANNING..." : preview ? "RE-SCAN" : "PREVIEW MATCHES"}
          </Button>
          {preview && (
            <Button
              type="button"
              onClick={applyAll}
              disabled={busy !== null}
              className="rounded-none bg-destructive text-foreground hover:bg-destructive/80 font-display tracking-widest"
              data-testid="button-claim-apply"
            >
              {busy === "apply" ? "APPLYING..." : "APPLY SINGLE-MATCH"}
            </Button>
          )}
        </div>

        {preview && (
          <div className="space-y-2">
            <div className="text-xs font-mono text-muted-foreground">
              {preview.candidateCount} unclaimed character{preview.candidateCount === 1 ? "" : "s"} with a legacy username
              {preview.ambiguousCount > 0 ? ` · ${preview.ambiguousCount} ambiguous` : ""}
            </div>
            {preview.matches.length === 0 ? (
              <div className="text-xs font-mono text-muted-foreground italic">Nothing unclaimed has a legacy username on file.</div>
            ) : (
              <div className="space-y-1 max-h-96 overflow-y-auto">
                {preview.matches.map((m) => {
                  const tone = m.matchedUserIds.length === 1
                    ? "border-nc-cyan/40 text-foreground"
                    : m.matchedUserIds.length === 0
                      ? "border-border/40 text-muted-foreground"
                      : "border-nc-yellow/40 text-nc-yellow";
                  return (
                    <div key={m.characterId} className={`border px-3 py-2 text-xs font-mono flex items-center justify-between gap-3 ${tone}`} data-testid={`claim-row-${m.characterId}`}>
                      <div className="min-w-0">
                        <div className="truncate"><span className="text-foreground">{m.characterName}</span> <span className="opacity-50">[{m.kind}] #{m.characterId}</span></div>
                        <div className="text-[0.625rem] opacity-70 truncate">legacy: {m.legacyDiscordUsername}</div>
                      </div>
                      <div className="text-right whitespace-nowrap">
                        {m.matchedUserIds.length === 1 && <span>→ @{m.matchedUsernames[0]}</span>}
                        {m.matchedUserIds.length === 0 && <span>no user match</span>}
                        {m.matchedUserIds.length > 1 && <span>ambiguous ({m.matchedUserIds.length})</span>}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {applyResult && (
          <div className="border-t border-border/50 pt-3 space-y-2" data-testid="block-claim-apply-result">
            <div className="text-xs font-mono">
              <span className="text-nc-cyan">{applyResult.applied.length} linked</span>
              {applyResult.skipped.length > 0 && (
                <span className="text-nc-yellow"> · {applyResult.skipped.length} skipped</span>
              )}
            </div>
            {applyResult.skipped.length > 0 && (
              <div className="space-y-1 max-h-32 overflow-y-auto">
                {applyResult.skipped.map((s) => (
                  <div key={s.characterId} className="text-[0.625rem] font-mono text-nc-yellow border border-nc-yellow/30 px-2 py-1">
                    #{s.characterId} {s.characterName}: {s.reason}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

interface BackfillCandidate {
  characterId: number;
  characterName: string;
  kind: string;
  threadId: string;
  attachmentCount: number;
  firstAttachment: { filename: string; contentType: string | null; width: number | null; height: number | null } | null;
  reason: string | null;
}

interface BackfillPreview {
  total: number;
  withAttachment: number;
  candidates: BackfillCandidate[];
}

interface BackfillApplyResult {
  requested: number;
  applied: Array<{ characterId: number; characterName: string; portraitUrl: string; sourceFilename: string }>;
  skipped: Array<{ characterId: number; characterName: string; reason: string }>;
}

function PortraitBackfillCard() {
  const { toast } = useToast();
  const [preview, setPreview] = useState<BackfillPreview | null>(null);
  const [result, setResult] = useState<BackfillApplyResult | null>(null);
  const [busy, setBusy] = useState<"preview" | "apply" | null>(null);
  // Per-character selection. Defaults to "checked" for every candidate that
  // has at least one attachment; rows without an attachment can't be applied
  // and stay disabled.
  const [picked, setPicked] = useState<Record<number, boolean>>({});

  async function loadPreview() {
    setBusy("preview");
    setResult(null);
    try {
      const r = await fetch("/api/admin/maintenance/portrait-backfill", { credentials: "include" });
      const body = await r.json();
      if (!r.ok) {
        toast({ title: "Preview failed", description: body.error ?? `HTTP ${r.status}`, variant: "destructive" });
        return;
      }
      setPreview(body as BackfillPreview);
      const defaults: Record<number, boolean> = {};
      for (const c of (body as BackfillPreview).candidates) {
        if (c.attachmentCount > 0) defaults[c.characterId] = true;
      }
      setPicked(defaults);
    } finally {
      setBusy(null);
    }
  }

  async function applySelected() {
    const ids = Object.entries(picked).filter(([, v]) => v).map(([k]) => Number(k));
    if (ids.length === 0) {
      toast({ title: "Nothing selected", description: "Tick at least one row before applying.", variant: "destructive" });
      return;
    }
    const ok = window.confirm(
      `Download ${ids.length} portrait${ids.length === 1 ? "" : "s"} from Discord and save them as the primary portrait?\n\n` +
      `Characters that already have a portrait will be left alone.`,
    );
    if (!ok) return;
    setBusy("apply");
    try {
      const r = await fetch("/api/admin/maintenance/portrait-backfill", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ characterIds: ids }),
      });
      const body = await r.json();
      if (!r.ok) {
        toast({ title: "Backfill failed", description: body.error ?? `HTTP ${r.status}`, variant: "destructive" });
        return;
      }
      setResult(body as BackfillApplyResult);
      toast({
        title: "Portrait backfill complete",
        description: `Saved ${body.applied?.length ?? 0}, skipped ${body.skipped?.length ?? 0}.`,
      });
      await loadPreview();
    } finally {
      setBusy(null);
    }
  }

  const eligible = preview?.candidates.filter((c) => c.attachmentCount > 0) ?? [];
  const noImg = preview?.candidates.filter((c) => c.attachmentCount === 0) ?? [];
  const selectedCount = Object.values(picked).filter(Boolean).length;

  return (
    <Card className="rounded-none border-nc-cyan/40 bg-card/50">
      <CardHeader>
        <CardTitle className="font-display tracking-widest text-nc-cyan">PORTRAIT BACKFILL FROM DISCORD</CardTitle>
        <CardDescription className="font-mono text-xs">
          For every character with no portrait but an <code>imported_from_thread_id</code>,
          fetches the OP message of their #character-sheets thread and offers to download
          the first image attachment as their portrait. Bytes are re-hosted on object
          storage (Discord CDN URLs expire after ~24h, so storing them directly would
          break). Existing portraits are never overwritten.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-3">
          <Button
            type="button"
            onClick={loadPreview}
            disabled={busy !== null}
            className="rounded-none bg-nc-cyan text-background hover:bg-nc-cyan/80 font-display tracking-widest"
            data-testid="button-portrait-preview"
          >
            {busy === "preview" ? "SCANNING DISCORD..." : preview ? "RE-SCAN" : "SCAN DISCORD"}
          </Button>
          {preview && (
            <Button
              type="button"
              onClick={applySelected}
              disabled={busy !== null || selectedCount === 0}
              className="rounded-none bg-destructive text-foreground hover:bg-destructive/80 font-display tracking-widest"
              data-testid="button-portrait-apply"
            >
              {busy === "apply" ? "DOWNLOADING..." : `BACKFILL SELECTED (${selectedCount})`}
            </Button>
          )}
        </div>

        {preview && (
          <div className="space-y-2">
            <div className="text-xs font-mono text-muted-foreground">
              {preview.total} character{preview.total === 1 ? "" : "s"} missing a portrait have a thread on file
              {" · "}{preview.withAttachment} have a recoverable image
            </div>

            {eligible.length > 0 && (
              <div className="space-y-1 max-h-96 overflow-y-auto" data-testid="block-portrait-eligible">
                {eligible.map((c) => {
                  const checked = !!picked[c.characterId];
                  return (
                    <label
                      key={c.characterId}
                      className={`border px-3 py-2 text-xs font-mono flex items-center justify-between gap-3 cursor-pointer ${
                        checked ? "border-nc-cyan/60 text-foreground" : "border-border/40 text-muted-foreground"
                      }`}
                      data-testid={`portrait-row-${c.characterId}`}
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(e) => setPicked((p) => ({ ...p, [c.characterId]: e.target.checked }))}
                          className="accent-nc-cyan"
                        />
                        <div className="min-w-0">
                          <div className="truncate">
                            <span className="text-foreground">{c.characterName}</span>{" "}
                            <span className="opacity-50">[{c.kind}] #{c.characterId}</span>
                          </div>
                          <div className="text-[0.625rem] opacity-70 truncate">
                            {c.firstAttachment?.filename}
                            {c.firstAttachment?.width && c.firstAttachment?.height
                              ? ` · ${c.firstAttachment.width}×${c.firstAttachment.height}`
                              : ""}
                            {c.attachmentCount > 1 ? ` · +${c.attachmentCount - 1} more` : ""}
                          </div>
                        </div>
                      </div>
                    </label>
                  );
                })}
              </div>
            )}

            {noImg.length > 0 && (
              <details className="border border-border/40 px-3 py-2">
                <summary className="text-xs font-mono text-muted-foreground cursor-pointer">
                  {noImg.length} thread{noImg.length === 1 ? "" : "s"} with no recoverable image (expand)
                </summary>
                <div className="mt-2 space-y-1 max-h-48 overflow-y-auto">
                  {noImg.map((c) => (
                    <div key={c.characterId} className="text-[0.625rem] font-mono text-muted-foreground">
                      <span className="text-foreground">{c.characterName}</span>{" "}
                      <span className="opacity-50">[{c.kind}] #{c.characterId}</span>
                      <span className="opacity-70"> — {c.reason ?? "unknown"}</span>
                    </div>
                  ))}
                </div>
              </details>
            )}
          </div>
        )}

        {result && (
          <div className="border-t border-border/50 pt-3 space-y-2" data-testid="block-portrait-apply-result">
            <div className="text-xs font-mono">
              <span className="text-nc-cyan">{result.applied.length} backfilled</span>
              {result.skipped.length > 0 && (
                <span className="text-nc-yellow"> · {result.skipped.length} skipped</span>
              )}
            </div>
            {result.skipped.length > 0 && (
              <div className="space-y-1 max-h-32 overflow-y-auto">
                {result.skipped.map((s) => (
                  <div key={s.characterId} className="text-[0.625rem] font-mono text-nc-yellow border border-nc-yellow/30 px-2 py-1">
                    #{s.characterId} {s.characterName}: {s.reason}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

interface BotImportTableResult { received: number; inserted: number; skippedInvalid: number; chunkFailures: number; note?: string }

interface BotImportResult {
  totals: { inserted: number; skippedInvalid: number; chunkFailures: number };
  tables: Record<string, BotImportTableResult>;
}

function BotImportCard() {
  const { toast } = useToast();
  const [result, setResult] = useState<BotImportResult | null>(null);
  const [busy, setBusy] = useState(false);

  async function runBotImport(file: File) {
    setBusy(true);
    setResult(null);
    try {
      const text = await file.text();
      let body: unknown;
      try { body = JSON.parse(text); } catch (e) {
        toast({ title: "Invalid JSON", description: (e as Error).message, variant: "destructive" });
        return;
      }
      const r = await fetch("/api/admin/maintenance/bot-import", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await r.json();
      if (!r.ok) {
        toast({ title: "Bot import failed", description: data.error ?? `HTTP ${r.status}`, variant: "destructive" });
        return;
      }
      setResult(data as BotImportResult);
      toast({
        title: "Bot DB import complete",
        description: `+${data.totals?.inserted ?? 0} new rows, ${data.totals?.skippedInvalid ?? 0} invalid, ${data.totals?.chunkFailures ?? 0} chunk failures`,
      });
    } finally {
      setBusy(false);
    }
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    await runBotImport(file);
    e.target.value = "";
  }

  return (
    <Card className="rounded-none border-nc-magenta/40 bg-card/50">
      <CardHeader>
        <CardTitle className="font-display tracking-widest text-nc-magenta">BOT DB IMPORT</CardTitle>
        <CardDescription className="font-mono text-xs">
          One-shot import of the legacy Discord bot's database: rent history, cyberware status,
          transaction ledger (balance_history), attendance, store inventory, mission log, tickets, etc.
          Stored as <code>bot_*</code> tables — separate from portal-native data so it stays read-only
          history. Idempotent: each table dedups on its natural key (bot_id, message_id, or composite).
          Upload <code>bot-db-import.json</code> (the file produced from your bot Replit).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-3 items-center">
          <input
            type="file"
            accept="application/json,.json"
            onChange={onFile}
            disabled={busy}
            className="font-mono text-xs"
            data-testid="input-bot-import-file"
          />
          {busy && <span className="text-xs font-mono text-nc-magenta animate-pulse">IMPORTING (may take 1\u20132 min for big payloads)...</span>}
        </div>

        {result && (
          <div className="border-t border-border/50 pt-4 space-y-3" data-testid="block-bot-import-result">
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="border border-nc-magenta/40 bg-nc-magenta/5 p-2">
                <div className="text-2xl font-display text-nc-magenta">{result.totals.inserted}</div>
                <div className="text-xs font-mono text-muted-foreground uppercase">New Rows</div>
              </div>
              <div className="border border-nc-yellow/40 bg-nc-yellow/5 p-2">
                <div className="text-2xl font-display text-nc-yellow">{result.totals.skippedInvalid}</div>
                <div className="text-xs font-mono text-muted-foreground uppercase">Skipped (Invalid)</div>
              </div>
              <div className="border border-destructive/40 bg-destructive/5 p-2">
                <div className="text-2xl font-display text-destructive">{result.totals.chunkFailures}</div>
                <div className="text-xs font-mono text-muted-foreground uppercase">Chunk Failures</div>
              </div>
            </div>
            <div className="space-y-1">
              {Object.entries(result.tables).map(([name, r]) => (
                <div key={name} className="flex items-center justify-between border border-border/50 px-3 py-2 text-xs font-mono">
                  <span className="text-foreground">{name}</span>
                  <span className="text-muted-foreground">
                    {r.received} received, <span className="text-nc-magenta">+{r.inserted} new</span>
                    {r.skippedInvalid > 0 && <span className="text-nc-yellow"> / {r.skippedInvalid} invalid</span>}
                    {r.chunkFailures > 0 && <span className="text-destructive"> / {r.chunkFailures} chunk fail</span>}
                    {r.note && <span className="ml-2 text-muted-foreground/70 italic">({r.note})</span>}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

interface FullImportResult {
  characters: { inserted: number; updated: number; skipped: number; errors: Array<{ name: string; error: string }> };
  character_status: { inserted: number; skipped: number; errors: Array<{ name: string; error: string }> };
  housing: { inserted: number; skipped: number; errors: Array<{ address: string; error: string }> };
  catalog_rent: { inserted: number; skipped: number; errors: Array<{ name: string; error: string }> };
}

function FullMigrationCard() {
  const { toast } = useToast();
  const [result, setResult] = useState<FullImportResult | null>(null);
  const [busy, setBusy] = useState(false);

  async function runFullImport(file: File) {
    setBusy(true);
    setResult(null);
    try {
      const text = await file.text();
      let body: unknown;
      try { body = JSON.parse(text); } catch (e) {
        toast({ title: "Invalid JSON", description: (e as Error).message, variant: "destructive" });
        return;
      }
      const r = await fetch("/api/admin/maintenance/full-import", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await r.json();
      if (!r.ok) {
        toast({ title: "Migration failed", description: data.error ?? `HTTP ${r.status}`, variant: "destructive" });
        return;
      }
      setResult(data as FullImportResult);
      toast({
        title: "Migration complete",
        description: `Chars +${data.characters?.inserted ?? 0}/~${data.characters?.updated ?? 0}, status +${data.character_status?.inserted ?? 0}, housing +${data.housing?.inserted ?? 0}, rent +${data.catalog_rent?.inserted ?? 0}`,
      });
    } finally {
      setBusy(false);
    }
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    await runFullImport(file);
    e.target.value = "";
  }

  return (
    <Card className="rounded-none border-nc-yellow/40 bg-card/50">
      <CardHeader>
        <CardTitle className="font-display tracking-widest text-nc-yellow">FULL DEV → PROD MIGRATION</CardTitle>
        <CardDescription className="font-mono text-xs">
          One-shot import: characters (NPCs + PCs), character status, housing leases, and the housing rent catalog.
          Upload the <code>dev-to-prod-full.json</code> dump generated from the dev workspace. Idempotent:
          safe to re-run. Existing prod rows are preserved (owner assignments never touched, sheet/portrait
          edits only overwritten if the export has a non-empty value).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-3 items-center">
          <input
            type="file"
            accept="application/json,.json"
            onChange={onFile}
            disabled={busy}
            className="font-mono text-xs"
            data-testid="input-full-import-file"
          />
          {busy && <span className="text-xs font-mono text-nc-yellow animate-pulse">IMPORTING (may take 30s)...</span>}
        </div>

        {result && (
          <div className="border-t border-border/50 pt-4 space-y-3" data-testid="block-full-import-result">
            {(["characters", "character_status", "housing", "catalog_rent"] as const).map((k) => {
              const r = result[k];
              if (!r) return null;
              const ins = r.inserted ?? 0;
              const upd = ("updated" in r ? r.updated : 0) ?? 0;
              const skp = r.skipped ?? 0;
              const errs = r.errors ?? [];
              return (
                <div key={k} className="border border-border/50 p-3 space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="font-display tracking-widest text-xs uppercase">{k.replace("_", " ")}</span>
                    <span className="font-mono text-xs text-muted-foreground">
                      +{ins} inserted{("updated" in r) ? `, ~${upd} updated` : ""}, {skp} skipped, {errs.length} errors
                    </span>
                  </div>
                  {errs.length > 0 && (
                    <div className="space-y-1 max-h-32 overflow-y-auto">
                      {errs.slice(0, 20).map((e, i) => (
                        <div key={i} className="text-xs font-mono text-destructive border border-destructive/30 px-2 py-1">
                          <span className="font-bold">{("name" in e ? e.name : e.address) ?? ""}:</span> {e.error}
                        </div>
                      ))}
                      {errs.length > 20 && (
                        <div className="text-xs font-mono text-muted-foreground">+ {errs.length - 20} more errors</div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
