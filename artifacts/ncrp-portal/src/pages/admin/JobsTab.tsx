import { useAdminListJobs, useAdminRunJob, useAdminListBotConfig, useAdminSetBotConfig, getGetMissionConfigQueryKey, useAdminGetLiveMode, getAdminGetLiveModeQueryKey, useAdminSetLiveMode, useAdminGetSiteAccess, getAdminGetSiteAccessQueryKey, useAdminSetSiteAccess, useAdminGetVrchatCalendarSync, getAdminGetVrchatCalendarSyncQueryKey, useAdminSetVrchatCalendarSync, useAdminScanVrchatLinks, type LiveModeUpdate, type VrchatScanResult, getAdminListJobsQueryKey, getAdminListBotConfigQueryKey } from "@workspace/api-client-react";
import { formatDateTime } from "@/lib/format";
import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/apiError";
import { useQueryClient } from "@tanstack/react-query";
import { CHARACTER_SUBMISSIONS_DISABLED_KEY, CYBERWARE_AUTOBILL_KEY, ECONOMY_ENABLED_KEY, HOUSING_AUTOBILL_KEY, LIVE_MODE_SYSTEMS, MISSION_AUTOPAY_KEY } from "./bot-config-constants";

// Site-wide Test/Live switchboard: one master switch + per-system overrides.
// A system performs real external/destructive effects ONLY when BOTH the master
// switch and that system's own switch are Live. In Test mode every system
// simulates/logs what it would have done without sending anything.
export function LiveModeSwitchboard() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data: state, isLoading } = useAdminGetLiveMode();
  const update = useAdminSetLiveMode({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getAdminGetLiveModeQueryKey() });
        // Missions also exposes its effective state via /missions/config, used
        // by the player-facing test-mode banner — refresh it in lockstep.
        qc.invalidateQueries({ queryKey: getGetMissionConfigQueryKey() });
        toast({ title: "Live-mode updated" });
      },
      onError: (err) =>
        toast({ title: "Update failed", description: apiErrorMessage(err, "Update failed"), variant: "destructive" }),
    },
  });
  const master = state?.master === true;
  const set = (patch: LiveModeUpdate) => update.mutate({ data: patch });
  return (
    <div className="space-y-3" data-testid="live-mode-switchboard">
      <div
        className={`flex items-center justify-between gap-4 border p-4 ${master ? "border-nc-magenta bg-nc-magenta/10" : "border-nc-yellow bg-nc-yellow/10"}`}
        data-testid="live-mode-master"
      >
        <div>
          <div className="font-display text-base tracking-widest">
            MASTER:{" "}
            <span className={master ? "text-nc-magenta" : "text-nc-yellow"}>
              {isLoading ? "…" : master ? "LIVE" : "TEST MODE"}
            </span>
          </div>
          <div className="font-mono text-[11px] text-muted-foreground max-w-xl mt-1">
            Global safety switch. While this is TEST, NO system touches live data regardless of its own switch. A system goes live only when this AND its own switch below are both LIVE.
          </div>
        </div>
        <Button
          size="sm"
          disabled={isLoading || update.isPending}
          onClick={() => {
            if (!master && !confirm("Flip the MASTER switch to LIVE? Any system whose own switch is LIVE will start sending real effects.")) return;
            set({ master: !master });
          }}
          className={`rounded-none font-display text-xs ${master ? "bg-nc-yellow text-background" : "bg-nc-magenta text-background"}`}
          data-testid="button-live-mode-master"
        >
          {master ? "SWITCH TO TEST" : "GO LIVE"}
        </Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {LIVE_MODE_SYSTEMS.map((s) => {
          const sys = state?.systems?.[s.key];
          const configured = sys?.configured === true;
          const effective = sys?.effective === true;
          return (
            <div
              key={s.key}
              className="flex items-center justify-between gap-4 border border-border bg-card/30 p-3"
              data-testid={`live-mode-${s.key}`}
            >
              <div>
                <div className="font-display text-sm text-foreground">{s.label}</div>
                <div className="font-mono text-[11px] text-muted-foreground">{s.desc}</div>
                <div className="font-mono text-[11px] mt-1">
                  Effective:{" "}
                  <span className={effective ? "text-nc-magenta" : "text-nc-yellow"}>
                    {isLoading ? "…" : effective ? "LIVE" : "TEST"}
                  </span>
                  {configured && !master ? (
                    <span className="text-muted-foreground"> · switch ON, blocked by master</span>
                  ) : null}
                </div>
              </div>
              <Button
                size="sm"
                disabled={isLoading || update.isPending}
                onClick={() => {
                  if (!configured && !confirm(`Set ${s.label} switch to LIVE? It will send real effects whenever the master switch is also LIVE.`)) return;
                  set({ [s.key]: !configured } as LiveModeUpdate);
                }}
                className={`rounded-none font-display text-xs ${configured ? "bg-nc-yellow text-background" : "bg-nc-magenta text-background"}`}
                data-testid={`button-live-mode-${s.key}`}
              >
                {configured ? "SET TEST" : "SET LIVE"}
              </Button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Staff-only login lockdown. When ON, only ADMIN / FIXER (incl. coordinator) /
// ARCHIVIST may sign in or use the portal; everyone else is blocked at login and
// served a maintenance screen. Mirrors the LiveModeSwitchboard styling.
export function LoginRestrictionCard() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data: state, isLoading } = useAdminGetSiteAccess();
  const update = useAdminSetSiteAccess({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getAdminGetSiteAccessQueryKey() });
        toast({ title: "Login restriction updated" });
      },
      onError: (err) =>
        toast({ title: "Update failed", description: apiErrorMessage(err, "Update failed"), variant: "destructive" }),
    },
  });
  const restricted = state?.loginRestricted === true;
  return (
    <div
      className={`flex items-center justify-between gap-4 border p-4 ${restricted ? "border-nc-magenta bg-nc-magenta/10" : "border-border bg-card/30"}`}
      data-testid="login-restriction"
    >
      <div>
        <div className="font-display text-base tracking-widest">
          STAFF-ONLY LOGIN:{" "}
          <span className={restricted ? "text-nc-magenta" : "text-nc-yellow"}>
            {isLoading ? "…" : restricted ? "RESTRICTED" : "OPEN"}
          </span>
        </div>
        <div className="font-mono text-[11px] text-muted-foreground max-w-xl mt-1">
          When RESTRICTED, only Admins, Fixers (incl. Coordinators) and Archivists can sign in or use the portal. Everyone else is blocked at login and shown a maintenance screen. Use this to take the site offline for players during maintenance.
        </div>
      </div>
      <Button
        size="sm"
        disabled={isLoading || update.isPending}
        onClick={() => {
          if (!restricted && !confirm("Restrict login to staff only? All non-staff members will be signed out of the portal and unable to log back in until you turn this off.")) return;
          update.mutate({ data: { loginRestricted: !restricted } });
        }}
        className={`rounded-none font-display text-xs ${restricted ? "bg-nc-yellow text-background" : "bg-nc-magenta text-background"}`}
        data-testid="button-login-restriction"
      >
        {restricted ? "OPEN TO ALL" : "RESTRICT TO STAFF"}
      </Button>
    </div>
  );
}

