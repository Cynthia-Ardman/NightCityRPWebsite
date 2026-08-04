import { formatDate, formatEddies } from "@/lib/format";
import { useState } from "react";
import { Link } from "wouter";
import {
  useAdminGetAnalytics,
  getAdminGetAnalyticsQueryKey,
  type AdminGetAnalyticsRange,
  useAdminGetAnalyticsCharacters,
  getAdminGetAnalyticsCharactersQueryKey,
  type AdminGetAnalyticsCharactersBucket,
  useAdminGetMembershipGrowth,
  getAdminGetMembershipGrowthQueryKey,
  type AdminGetMembershipGrowthRange,
} from "@workspace/api-client-react";
import { useEffectiveMe } from "@/contexts/ViewAsContext";
import FixerActivityTab from "@/components/admin/FixerActivityTab";
import {
  CharacterTrendDialog,
  VrchatInstancesDialog,
  MissionsWeekDialog,
  EconomyWeekDialog,
  type VrchatDrillTarget,
} from "@/components/admin/AnalyticsDrilldowns";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Activity, Coins, Briefcase, ClipboardList, Users, Globe } from "lucide-react";
import VrchatPlayerSearch from "@/components/fixer/VrchatPlayerSearch";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  LineChart,
  Line,
  ComposedChart,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  CartesianGrid,
} from "recharts";

type RangeKey = "4w" | "3m" | "1y" | "all";

const RANGES: Array<{ key: RangeKey; label: string }> = [
  { key: "4w", label: "4 WEEKS" },
  { key: "3m", label: "3 MONTHS" },
  { key: "1y", label: "1 YEAR" },
  { key: "all", label: "ALL TIME" },
];

const CATEGORY_COLORS: Record<string, string> = {
  mission: "#00f0ff",
  rent: "#ff2ec4",
  cyberware: "#f5d90a",
  business: "#7dff6a",
  membership: "#b17aff",
  fee: "#ff8a3d",
  purchase: "#5aa2ff",
  sink: "#ff5a5a",
  other: "#9aa0a6",
};

const AGE_LABELS: Array<{ key: "under1d" | "d1to3" | "d3to7" | "d7to30" | "over30"; label: string }> = [
  { key: "under1d", label: "<1d" },
  { key: "d1to3", label: "1–3d" },
  { key: "d3to7", label: "3–7d" },
  { key: "d7to30", label: "7–30d" },
  { key: "over30", label: ">30d" },
];

function fmtWeek(iso: string): string {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function fmtMonth(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: "short", year: "2-digit" });
}


const tooltipStyle = {
  backgroundColor: "hsl(240 10% 8%)",
  // Recharts tooltip labels default to black — force light text on the dark panel.
  color: "hsl(var(--foreground))",
  border: "1px solid hsl(240 6% 25%)",
  borderRadius: 0,
  fontFamily: "monospace",
  fontSize: "0.75rem",
} as const;

const BUCKET_TITLES: Record<AdminGetAnalyticsCharactersBucket, string> = {
  active60: "ACTIVE (60d)",
  dormant: "DORMANT",
  active: "ACTIVE",
  loa: "LOA",
  dead: "DEAD",
  retired: "RETIRED",
  missing: "MISSING",
};

