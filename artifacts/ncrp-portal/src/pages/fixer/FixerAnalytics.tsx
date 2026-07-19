import { useState } from "react";
import { Link } from "wouter";
import { useAdminGetAnalytics, getAdminGetAnalyticsQueryKey, type AdminGetAnalyticsRange } from "@workspace/api-client-react";
import { useEffectiveMe } from "@/contexts/ViewAsContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Activity, Coins, Briefcase, ClipboardList, Users, Globe } from "lucide-react";
import VrchatPlayerSearch from "@/components/fixer/VrchatPlayerSearch";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  LineChart,
  Line,
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

function fmtEddies(n: number): string {
  return `€$ ${n.toLocaleString()}`;
}

const tooltipStyle = {
  backgroundColor: "hsl(240 10% 8%)",
  border: "1px solid hsl(240 6% 25%)",
  borderRadius: 0,
  fontFamily: "monospace",
  fontSize: "0.75rem",
} as const;

export default function FixerAnalytics() {
  const { data: user, isLoading: userLoading } = useEffectiveMe();
  const [range, setRange] = useState<RangeKey>("3m");
  const [excludeInput, setExcludeInput] = useState("");
  const [excludeAbove, setExcludeAbove] = useState<number | null>(null);
  const isStaff = !!user && (user.isFixer || user.isAdmin);
  const params = { range: range as AdminGetAnalyticsRange, ...(excludeAbove !== null ? { excludeAbove } : {}) };
  const { data, isLoading } = useAdminGetAnalytics(params, {
    query: { enabled: isStaff, queryKey: getAdminGetAnalyticsQueryKey(params) },
  });

  const applyExclude = () => {
    const n = Number(excludeInput.replace(/[,\s]/g, ""));
    setExcludeAbove(Number.isFinite(n) && n > 0 ? Math.floor(n) : null);
  };

  if (userLoading) return null;
  if (!isStaff) {
    return (
      <div className="max-w-7xl mx-auto py-12 text-center font-mono text-muted-foreground">
        Staff access required.
      </div>
    );
  }

  // Flatten economy weekly rows for stacked bars: one row per week with
  // created_<cat> positive and destroyed_<cat> series.
  const econCategories = new Set<string>();
  const econRows = (data?.economy.weekly ?? []).map((w) => {
    const row: Record<string, number | string> = { week: fmtWeek(w.weekStart) };
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
    missions: w.missionsRun,
    payout: w.payoutTotal,
  }));

  const sheetRows = (data?.players.sheetsPerMonth ?? []).map((m) => ({
    month: fmtMonth(m.month),
    count: m.count,
  }));

  const lifeEntries = Object.entries(data?.players.lifeStatus ?? {}).sort((a, b) => b[1] - a[1]);

  const vrWeeklyRows = (data?.vrchat.weekly ?? []).map((w) => ({
    week: fmtWeek(w.weekStart),
    instances: w.sessions,
    hours: w.hours,
  }));

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
                ? `${data.excludedWallets} wallet${data.excludedWallets === 1 ? "" : "s"} above €$ ${excludeAbove.toLocaleString()} excluded from economy charts`
                : `filtering wallets above €$ ${excludeAbove.toLocaleString()}…`}
            </span>
          </>
        )}
      </div>

      {isLoading || !data ? (
        <div className="font-mono text-nc-cyan animate-pulse py-12 text-center">Crunching server data...</div>
      ) : (
        <>
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
                <div className="h-80" data-testid="chart-economy-weekly">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={econRows} stackOffset="sign">
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(240 6% 20%)" />
                      <XAxis dataKey="week" tick={{ fontSize: 11, fontFamily: "monospace" }} />
                      <YAxis tick={{ fontSize: 11, fontFamily: "monospace" }} tickFormatter={(v: number) => v.toLocaleString()} />
                      <Tooltip contentStyle={tooltipStyle} formatter={(v: number, name: string) => [fmtEddies(Math.abs(v)), name.replace(/^(created|destroyed)_/, "$1 ")]} />
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
                      <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => [fmtEddies(v), "tracked supply"]} />
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
                  <div className="text-2xl text-nc-yellow" data-testid="stat-total-payout">{fmtEddies(data.missions.totalPayout)}</div>
                </div>
              </div>
              {missionRows.length === 0 ? (
                <p className="font-mono text-muted-foreground italic">No completed missions in this range.</p>
              ) : (
                <div className="h-64" data-testid="chart-missions-weekly">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={missionRows}>
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(240 6% 20%)" />
                      <XAxis dataKey="week" tick={{ fontSize: 11, fontFamily: "monospace" }} />
                      <YAxis yAxisId="left" tick={{ fontSize: 11, fontFamily: "monospace" }} allowDecimals={false} />
                      <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 11, fontFamily: "monospace" }} tickFormatter={(v: number) => v.toLocaleString()} />
                      <Tooltip contentStyle={tooltipStyle} formatter={(v: number, name: string) => (name === "payout" ? [fmtEddies(v), "payouts"] : [v, "missions"])} />
                      <Legend />
                      <Bar yAxisId="left" dataKey="missions" fill="#ff2ec4" />
                      <Bar yAxisId="right" dataKey="payout" fill="#f5d90a" fillOpacity={0.7} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
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
                <div className="h-64" data-testid="chart-vrchat-weekly">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={vrWeeklyRows}>
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
                      <div key={w.worldName} className="flex items-center justify-between border border-border px-3 py-2">
                        <span className="text-foreground truncate mr-3">{w.worldName}</span>
                        <span className="text-muted-foreground whitespace-nowrap">
                          {w.sessions} inst · {w.hours.toLocaleString()}h · peak <span className="text-nc-magenta">{w.peakUserCount}</span>
                        </span>
                      </div>
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
                <div className="border border-border p-3">
                  <div className="text-xs text-muted-foreground">ACTIVE (60d)</div>
                  <div className="text-2xl text-nc-cyan" data-testid="stat-active-chars">{data.players.activeRecent}</div>
                </div>
                <div className="border border-border p-3">
                  <div className="text-xs text-muted-foreground">DORMANT</div>
                  <div className="text-2xl text-nc-magenta" data-testid="stat-dormant-chars">{data.players.dormant}</div>
                </div>
                {lifeEntries.map(([status, n]) => (
                  <div key={status} className="border border-border p-3">
                    <div className="text-xs text-muted-foreground uppercase">{status}</div>
                    <div className="text-2xl text-foreground">{n}</div>
                  </div>
                ))}
              </div>
              <p className="font-mono text-xs text-muted-foreground">
                Active = live PCs with wallet or mission activity in the last 60 days; dormant = live PCs with none.
              </p>
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
        </>
      )}
    </div>
  );
}
