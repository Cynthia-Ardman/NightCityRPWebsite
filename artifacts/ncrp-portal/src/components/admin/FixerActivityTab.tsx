import { useMemo, useState } from "react";
import { useAdminFixerActivity, type FixerActivityRow } from "@workspace/api-client-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatDate } from "@/lib/format";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, Cell, CartesianGrid,
} from "recharts";

const WINDOWS = [
  { days: 30, label: "30 days" },
  { days: 60, label: "60 days" },
  { days: 90, label: "90 days" },
  { days: 180, label: "180 days" },
] as const;

// How long without any fixer-attributable action counts as "idle" for the
// red highlight, independent of the selected stats window.
const IDLE_DAYS = 30;

function daysAgo(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return Math.floor((Date.now() - t) / 86_400_000);
}

function relativeLabel(iso: string | null | undefined): string {
  const d = daysAgo(iso);
  if (d === null) return "never";
  if (d <= 0) return "today";
  if (d === 1) return "yesterday";
  if (d < 30) return `${d} days ago`;
  return formatDate(iso);
}

function Sparkline({ weekly }: { weekly: number[] }) {
  const max = Math.max(1, ...weekly);
  return (
    <div className="flex items-end gap-[2px] h-8" title="Staff actions per week (oldest → newest)">
      {weekly.map((v, i) => (
        <div
          key={i}
          className={v > 0 ? "bg-nc-cyan/70 w-[6px]" : "bg-border w-[6px]"}
          style={{ height: `${v > 0 ? Math.max(12, (v / max) * 100) : 6}%` }}
        />
      ))}
    </div>
  );
}

function totalActivity(f: FixerActivityRow): number {
  return (
    f.missionsCreated + f.missionsCompleted + f.reviewVotes + f.reviewComments +
    f.eventsCreated + f.actorPayments
  );
}

// Fixers and CS approvers do different jobs: review metrics only apply to CS
// approvers, fixer metrics only to fixers. The API already zeroes the
// non-applicable counts; the UI shows "—" and keeps each chart metric scoped
// to the users the metric applies to.
const FIXER_METRICS = new Set(["missionsCreated", "missionsCompleted", "eventsCreated", "actorPayments"]);
const CS_METRICS = new Set(["reviewVotes", "reviewComments"]);

function metricApplies(f: FixerActivityRow, metric: string): boolean {
  if (FIXER_METRICS.has(metric)) return f.isFixer;
  if (CS_METRICS.has(metric)) return f.isCsApprover;
  return true;
}

// Metrics selectable in the chart. "overall" sums the role-scoped sources
// (auditActions overlaps them, so it stays a separate metric of its own).
const METRICS = [
  { key: "overall", label: "Overall staff work" },
  { key: "missionsCreated", label: "Missions created" },
  { key: "missionsCompleted", label: "Missions completed" },
  { key: "reviewVotes", label: "Review votes (CS)" },
  { key: "reviewComments", label: "Review comments (CS)" },
  { key: "eventsCreated", label: "Events created" },
  { key: "actorPayments", label: "NPC payouts" },
  { key: "auditActions", label: "All staff actions" },
] as const;
type MetricKey = (typeof METRICS)[number]["key"];

const OVERALL_KEYS = [
  "missionsCreated", "missionsCompleted", "reviewVotes", "reviewComments",
  "eventsCreated", "actorPayments",
] as const;

function fixerColor(i: number): string {
  // Golden-angle hue spread → visually distinct colors for any fixer count.
  return `hsl(${Math.round((i * 137.508) % 360)} 85% 60%)`;
}

function metricValue(f: FixerActivityRow, metric: MetricKey): number {
  if (metric === "overall") return totalActivity(f);
  return f[metric];
}

function weeklySeries(f: FixerActivityRow, metric: MetricKey, weeks: number): number[] {
  const src = (f.weeklyBySource ?? {}) as Record<string, number[]>;
  if (metric !== "overall") return src[metric] ?? new Array(weeks).fill(0);
  const out = new Array(weeks).fill(0);
  for (const k of OVERALL_KEYS) {
    const arr = src[k];
    if (arr) for (let i = 0; i < out.length; i++) out[i] += arr[i] ?? 0;
  }
  return out;
}