// VRChat group-calendar mirror kill-switch. When ON, qualifying website events
// (Main Sessions + social) are cross-posted to the NCRP VRChat group calendar so
// Discord, the website, and VRChat all stay in sync. Independent of the Test/Live
// switchboard; additionally gated server-side by the deployment write-gate + VRChat
// creds. Mirrors the LoginRestrictionCard styling.
export function VrchatCalendarSyncCard() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data: state, isLoading } = useAdminGetVrchatCalendarSync();
  const update = useAdminSetVrchatCalendarSync({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getAdminGetVrchatCalendarSyncQueryKey() });
        toast({ title: "VRChat calendar sync updated" });
      },
      onError: (err) =>
        toast({ title: "Update failed", description: apiErrorMessage(err, "Update failed"), variant: "destructive" }),
    },
  });
  const enabled = state?.enabled === true;
  return (
    <div
      className={`flex items-center justify-between gap-4 border p-4 ${enabled ? "border-nc-cyan bg-nc-cyan/10" : "border-border bg-card/30"}`}
      data-testid="vrchat-calendar-sync"
    >
      <div>
        <div className="font-display text-base tracking-widest">
          VRCHAT CALENDAR SYNC:{" "}
          <span className={enabled ? "text-nc-cyan" : "text-nc-yellow"}>
            {isLoading ? "…" : enabled ? "ON" : "OFF"}
          </span>
        </div>
        <div className="font-mono text-[11px] text-muted-foreground max-w-xl mt-1">
          When ON, Main Sessions and social events are cross-posted to the NCRP VRChat group calendar (missions are never synced). The website stays the source of truth. Live cross-posting only happens in the deployed environment with VRChat credentials configured.
        </div>
      </div>
      <Button
        size="sm"
        disabled={isLoading || update.isPending}
        onClick={() => update.mutate({ data: { enabled: !enabled } })}
        className={`rounded-none font-display text-xs ${enabled ? "bg-nc-yellow text-background" : "bg-nc-cyan text-background"}`}
        data-testid="button-vrchat-calendar-sync"
      >
        {enabled ? "DISABLE" : "ENABLE"}
      </Button>
    </div>
  );
}