function CharacterBucketDialog({ bucket, onClose }: { bucket: AdminGetAnalyticsCharactersBucket | null; onClose: () => void }) {
  const params = { bucket: (bucket ?? "active60") as AdminGetAnalyticsCharactersBucket };
  const { data, isLoading } = useAdminGetAnalyticsCharacters(params, {
    query: { enabled: bucket !== null, queryKey: getAdminGetAnalyticsCharactersQueryKey(params) },
  });
  return (
    <Dialog open={bucket !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg rounded-none border-border bg-card font-mono">
        <DialogHeader>
          <DialogTitle className="font-display tracking-widest text-base">
            {bucket ? BUCKET_TITLES[bucket] : ""} {data ? `— ${data.length}` : ""}
          </DialogTitle>
        </DialogHeader>
        <div className="max-h-[60vh] overflow-y-auto divide-y divide-border/50 text-sm" data-testid="list-bucket-characters">
          {isLoading && <div className="py-6 text-center text-muted-foreground text-xs">LOADING…</div>}
          {!isLoading && (data?.length ?? 0) === 0 && (
            <div className="py-6 text-center text-muted-foreground text-xs">No characters in this bucket.</div>
          )}
          {data?.map((c) => (
            <Link
              key={c.id}
              href={`/characters/${c.id}`}
              className="flex items-center justify-between gap-3 px-1 py-2 hover:bg-accent/40"
              data-testid={`link-bucket-char-${c.id}`}
            >
              <span className="truncate text-foreground">{c.name}</span>
              <span className="text-xs text-muted-foreground whitespace-nowrap">
                {c.ownerName ?? "unclaimed"}
                {c.lastActivityAt && ` · ${formatDate(c.lastActivityAt)}`}
              </span>
            </Link>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// Community growth: weekly Discord/VRChat joins & leaves with a net-change
// line, from membership_events (welcome + Dyno logs; VRChat group audit log).
function GrowthCard({ range }: { range: RangeKey }) {
  const params = { range: range as AdminGetMembershipGrowthRange };
  const { data, isLoading } = useAdminGetMembershipGrowth(params, {
    query: { queryKey: getAdminGetMembershipGrowthQueryKey(params) },
  });
  const rows = (data?.weeks ?? []).map((w) => ({
    week: range === "1y" || range === "all" ? fmtMonth(w.weekStart) : fmtWeek(w.weekStart),
    discordJoins: w.discordJoins,
    discordLeaves: -w.discordLeaves,
    discordNet: w.discordJoins - w.discordLeaves,
    vrchatJoins: w.vrchatJoins,
    vrchatLeaves: -w.vrchatLeaves,
    vrchatNet: w.vrchatJoins - w.vrchatLeaves,
  }));
  const hasVrchat = (data?.weeks ?? []).some((w) => w.vrchatJoins || w.vrchatLeaves);
  const totals = (data?.weeks ?? []).reduce(
    (a, w) => ({
      dj: a.dj + w.discordJoins,
      dl: a.dl + w.discordLeaves,
      vj: a.vj + w.vrchatJoins,
      vl: a.vl + w.vrchatLeaves,
    }),
    { dj: 0, dl: 0, vj: 0, vl: 0 },
  );
  const fmtNet = (n: number) => (n >= 0 ? `+${n}` : `${n}`);
  return (
    <Card className="rounded-none border-border bg-card/50">
      <CardHeader>
        <CardTitle className="font-display tracking-widest flex items-center gap-2">
          <Users className="w-4 h-4 text-nc-green" /> COMMUNITY GROWTH — JOINS VS LEAVES / WEEK
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <p className="font-mono text-muted-foreground italic">LOADING…</p>
        ) : rows.length === 0 ? (
          <p className="font-mono text-muted-foreground italic">No membership events recorded in this range yet.</p>
        ) : (
          <>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 font-mono text-sm">
              <div className="border border-border p-3">
                <div className="text-xs text-muted-foreground">DISCORD JOINS</div>
                <div className="text-2xl text-nc-cyan" data-testid="stat-growth-discord-joins">{totals.dj}</div>
              </div>
              <div className="border border-border p-3">
                <div className="text-xs text-muted-foreground">DISCORD LEAVES</div>
                <div className="text-2xl text-nc-magenta" data-testid="stat-growth-discord-leaves">{totals.dl}</div>
              </div>
              <div className="border border-border p-3">
                <div className="text-xs text-muted-foreground">DISCORD NET</div>
                <div className={`text-2xl ${totals.dj - totals.dl >= 0 ? "text-nc-green" : "text-nc-magenta"}`} data-testid="stat-growth-discord-net">
                  {fmtNet(totals.dj - totals.dl)}
                </div>
              </div>
              <div className="border border-border p-3">
                <div className="text-xs text-muted-foreground">VRCHAT NET</div>
                <div className={`text-2xl ${totals.vj - totals.vl >= 0 ? "text-nc-green" : "text-nc-magenta"}`} data-testid="stat-growth-vrchat-net">
                  {hasVrchat ? fmtNet(totals.vj - totals.vl) : "—"}
                </div>
              </div>
            </div>
            <div>
              <p className="font-mono text-xs text-muted-foreground mb-1">DISCORD SERVER</p>
              <div className="h-64" data-testid="chart-growth-discord">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={rows} stackOffset="sign">
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(240 6% 20%)" />
                    <XAxis dataKey="week" tick={{ fontSize: 11, fontFamily: "monospace" }} />
                    <YAxis tick={{ fontSize: 11, fontFamily: "monospace" }} allowDecimals={false} />
                    <Tooltip contentStyle={tooltipStyle} formatter={(v: number, name: string) => [name === "leaves" ? Math.abs(v) : v, name]} />
                    <Legend />
                    <Bar dataKey="discordJoins" name="joins" stackId="flow" fill="#7dff6a" />
                    <Bar dataKey="discordLeaves" name="leaves" stackId="flow" fill="#ff5a5a" />
                    <Line type="monotone" dataKey="discordNet" name="net" stroke="#00f0ff" strokeWidth={2} dot={false} />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </div>
            {hasVrchat && (
              <div>
                <p className="font-mono text-xs text-muted-foreground mb-1">VRCHAT GROUP</p>
                <div className="h-64" data-testid="chart-growth-vrchat">
                  <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart data={rows} stackOffset="sign">
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(240 6% 20%)" />
                      <XAxis dataKey="week" tick={{ fontSize: 11, fontFamily: "monospace" }} />
                      <YAxis tick={{ fontSize: 11, fontFamily: "monospace" }} allowDecimals={false} />
                      <Tooltip contentStyle={tooltipStyle} formatter={(v: number, name: string) => [name === "leaves" ? Math.abs(v) : v, name]} />
                      <Legend />
                      <Bar dataKey="vrchatJoins" name="joins" stackId="flow" fill="#7dff6a" />
                      <Bar dataKey="vrchatLeaves" name="leaves" stackId="flow" fill="#ff5a5a" />
                      <Line type="monotone" dataKey="vrchatNet" name="net" stroke="#00f0ff" strokeWidth={2} dot={false} />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
              </div>
            )}
          </>
        )}
        <p className="font-mono text-xs text-muted-foreground">
          Discord joins come from the welcome channel and Dyno logs
          {data?.coverage.discordLeaveSince && ` — leave tracking starts ${formatDate(data.coverage.discordLeaveSince)}`}
          {data?.coverage.vrchatSince
            ? `; VRChat group joins/leaves tracked from ${formatDate(data.coverage.vrchatSince)} (audit log).`
            : "; VRChat group tracking starts once the live audit-log poller has run."}
        </p>
      </CardContent>
    </Card>
  );
}

export default function FixerAnalytics() {
  const { data: user, isLoading: userLoading } = useEffectiveMe();
  const [range, setRange] = useState<RangeKey>("3m");
  const [excludeInput, setExcludeInput] = useState("");
  const [excludeAbove, setExcludeAbove] = useState<number | null>(null);
  const [charBucket, setCharBucket] = useState<AdminGetAnalyticsCharactersBucket | null>(null);
  const [trendWeek, setTrendWeek] = useState<string | null>(null);
  const [vrTarget, setVrTarget] = useState<VrchatDrillTarget | null>(null);
  const [missionWeek, setMissionWeek] = useState<string | null>(null);
  const [econWeek, setEconWeek] = useState<string | null>(null);
  // Player analytics: any fixer (incl. coordinators) or admin.
  const canPlayer = !!user && (user.isFixer || user.isAdmin);
  // Fixer activity report: leadership only — admin / coordinator / archivist.
  const canFixer = !!user && (user.isAdmin || user.isCoordinator || user.isArchivist);
  const [tab, setTab] = useState<"player" | "fixer" | null>(null);
  // Default to the first tab the viewer may see (archivists without the fixer
  // role only get the FIXER tab).
  const activeTab = tab ?? (canPlayer ? "player" : "fixer");
  const params = { range: range as AdminGetAnalyticsRange, ...(excludeAbove !== null ? { excludeAbove } : {}) };
  const { data, isLoading } = useAdminGetAnalytics(params, {
    query: { enabled: canPlayer && activeTab === "player", queryKey: getAdminGetAnalyticsQueryKey(params) },
  });

  const applyExclude = () => {
    const n = Number(excludeInput.replace(/[,\s]/g, ""));
    setExcludeAbove(Number.isFinite(n) && n > 0 ? Math.floor(n) : null);
  };

  if (userLoading) return null;
  if (!canPlayer && !canFixer) {
    return (
      <div className="max-w-7xl mx-auto py-12 text-center font-mono text-muted-foreground">
        Staff access required.
      </div>
    );
  }

  const tabButton = (key: "player" | "fixer", label: string) => (
    <button
      onClick={() => setTab(key)}
      data-testid={`tab-analytics-${key}`}
      className={`px-4 py-2 font-display uppercase tracking-widest text-sm border-b-2 transition-colors ${
        activeTab === key
          ? "border-nc-cyan text-nc-cyan bg-nc-cyan/10"
          : "border-transparent text-muted-foreground hover:text-foreground"
      }`}
    >
      {label}
    </button>
  );

  if (activeTab === "fixer") {
    return (
      <div className="max-w-7xl mx-auto space-y-6 pb-12">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-4xl font-display flex items-center gap-3" data-testid="text-analytics-title">
            <Activity className="w-7 h-7 text-nc-cyan" /> SERVER ANALYTICS
          </h1>
          <Link href="/fixer" className="text-nc-magenta font-mono text-xs hover:underline">
            ← fixer hub
          </Link>
        </div>
        <div className="flex items-center gap-1 border-b border-border">
          {canPlayer && tabButton("player", "Players")}
          {canFixer && tabButton("fixer", "Fixers")}
        </div>
        <FixerActivityTab />
      </div>
    );
  }

  // Flatten economy weekly rows for stacked bars: one row per week with
  // created_<cat> positive and destroyed_<cat> series.
  const econCategories = new Set<string>();
  const econRows = (data?.economy.weekly ?? []).map((w) => {
    const row: Record<string, number | string> = { week: fmtWeek(w.weekStart), weekStart: w.weekStart };
    let created = 0;
    let destroyed = 0;
    for (const [cat, amt] of Object.entries(w.created)) {
      econCategories.add(cat);
      row[`created_${cat}`] = amt;
      created += amt;
    }
    for (const [cat, amt] of Object.entries(w.destroyed)) {
      econCategories.add(cat);
      row[`destroyed_${cat}`] = -amt;
      destroyed += amt;
    }
    row.net = created - destroyed;
    return row;
  });
  const cats = [...econCategories].sort();

  const supplyRows = (data?.economy.supply ?? []).map((p) => ({
    week: fmtWeek(p.weekStart),
    total: p.total,
  }));

  const missionRows = (data?.missions.weekly ?? []).map((w) => ({
    week: fmtWeek(w.weekStart),
    weekStart: w.weekStart,
    missions: w.missionsRun,
    payout: w.payoutTotal,
    playerPayout: w.playerPayout ?? 0,
    actorPayout: w.actorPayout ?? 0,
  }));

  const sheetRows = (data?.players.sheetsPerMonth ?? []).map((m) => ({
    month: fmtMonth(m.month),
    count: m.count,
  }));

  const lifeEntries = Object.entries(data?.players.lifeStatus ?? {}).sort((a, b) => b[1] - a[1]);

  const vrWeeklyRows = (data?.vrchat.weekly ?? []).map((w) => ({
    week: fmtWeek(w.weekStart),
    weekStart: w.weekStart,
    instances: w.sessions,
    hours: w.hours,
  }));

  const trendRows = (data?.players.activityTrend ?? []).map((w) => ({
    week: fmtWeek(w.weekStart),
    weekStart: w.weekStart,
    active: w.active,
    dormant: w.dormant,
    gained: w.gained,
    lost: w.lost,
  }));

  const pickWeek = (st: unknown): string | null => {
    const payload = (st as { activePayload?: Array<{ payload?: { weekStart?: string } }> } | null)?.activePayload?.[0]?.payload;
    return payload?.weekStart ?? null;
  };

  const siteRows = (data?.site.weekly ?? []).map((w) => ({
    week: fmtWeek(w.weekStart),
    activeUsers: w.activeUsers,
    logins: w.logins,
    pageHits: w.pageHits,
    created: w.charactersCreated,
    edits: w.characterEdits,
  }));
  const trackingSince = data?.site.trackingSince ?? null;

  return (
    <div className="max-w-7xl mx-auto space-y-6 pb-12">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-4xl font-display flex items-center gap-3" data-testid="text-analytics-title">
          <Activity className="w-7 h-7 text-nc-cyan" /> SERVER ANALYTICS
        </h1>
        <div className="flex items-center gap-2">
          {RANGES.map((r) => (
            <button
              key={r.key}
              onClick={() => setRange(r.key)}
              data-testid={`button-range-${r.key}`}
              className={`px-3 py-1 font-mono text-xs border transition-colors ${
                range === r.key
                  ? "border-nc-cyan text-nc-cyan bg-nc-cyan/10"
                  : "border-border text-muted-foreground hover:text-foreground"
              }`}
            >
              {r.label}
            </button>
          ))}
          <Link href="/fixer" className="ml-2 text-nc-magenta font-mono text-xs hover:underline">
            ← fixer hub
          </Link>
        </div>
      </div>

      <div className="flex items-center gap-1 border-b border-border">
        {canPlayer && tabButton("player", "Players")}
        {canFixer && tabButton("fixer", "Fixers")}
      </div>

      <div className="flex flex-wrap items-center gap-2 font-mono text-xs">
        <span className="text-muted-foreground">EXCLUDE WALLETS ABOVE</span>
        <input
          type="text"
          inputMode="numeric"
          value={excludeInput}
          onChange={(e) => setExcludeInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") applyExclude();
          }}
          placeholder="e.g. 1,000,000"
          data-testid="input-exclude-above"
          className="w-36 bg-background border border-border px-2 py-1 font-mono text-xs focus:outline-none focus:border-nc-cyan"
        />
        <button
          onClick={applyExclude}
          data-testid="button-apply-exclude"
          className="px-3 py-1 border border-nc-cyan text-nc-cyan hover:bg-nc-cyan/10 transition-colors"
        >
          APPLY
        </button>
        {excludeAbove !== null && (
          <>
            <button
              onClick={() => {
                setExcludeInput("");
                setExcludeAbove(null);
              }}
              data-testid="button-clear-exclude"
              className="px-3 py-1 border border-border text-muted-foreground hover:text-foreground transition-colors"
            >
              CLEAR
            </button>
            <span className="text-nc-yellow" data-testid="text-excluded-wallets">
              {typeof data?.excludedWallets === "number"
                ? `${data.excludedWallets} wallet${data.excludedWallets === 1 ? "" : "s"} above ${formatEddies(excludeAbove)} excluded from economy charts`
                : `filtering wallets above ${formatEddies(excludeAbove)}…`}
            </span>
          </>
        )}
      </div>

      {isLoading || !data ? (
        <div className="font-mono text-nc-cyan animate-pulse py-12 text-center">Crunching server data...</div>
      ) : (
        <>
          {/* -------------------------- WEBSITE ACTIVITY -------------------------- */}
          <Card className="rounded-none border-border bg-card/50">
            <CardHeader>
              <CardTitle className="font-display tracking-widest flex items-center gap-2">
                <Globe className="w-4 h-4 text-nc-cyan" /> WEBSITE ACTIVITY / WEEK
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 font-mono text-xs">
                <div className="border border-border p-3">
                  <div className="text-muted-foreground">ACTIVE USERS</div>
                  <div className="text-2xl text-nc-cyan" data-testid="stat-site-active-users">{data.site.totalActiveUsers}</div>
                </div>
                <div className="border border-border p-3">
                  <div className="text-muted-foreground">LOGINS</div>
                  <div className="text-2xl text-nc-magenta" data-testid="stat-site-logins">{data.site.totalLogins}</div>
                </div>
                <div className="border border-border p-3">
                  <div className="text-muted-foreground">CHARACTERS CREATED</div>
                  <div className="text-2xl text-nc-yellow" data-testid="stat-site-chars-created">{data.site.totalCharactersCreated}</div>
                </div>
                <div className="border border-border p-3">
                  <div className="text-muted-foreground">CHARACTER EDITS</div>
                  <div className="text-2xl text-nc-cyan" data-testid="stat-site-char-edits">{data.site.totalCharacterEdits}</div>
                </div>
              </div>

              {siteRows.length === 0 ? (
                <p className="font-mono text-muted-foreground italic">No website activity recorded in this range yet.</p>
              ) : (
                <>
                  <div>
                    <p className="font-mono text-xs text-muted-foreground mb-1">VISITORS &amp; LOGINS</p>
                    <div className="h-64" data-testid="chart-site-users">
                      <ResponsiveContainer width="100%" height="100%">
                        <LineChart data={siteRows}>
                          <CartesianGrid strokeDasharray="3 3" stroke="hsl(240 6% 20%)" />
                          <XAxis dataKey="week" tick={{ fontSize: 11, fontFamily: "monospace" }} />
                          <YAxis tick={{ fontSize: 11, fontFamily: "monospace" }} allowDecimals={false} />
                          <YAxis yAxisId="hits" orientation="right" tick={{ fontSize: 11, fontFamily: "monospace" }} tickFormatter={(v: number) => v.toLocaleString()} />
                          <Tooltip contentStyle={tooltipStyle} formatter={(v: number, name: string) => [v.toLocaleString(), name]} />
                          <Legend />
                          <Line type="monotone" dataKey="activeUsers" name="active users" stroke="#00f0ff" strokeWidth={2} dot={false} />
                          <Line type="monotone" dataKey="logins" name="logins" stroke="#ff2ec4" strokeWidth={2} dot={false} />
                          <Line yAxisId="hits" type="monotone" dataKey="pageHits" name="page activity (right)" stroke="#f5d90a" strokeWidth={1.5} dot={false} strokeDasharray="4 3" />
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                  </div>
                  <div>
                    <p className="font-mono text-xs text-muted-foreground mb-1">CHARACTERS CREATED &amp; EDIT SUBMISSIONS</p>
                    <div className="h-64" data-testid="chart-site-characters">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={siteRows}>
                          <CartesianGrid strokeDasharray="3 3" stroke="hsl(240 6% 20%)" />
                          <XAxis dataKey="week" tick={{ fontSize: 11, fontFamily: "monospace" }} />
                          <YAxis tick={{ fontSize: 11, fontFamily: "monospace" }} allowDecimals={false} />
                          <Tooltip contentStyle={tooltipStyle} />
                          <Legend />
                          <Bar dataKey="created" name="characters created" fill="#f5d90a" />
                          <Bar dataKey="edits" name="edit submissions" fill="#7dff6a" />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  </div>
                </>
              )}
              <p className="font-mono text-xs text-muted-foreground">
                {trackingSince
                  ? `Visitor / login / page-activity tracking started ${formatDate(trackingSince)} — earlier weeks show zero for those series. Character series cover full history; bulk-imported legacy characters are excluded from "characters created".`
                  : 'Visitor / login / page-activity tracking just went live — data accrues from today onward. Character series cover full history; bulk-imported legacy characters are excluded from "characters created".'}
              </p>
            </CardContent>
          </Card>

          {/* --------------------------- COMMUNITY GROWTH --------------------------- */}
          <GrowthCard range={range} />

          {/* ------------------------------ ECONOMY ------------------------------ */}
          <Card className="rounded-none border-border bg-card/50">
            <CardHeader>
              <CardTitle className="font-display tracking-widest flex items-center gap-2">
                <Coins className="w-4 h-4 text-nc-yellow" /> ECONOMY — CREATED VS DESTROYED / WEEK
              </CardTitle>
            </CardHeader>
            <CardContent>
              {econRows.length === 0 ? (
                <p className="font-mono text-muted-foreground italic">No wallet activity in this range.</p>
              ) : (
                <div className="h-80 cursor-pointer" data-testid="chart-economy-weekly">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={econRows} stackOffset="sign" onClick={(st) => setEconWeek(pickWeek(st))}>
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(240 6% 20%)" />
                      <XAxis dataKey="week" tick={{ fontSize: 11, fontFamily: "monospace" }} />
                      <YAxis tick={{ fontSize: 11, fontFamily: "monospace" }} tickFormatter={(v: number) => v.toLocaleString()} />
                      <Tooltip contentStyle={tooltipStyle} formatter={(v: number, name: string) => [formatEddies(Math.abs(v)), name.replace(/^(created|destroyed)_/, "$1 ")]} />
                      <Legend formatter={(v: string) => v.replace(/^created_/, "")} />
                      {cats.map((cat) => (
                        <Bar key={`c-${cat}`} dataKey={`created_${cat}`} stackId="flow" fill={CATEGORY_COLORS[cat] ?? "#9aa0a6"} />
                      ))}
                      {cats.map((cat) => (
                        <Bar key={`d-${cat}`} dataKey={`destroyed_${cat}`} stackId="flow" fill={CATEGORY_COLORS[cat] ?? "#9aa0a6"} legendType="none" fillOpacity={0.55} />
                      ))}
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
              <p className="font-mono text-xs text-muted-foreground mt-2">
                Above zero = money entering player wallets; below zero = money leaving (sinks, rent, meds…). Player-to-player transfers excluded.
                Click a week to break it down by category and see the underlying transactions.
              </p>
            </CardContent>
          </Card>

          <Card className="rounded-none border-border bg-card/50">
            <CardHeader>
              <CardTitle className="font-display tracking-widest flex items-center gap-2">
                <Coins className="w-4 h-4 text-nc-cyan" /> TOTAL MONEY SUPPLY
              </CardTitle>
            </CardHeader>
            <CardContent>
              {supplyRows.length === 0 ? (
                <p className="font-mono text-muted-foreground italic">No supply data yet.</p>
              ) : (
                <div className="h-64" data-testid="chart-economy-supply">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={supplyRows}>
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(240 6% 20%)" />
                      <XAxis dataKey="week" tick={{ fontSize: 11, fontFamily: "monospace" }} />
                      <YAxis tick={{ fontSize: 11, fontFamily: "monospace" }} tickFormatter={(v: number) => v.toLocaleString()} domain={["auto", "auto"]} />
                      <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => [formatEddies(v), "tracked supply"]} />
                      <Line type="monotone" dataKey="total" stroke="#00f0ff" strokeWidth={2} dot={false} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              )}
            </CardContent>
          </Card>

          {/* ------------------------------ MISSIONS ------------------------------ */}
          <Card className="rounded-none border-border bg-card/50">
            <CardHeader>
              <CardTitle className="font-display tracking-widest flex items-center gap-2">
                <Briefcase className="w-4 h-4 text-nc-magenta" /> MISSIONS
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 font-mono text-sm">
                <div className="border border-border p-3">
                  <div className="text-xs text-muted-foreground">MISSIONS RUN</div>
                  <div className="text-2xl text-nc-cyan" data-testid="stat-missions-run">{data.missions.totalMissions}</div>
                </div>
                <div className="border border-border p-3">
                  <div className="text-xs text-muted-foreground">APPLICATIONS</div>
                  <div className="text-2xl text-nc-cyan" data-testid="stat-applications">{data.missions.totalApplications}</div>
                </div>
                <div className="border border-border p-3">
                  <div className="text-xs text-muted-foreground">APPS / MISSION</div>
                  <div className="text-2xl text-nc-yellow" data-testid="stat-apps-per-mission">{data.missions.avgApplicationsPerMission}</div>
                </div>
                <div className="border border-border p-3">
                  <div className="text-xs text-muted-foreground">TOTAL PAYOUTS</div>
                  <div className="text-2xl text-nc-yellow" data-testid="stat-total-payout">{formatEddies(data.missions.totalPayout)}</div>
                </div>
              </div>
              {missionRows.length === 0 ? (
                <p className="font-mono text-muted-foreground italic">No completed missions in this range.</p>
              ) : (
                <div className="h-64 cursor-pointer" data-testid="chart-missions-weekly">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={missionRows} onClick={(st) => setMissionWeek(pickWeek(st))}>
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(240 6% 20%)" />
                      <XAxis dataKey="week" tick={{ fontSize: 11, fontFamily: "monospace" }} />
                      <YAxis yAxisId="left" tick={{ fontSize: 11, fontFamily: "monospace" }} allowDecimals={false} />
                      <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 11, fontFamily: "monospace" }} tickFormatter={(v: number) => v.toLocaleString()} />
                      <Tooltip
                        contentStyle={tooltipStyle}
                        formatter={(v: number, name: string) =>
                          name === "player pay" || name === "actor pay"
                            ? [formatEddies(v), name]
                            : name === "missions"
                              ? [v, "missions"]
                              : [formatEddies(v), name]
                        }
                      />
                      <Legend />
                      <Bar yAxisId="left" dataKey="missions" name="missions" fill="#ff2ec4" />
                      <Bar yAxisId="right" dataKey="playerPayout" name="player pay" stackId="pay" fill="#f5d90a" fillOpacity={0.7} />
                      <Bar yAxisId="right" dataKey="actorPayout" name="actor pay" stackId="pay" fill="#b17aff" fillOpacity={0.7} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
              <p className="font-mono text-xs text-muted-foreground">
                Click a week to list its missions with player vs actor payout splits.
              </p>
            </CardContent>
          </Card>

          {/* ------------------------------ REVIEWS ------------------------------ */}
          <Card className="rounded-none border-border bg-card/50">
            <CardHeader>
              <CardTitle className="font-display tracking-widest flex items-center gap-2">
                <ClipboardList className="w-4 h-4 text-nc-cyan" /> REVIEW QUEUES
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-3">
                {data.reviews.map((q) => (
                  <div key={q.queue} className="border border-border p-3 font-mono text-sm" data-testid={`queue-${q.queue}`}>
                    <div className="flex items-center justify-between">
                      <span className="font-display tracking-wider">{q.label}</span>
                      <span className={`text-xl ${q.open > 0 ? "text-nc-yellow" : "text-muted-foreground"}`}>{q.open} open</span>
                    </div>
                    <div className="mt-2 flex gap-1">
                      {AGE_LABELS.map((a) => (
                        <div key={a.key} className="flex-1 text-center">
                          <div className={`text-xs ${q.ageBuckets[a.key] > 0 ? (a.key === "over30" || a.key === "d7to30" ? "text-nc-magenta" : "text-nc-cyan") : "text-muted-foreground/50"}`}>
                            {q.ageBuckets[a.key]}
                          </div>
                          <div className="text-[0.5625rem] text-muted-foreground">{a.label}</div>
                        </div>
                      ))}
                    </div>
                    <div className="mt-2 text-xs text-muted-foreground space-y-0.5">
                      {q.oldestDays !== null && <div>oldest waiting ~{q.oldestDays}d</div>}
                      {q.decidedAwaitingClose > 0 && <div className="text-nc-yellow">{q.decidedAwaitingClose} decided, awaiting close</div>}
                      {q.changesRequested > 0 && <div>{q.changesRequested} waiting on submitter</div>}
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          {/* --------------------------- VRCHAT INSTANCES --------------------------- */}
          <Card className="rounded-none border-border bg-card/50">
            <CardHeader>
              <CardTitle className="font-display tracking-widest flex items-center gap-2">
                <Globe className="w-4 h-4 text-nc-cyan" /> VRCHAT INSTANCES
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 md:grid-cols-5 gap-3 font-mono text-sm">
                <div className="border border-border p-3">
                  <div className="text-xs text-muted-foreground">INSTANCES</div>
                  <div className="text-2xl text-nc-cyan" data-testid="stat-vr-sessions">{data.vrchat.totalSessions}</div>
                </div>
                <div className="border border-border p-3">
                  <div className="text-xs text-muted-foreground">TOTAL HOURS</div>
                  <div className="text-2xl text-nc-cyan" data-testid="stat-vr-hours">{data.vrchat.totalHours.toLocaleString()}</div>
                </div>
                <div className="border border-border p-3">
                  <div className="text-xs text-muted-foreground">AVG DURATION</div>
                  <div className="text-2xl text-nc-yellow" data-testid="stat-vr-avg-duration">{data.vrchat.avgDurationMinutes}m</div>
                </div>
                <div className="border border-border p-3">
                  <div className="text-xs text-muted-foreground">PEAK HEADCOUNT</div>
                  <div className="text-2xl text-nc-magenta" data-testid="stat-vr-peak">{data.vrchat.peakUserCount}</div>
                </div>
                <div className="border border-border p-3">
                  <div className="text-xs text-muted-foreground">OPEN NOW</div>
                  <div className={`text-2xl ${data.vrchat.openNow > 0 ? "text-nc-cyan" : "text-muted-foreground"}`} data-testid="stat-vr-open-now">{data.vrchat.openNow}</div>
                </div>
              </div>
              {vrWeeklyRows.length === 0 ? (
                <p className="font-mono text-muted-foreground italic" data-testid="text-vr-empty">
                  No instance history in this range yet — recording started when session tracking shipped, so charts fill in from here forward.
                </p>
              ) : (
                <div className="h-64 cursor-pointer" data-testid="chart-vrchat-weekly">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart
                      data={vrWeeklyRows}
                      onClick={(st) => {
                        const w = pickWeek(st);
                        if (w) setVrTarget({ week: w });
                      }}
                    >
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(240 6% 20%)" />
                      <XAxis dataKey="week" tick={{ fontSize: 11, fontFamily: "monospace" }} />
                      <YAxis yAxisId="left" tick={{ fontSize: 11, fontFamily: "monospace" }} allowDecimals={false} />
                      <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 11, fontFamily: "monospace" }} />
                      <Tooltip contentStyle={tooltipStyle} formatter={(v: number, name: string) => (name === "hours" ? [`${v}h`, "instance-hours"] : [v, "instances"])} />
                      <Legend />
                      <Bar yAxisId="left" dataKey="instances" fill="#00f0ff" />
                      <Bar yAxisId="right" dataKey="hours" fill="#b17aff" fillOpacity={0.7} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
              {data.vrchat.topWorlds.length > 0 && (
                <div>
                  <div className="font-display tracking-widest text-sm mb-2">TOP WORLDS BY INSTANCE-HOURS</div>
                  <div className="space-y-1 font-mono text-xs" data-testid="list-vr-top-worlds">
                    {data.vrchat.topWorlds.map((w) => (
                      <button
                        key={w.worldName}
                        type="button"
                        onClick={() => setVrTarget({ world: w.worldName, range })}
                        className="flex w-full items-center justify-between border border-border px-3 py-2 text-left hover:border-nc-cyan/60 hover:bg-accent/30 transition-colors cursor-pointer"
                        data-testid={`button-vr-world-${w.worldName}`}
                      >
                        <span className="text-foreground truncate mr-3">{w.worldName}</span>
                        <span className="text-muted-foreground whitespace-nowrap">
                          {w.sessions} inst · {w.hours.toLocaleString()}h · peak <span className="text-nc-magenta">{w.peakUserCount}</span>
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <div className="border-t border-border pt-4">
                <div className="font-display tracking-widest text-sm mb-2">PLAYER LOOKUP</div>
                <VrchatPlayerSearch />
              </div>
              <p className="font-mono text-xs text-muted-foreground">
                Head counts come from the group-instance poller (every 2 min, live server only). Per-player visit history comes from VRCX log imports.
                Click a week or a world to see every instance with peak / average / median headcount and a population sparkline.
              </p>
            </CardContent>
          </Card>

          {/* ------------------------------ PLAYERS ------------------------------ */}
          <Card className="rounded-none border-border bg-card/50">
            <CardHeader>
              <CardTitle className="font-display tracking-widest flex items-center gap-2">
                <Users className="w-4 h-4 text-nc-magenta" /> PLAYERS &amp; CHARACTERS
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 font-mono text-sm">
                <button
                  type="button"
                  onClick={() => setCharBucket("active60")}
                  className="border border-border p-3 text-left hover:border-nc-cyan/60 hover:bg-accent/30 transition-colors cursor-pointer"
                  data-testid="button-bucket-active60"
                >
                  <div className="text-xs text-muted-foreground">ACTIVE (60d)</div>
                  <div className="text-2xl text-nc-cyan" data-testid="stat-active-chars">{data.players.activeRecent}</div>
                </button>
                <button
                  type="button"
                  onClick={() => setCharBucket("dormant")}
                  className="border border-border p-3 text-left hover:border-nc-magenta/60 hover:bg-accent/30 transition-colors cursor-pointer"
                  data-testid="button-bucket-dormant"
                >
                  <div className="text-xs text-muted-foreground">DORMANT</div>
                  <div className="text-2xl text-nc-magenta" data-testid="stat-dormant-chars">{data.players.dormant}</div>
                </button>
                {lifeEntries.map(([status, n]) => (
                  <button
                    key={status}
                    type="button"
                    onClick={() => setCharBucket(status as AdminGetAnalyticsCharactersBucket)}
                    className="border border-border p-3 text-left hover:border-foreground/40 hover:bg-accent/30 transition-colors cursor-pointer"
                    data-testid={`button-bucket-${status}`}
                  >
                    <div className="text-xs text-muted-foreground uppercase">{status}</div>
                    <div className="text-2xl text-foreground">{n}</div>
                  </button>
                ))}
              </div>
              <CharacterBucketDialog bucket={charBucket} onClose={() => setCharBucket(null)} />
              <p className="font-mono text-xs text-muted-foreground">
                Active = live PCs with wallet or mission activity in the last 60 days; dormant = live PCs with none.
              </p>
              {trendRows.length > 0 && (
                <div>
                  <div className="font-display tracking-widest text-sm mb-2">ACTIVE VS DORMANT / WEEK</div>
                  <div className="h-64 cursor-pointer" data-testid="chart-activity-trend">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={trendRows} onClick={(st) => setTrendWeek(pickWeek(st))}>
                        <CartesianGrid strokeDasharray="3 3" stroke="hsl(240 6% 20%)" />
                        <XAxis dataKey="week" tick={{ fontSize: 11, fontFamily: "monospace" }} />
                        <YAxis tick={{ fontSize: 11, fontFamily: "monospace" }} allowDecimals={false} />
                        <Tooltip
                          contentStyle={tooltipStyle}
                          formatter={(v: number, name: string) => [v, name]}
                        />
                        <Legend />
                        <Line type="monotone" dataKey="active" name="active (60d)" stroke="#00f0ff" strokeWidth={2} dot={false} />
                        <Line type="monotone" dataKey="dormant" name="dormant" stroke="#ff2ec4" strokeWidth={2} dot={false} />
                        <Line type="monotone" dataKey="gained" name="became active" stroke="#7dff6a" strokeWidth={1.5} dot={false} strokeDasharray="4 3" />
                        <Line type="monotone" dataKey="lost" name="went dormant" stroke="#f5d90a" strokeWidth={1.5} dot={false} strokeDasharray="4 3" />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                  <p className="font-mono text-xs text-muted-foreground mt-1">
                    Weekly snapshots of the Active(60d)/Dormant split, backfilled from historical wallet and mission activity. Click a week to
                    see exactly which characters became active or went dormant.
                  </p>
                </div>
              )}
              {sheetRows.length > 0 && (
                <div>
                  <div className="font-display tracking-widest text-sm mb-2">NEW SHEETS / MONTH (12 mo)</div>
                  <div className="h-56" data-testid="chart-sheets-per-month">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={sheetRows}>
                        <CartesianGrid strokeDasharray="3 3" stroke="hsl(240 6% 20%)" />
                        <XAxis dataKey="month" tick={{ fontSize: 11, fontFamily: "monospace" }} />
                        <YAxis tick={{ fontSize: 11, fontFamily: "monospace" }} allowDecimals={false} />
                        <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => [v, "sheets"]} />
                        <Bar dataKey="count" fill="#00f0ff" />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          <CharacterTrendDialog week={trendWeek} onClose={() => setTrendWeek(null)} />
          <VrchatInstancesDialog target={vrTarget} onClose={() => setVrTarget(null)} />
          <MissionsWeekDialog week={missionWeek} onClose={() => setMissionWeek(null)} />
          <EconomyWeekDialog
            week={econWeek}
            created={data.economy.weekly.find((w) => w.weekStart === econWeek)?.created ?? {}}
            destroyed={data.economy.weekly.find((w) => w.weekStart === econWeek)?.destroyed ?? {}}
            excludeAbove={excludeAbove}
            onClose={() => setEconWeek(null)}
          />
        </>
      )}
    </div>
  );
}