function weekLabel(index: number, weeks: number): string {
  // index 0 = oldest week. Buckets are "N weeks back from now", so label each
  // bucket by its END date — the newest bucket then reads as today.
  const end = new Date(Date.now() - (weeks - 1 - index) * 7 * 86_400_000);
  return end.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function FixerActivityChart({
  fixers, weeks,
}: { fixers: FixerActivityRow[]; weeks: number }) {
  const [metric, setMetric] = useState<MetricKey>("overall");
  const [fixerId, setFixerId] = useState<string>("all");

  // Stable color per fixer (assigned in the report's order).
  const colorById = useMemo(
    () => new Map(fixers.map((f, i) => [f.userId, fixerColor(i)])),
    [fixers],
  );
  const selected = fixerId === "all" ? null : fixers.find((f) => f.userId === fixerId) ?? null;

  const allData = useMemo(
    () =>
      [...fixers]
        // Role-scoped metrics only chart the users they apply to — a fixer
        // without the CS role is not a zero on the review chart, they simply
        // aren't on it (and vice versa).
        .filter((f) => metricApplies(f, metric))
        .map((f) => ({
          name: f.globalName || f.username,
          userId: f.userId,
          value: metricValue(f, metric),
          color: colorById.get(f.userId)!,
        }))
        .sort((a, b) => b.value - a.value),
    [fixers, metric, colorById],
  );

  const singleData = useMemo(() => {
    if (!selected) return [];
    return weeklySeries(selected, metric, weeks).map((v, i) => ({
      name: weekLabel(i, weeks),
      value: v,
    }));
  }, [selected, metric, weeks]);

  const metricLabel = METRICS.find((m) => m.key === metric)?.label ?? "";

  return (
    <div className="mb-8">
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <Select value={metric} onValueChange={(v) => setMetric(v as MetricKey)}>
          <SelectTrigger className="w-56 rounded-none font-mono" data-testid="select-chart-metric">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {METRICS.map((m) => (
              <SelectItem key={m.key} value={m.key} className="font-mono">{m.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={fixerId} onValueChange={setFixerId}>
          <SelectTrigger className="w-56 rounded-none font-mono" data-testid="select-chart-fixer">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all" className="font-mono">All staff</SelectItem>
            {fixers.map((f) => (
              <SelectItem key={f.userId} value={f.userId} className="font-mono">
                {f.globalName || f.username}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="h-72 w-full" data-testid="chart-fixer-activity">
        <ResponsiveContainer width="100%" height="100%">
          {selected ? (
            <BarChart data={singleData} margin={{ top: 4, right: 8, left: -16, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
              <XAxis dataKey="name" tick={{ fontSize: 11 }} interval="preserveStartEnd" />
              <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
              <Tooltip
                cursor={{ fill: "hsl(var(--muted) / 0.4)" }}
                contentStyle={{ background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", fontFamily: "monospace", fontSize: 12 }}
                formatter={(v: number) => [v, metricLabel]}
                labelFormatter={(l: string) => `Week ending ${l}`}
              />
              <Bar dataKey="value" fill={colorById.get(selected.userId)} />
            </BarChart>
          ) : (
            <BarChart data={allData} margin={{ top: 4, right: 8, left: -16, bottom: 24 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
              <XAxis dataKey="name" tick={{ fontSize: 11 }} angle={-35} textAnchor="end" interval={0} height={60} />
              <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
              <Tooltip
                cursor={{ fill: "hsl(var(--muted) / 0.4)" }}
                contentStyle={{ background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", fontFamily: "monospace", fontSize: 12 }}
                formatter={(v: number) => [v, metricLabel]}
              />
              <Bar dataKey="value" onClick={(d: { payload?: { userId?: string } }) => {
                if (d.payload?.userId) setFixerId(d.payload.userId);
              }}>
                {allData.map((d) => (
                  <Cell key={d.userId} fill={d.color} cursor="pointer" />
                ))}
              </Bar>
            </BarChart>
          )}
        </ResponsiveContainer>
      </div>
      <p className="text-muted-foreground font-mono text-xs mt-2">
        {selected
          ? `${selected.globalName || selected.username} — ${metricLabel.toLowerCase()} per week in the selected window.`
          : "One bar per staff member the selected metric applies to (review metrics: CS approvers; mission/event metrics: fixers). Click a bar to drill into their week-by-week activity."}
      </p>
    </div>
  );
}

export default function FixerActivityTab() {
  const [days, setDays] = useState<number>(90);
  const { data, isLoading, error } = useAdminFixerActivity({ days });

  return (
    <Card className="rounded-none border-border">
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <CardTitle className="font-display uppercase tracking-widest">Staff Activity</CardTitle>
            <CardDescription className="font-mono mt-1">
              Fixers and CS approvers, each measured only on their own duties — review votes/comments count for CS approvers, missions/events/payouts for fixers. Idle staff (no attributable action in {IDLE_DAYS}+ days) are listed first and flagged.
            </CardDescription>
          </div>
          <div className="flex gap-1">
            {WINDOWS.map((w) => (
              <Button
                key={w.days}
                size="sm"
                variant={days === w.days ? "default" : "outline"}
                className="rounded-none font-mono"
                onClick={() => setDays(w.days)}
                data-testid={`button-window-${w.days}`}
              >
                {w.label}
              </Button>
            ))}
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <p className="text-muted-foreground font-mono py-8 text-center">Loading fixer activity…</p>
        ) : error ? (
          <p className="text-destructive font-mono py-8 text-center">Failed to load fixer activity.</p>
        ) : !data || data.fixers.length === 0 ? (
          <p className="text-muted-foreground font-mono py-8 text-center">No fixers found.</p>
        ) : (
          <>
          <FixerActivityChart fixers={data.fixers} weeks={data.weeks} />
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Staff</TableHead>
                  <TableHead>Last action</TableHead>
                  <TableHead>Last on site</TableHead>
                  <TableHead className="text-right">Missions created</TableHead>
                  <TableHead className="text-right">Missions completed</TableHead>
                  <TableHead className="text-right">Review votes</TableHead>
                  <TableHead className="text-right">Review comments</TableHead>
                  <TableHead className="text-right">Events</TableHead>
                  <TableHead className="text-right">NPC payouts</TableHead>
                  <TableHead className="text-right">All staff actions</TableHead>
                  <TableHead>Trend</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.fixers.map((f) => {
                  const idleDays = daysAgo(f.lastFixerActionAt);
                  const isIdle = idleDays === null || idleDays >= IDLE_DAYS;
                  const quiet = totalActivity(f) === 0;
                  // Role-scoped cells: show a dash (not a zero) when the
                  // metric simply doesn't apply to this person's role.
                  const cell = (metric: string, value: number) =>
                    metricApplies(f, metric) ? value : <span className="text-muted-foreground">—</span>;
                  return (
                    <TableRow key={f.userId} data-testid={`row-fixer-${f.userId}`} className={isIdle ? "bg-destructive/5" : undefined}>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          {f.avatarUrl ? (
                            <img src={f.avatarUrl} alt="" className="w-7 h-7 rounded-full shrink-0" />
                          ) : (
                            <div className="w-7 h-7 rounded-full bg-muted shrink-0" />
                          )}
                          <div className="min-w-0">
                            <div className="font-medium truncate">{f.globalName || f.username}</div>
                            <div className="flex gap-1 mt-0.5">
                              {f.isFixer && (
                                <Badge variant="outline" className="rounded-none text-[0.65rem] font-mono">{f.isTrialFixer ? "TRIAL FIXER" : "FIXER"}</Badge>
                              )}
                              {f.isCsApprover && (
                                <Badge variant="outline" className="rounded-none text-[0.65rem] font-mono text-nc-cyan border-nc-cyan/50">CS APPROVER</Badge>
                              )}
                              {isIdle && (
                                <Badge variant="destructive" className="rounded-none text-[0.65rem] font-mono">IDLE</Badge>
                              )}
                              {!isIdle && quiet && (
                                <Badge variant="outline" className="rounded-none text-[0.65rem] font-mono text-yellow-500 border-yellow-500/50">NO STAFF WORK</Badge>
                              )}
                            </div>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="font-mono whitespace-nowrap">
                        <span className={isIdle ? "text-destructive" : undefined}>{relativeLabel(f.lastFixerActionAt)}</span>
                      </TableCell>
                      <TableCell className="font-mono whitespace-nowrap text-muted-foreground">
                        {relativeLabel(f.lastSeenAt)}
                      </TableCell>
                      <TableCell className="text-right font-mono">{cell("missionsCreated", f.missionsCreated)}</TableCell>
                      <TableCell className="text-right font-mono">{cell("missionsCompleted", f.missionsCompleted)}</TableCell>
                      <TableCell className="text-right font-mono">{cell("reviewVotes", f.reviewVotes)}</TableCell>
                      <TableCell className="text-right font-mono">{cell("reviewComments", f.reviewComments)}</TableCell>
                      <TableCell className="text-right font-mono">{cell("eventsCreated", f.eventsCreated)}</TableCell>
                      <TableCell className="text-right font-mono">{cell("actorPayments", f.actorPayments)}</TableCell>
                      <TableCell className="text-right font-mono">{f.auditActions}</TableCell>
                      <TableCell><Sparkline weekly={f.weekly} /></TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