// Admin kill switch for new player-character submissions. When DISABLED,
// players cannot submit new PCs for review; editing existing characters and
// creating NPCs (fixers/admins) stay available. Stored as a plain bot_config
// flag, so it reuses the generic bot-config endpoints rather than a bespoke one.
export function CharacterSubmissionsCard() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data: rows, isLoading } = useAdminListBotConfig();
  const update = useAdminSetBotConfig({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getAdminListBotConfigQueryKey() });
        toast({ title: "Character submissions updated" });
      },
      onError: (err) =>
        toast({ title: "Update failed", description: apiErrorMessage(err, "Update failed"), variant: "destructive" }),
    },
  });
  const disabled = rows?.find((r) => r.key === CHARACTER_SUBMISSIONS_DISABLED_KEY)?.value === true;
  return (
    <div
      className={`flex items-center justify-between gap-4 border p-4 ${disabled ? "border-nc-magenta bg-nc-magenta/10" : "border-border bg-card/30"}`}
      data-testid="character-submissions"
    >
      <div>
        <div className="font-display text-base tracking-widest">
          NEW CHARACTER SUBMISSIONS:{" "}
          <span className={disabled ? "text-nc-magenta" : "text-nc-yellow"}>
            {isLoading ? "…" : disabled ? "DISABLED" : "OPEN"}
          </span>
        </div>
        <div className="font-mono text-[11px] text-muted-foreground max-w-xl mt-1">
          When DISABLED, players can't submit new player characters for review. Editing existing characters and creating NPCs (fixers/admins) stay available.
        </div>
      </div>
      <Button
        size="sm"
        disabled={isLoading || update.isPending}
        onClick={() => update.mutate({ key: CHARACTER_SUBMISSIONS_DISABLED_KEY, data: { value: !disabled } })}
        className={`rounded-none font-display text-xs ${disabled ? "bg-nc-yellow text-background" : "bg-nc-magenta text-background"}`}
        data-testid="button-character-submissions"
      >
        {disabled ? "ALLOW SUBMISSIONS" : "DISABLE SUBMISSIONS"}
      </Button>
    </div>
  );
}

function VrchatScanButton() {
  const { toast } = useToast();
  const [result, setResult] = useState<VrchatScanResult | null>(null);
  const scan = useAdminScanVrchatLinks({
    mutation: {
      onSuccess: (r) => {
        setResult(r);
        toast({ title: "VRChat links refreshed", description: `${r.linkedPlayers} players linked from ${r.scannedMessages} messages.` });
      },
      onError: (err) =>
        toast({ title: "Scan failed", description: apiErrorMessage(err, "Scan failed"), variant: "destructive" }),
    },
  });
  return (
    <div className="flex items-center justify-between gap-4 border border-border bg-card/30 p-4" data-testid="vrchat-scan">
      <div>
        <div className="font-display text-sm text-foreground">VRChat Username Sync</div>
        <div className="font-mono text-[11px] text-muted-foreground max-w-xl mt-1">
          Re-scrapes the VRChat username channel and refreshes the Discord↔VRChat links shown on the character directory and player profiles.
        </div>
        {result ? (
          <div className="font-mono text-[11px] text-nc-cyan mt-1" data-testid="vrchat-scan-result">
            Last scan: {result.linkedPlayers} linked · {result.matchedMessages} matched · {result.scannedMessages} scanned
          </div>
        ) : null}
      </div>
      <Button
        size="sm"
        disabled={scan.isPending}
        onClick={() => scan.mutate()}
        className="rounded-none font-display text-xs bg-nc-cyan text-background"
        data-testid="button-vrchat-scan"
      >
        {scan.isPending ? "SCANNING…" : "RESCAN"}
      </Button>
    </div>
  );
}

function AutobillSwitch({
  configKey,
  label,
  description,
  rows,
  onToggle,
  pending,
}: {
  configKey: string;
  label: string;
  description: string;
  rows: Array<{ key: string; value: unknown }> | undefined;
  onToggle: (next: boolean) => void;
  pending: boolean;
}) {
  const row = rows?.find((r) => r.key === configKey);
  const enabled = row?.value === true;
  return (
    <div className="flex items-center justify-between gap-4 border border-border bg-card/30 p-3" data-testid={`autobill-${configKey}`}>
      <div>
        <div className="font-display text-sm text-foreground">{label}</div>
        <div className="font-mono text-[11px] text-muted-foreground">{description}</div>
        <div className="font-mono text-[11px] mt-1">
          State:{" "}
          <span className={enabled ? "text-nc-cyan" : "text-destructive"}>
            {enabled ? "ENABLED" : "DISABLED"}
          </span>
        </div>
      </div>
      <Button
        size="sm"
        disabled={pending}
        onClick={() => onToggle(!enabled)}
        className={`rounded-none font-display text-xs ${enabled ? "bg-destructive text-background" : "bg-nc-cyan text-background"}`}
        data-testid={`button-autobill-toggle-${configKey}`}
      >
        {enabled ? "DISABLE" : "ENABLE"}
      </Button>
    </div>
  );
}

export function JobsTab() {
  const { data: jobs, isLoading } = useAdminListJobs();
  const runJob = useAdminRunJob();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: flagRows } = useAdminListBotConfig();
  const setFlag = useAdminSetBotConfig({
    mutation: {
      onSuccess: () => queryClient.invalidateQueries({ queryKey: getAdminListBotConfigQueryKey() }),
      onError: (err) => toast({ title: "Flag update failed", description: apiErrorMessage(err, "Flag update failed"), variant: "destructive" }),
    },
  });

  const handleRunJob = (jobId: "cyberware_humanity" | "monthly_rent" | "role_sync" | "eviction_sweep" | "discord_event_sync" | "mission_thread_backfill") => {
    runJob.mutate({ data: { job: jobId } }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getAdminListJobsQueryKey() });
        toast({ title: "Job Dispatched", description: `Task ${jobId} initiated.` });
      },
      onError: (err) => {
        toast({ title: "Job Failed", description: apiErrorMessage(err, "Job failed"), variant: "destructive" });
      }
    });
  };

  return (
    <Card className="rounded-none border-border bg-card/50">
      <CardHeader>
        <CardTitle className="font-display text-nc-cyan">System Jobs</CardTitle>
        <CardDescription className="font-mono">
          Kill switches gate the scheduled cron. Manual buttons run on demand, but money/destructive jobs still respect the Test/Live switches above — nothing touches live data unless both the master and that system are LIVE.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-8">
        <LiveModeSwitchboard />
        <LoginRestrictionCard />
        <VrchatCalendarSyncCard />
        <CharacterSubmissionsCard />
        <VrchatScanButton />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <AutobillSwitch
            configKey={ECONOMY_ENABLED_KEY}
            label="Economy System"
            description="Master kill switch for the whole economy. While DISABLED, wallet moves and the income WORK/SLUT commands all fail. Enable this first, then set Economy to LIVE above for real eddies to move."
            rows={flagRows}
            pending={setFlag.isPending}
            onToggle={(next) => setFlag.mutate({ key: ECONOMY_ENABLED_KEY, data: { value: next } })}
          />
          <AutobillSwitch
            configKey={HOUSING_AUTOBILL_KEY}
            label="Housing Autobill"
            description="Gates the monthly_rent cron (housing rent + monthly personal fees). 04:00 UTC on the 1st."
            rows={flagRows}
            pending={setFlag.isPending}
            onToggle={(next) => setFlag.mutate({ key: HOUSING_AUTOBILL_KEY, data: { value: next } })}
          />
          <AutobillSwitch
            configKey={CYBERWARE_AUTOBILL_KEY}
            label="Cyberware Autobill"
            description="Gates the cyberware_humanity cron (weekly cyberpsychosis meds). Mondays 05:00 UTC."
            rows={flagRows}
            pending={setFlag.isPending}
            onToggle={(next) => setFlag.mutate({ key: CYBERWARE_AUTOBILL_KEY, data: { value: next } })}
          />
          <AutobillSwitch
            configKey={MISSION_AUTOPAY_KEY}
            label="Mission Auto-Pay"
            description="Gates the mission_autopay cron (auto player payout + attendance after the delay window). Every 15 min."
            rows={flagRows}
            pending={setFlag.isPending}
            onToggle={(next) => setFlag.mutate({ key: MISSION_AUTOPAY_KEY, data: { value: next } })}
          />
        </div>

        <div className="flex gap-4">
          <Button onClick={() => handleRunJob("cyberware_humanity")} disabled={runJob.isPending} className="rounded-none font-display border border-nc-cyan text-nc-cyan hover:bg-nc-cyan hover:text-background" variant="outline" data-testid="btn-job-cyberware">
            Update Humanity
          </Button>
          <Button onClick={() => handleRunJob("monthly_rent")} disabled={runJob.isPending} className="rounded-none font-display border border-nc-magenta text-nc-magenta hover:bg-nc-magenta hover:text-background" variant="outline" data-testid="btn-job-rent">
            Process Rent
          </Button>
          <Button onClick={() => handleRunJob("role_sync")} disabled={runJob.isPending} className="rounded-none font-display border border-nc-yellow text-nc-yellow hover:bg-nc-yellow hover:text-background" variant="outline" data-testid="btn-job-sync">
            Sync Roles
          </Button>
          <Button onClick={() => handleRunJob("discord_event_sync")} disabled={runJob.isPending} className="rounded-none font-display border border-nc-cyan text-nc-cyan hover:bg-nc-cyan hover:text-background" variant="outline" data-testid="btn-job-event-sync">
            Sync Events
          </Button>
          <Button onClick={() => handleRunJob("mission_thread_backfill")} disabled={runJob.isPending} className="rounded-none font-display border border-nc-magenta text-nc-magenta hover:bg-nc-magenta hover:text-background" variant="outline" data-testid="btn-job-mission-thread-backfill">
            Backfill Mission Threads
          </Button>
        </div>
        
        {isLoading ? (
          <div className="text-nc-cyan font-mono animate-pulse">Loading jobs...</div>
        ) : (
          <div className="rounded-md border border-border mt-4">
            <Table>
              <TableHeader className="bg-muted/50">
                <TableRow className="hover:bg-transparent">
                  <TableHead className="font-display text-nc-cyan">Job</TableHead>
                  <TableHead className="font-display text-nc-cyan">Status</TableHead>
                  <TableHead className="font-display text-nc-cyan">Message</TableHead>
                  <TableHead className="font-display text-nc-cyan">Started</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody className="font-mono text-sm">
                {jobs?.map((j: any) => (
                  <TableRow key={j.id} className="hover:bg-muted/50 border-border" data-testid={`row-job-${j.id}`}>
                    <TableCell className="font-medium text-foreground">{j.job}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className={`rounded-none text-[0.625rem] px-1 py-0 ${j.status === 'success' ? 'border-nc-cyan text-nc-cyan' : j.status === 'failed' ? 'border-destructive text-destructive' : 'border-nc-yellow text-nc-yellow'}`}>
                        {j.status.toUpperCase()}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{j.message || '-'}</TableCell>
                    <TableCell className="text-muted-foreground">{formatDateTime(j.startedAt)}</TableCell>
                  </TableRow>
                ))}
                {!jobs?.length && (
                  <TableRow>
                    <TableCell colSpan={4} className="text-center text-muted-foreground h-24">NO DATA</TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
