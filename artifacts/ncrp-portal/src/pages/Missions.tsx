import { Link } from "wouter";
import {
  useListMyMissions,
  useListAllMissions,
  getListAllMissionsQueryKey,
  type MissionGroupSummary,
} from "@workspace/api-client-react";
import { useAuthMe } from "@/hooks/useAuthMe";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Briefcase } from "lucide-react";

function statusBadgeClass(s: string): string {
  if (s === "completed") return "border-nc-cyan text-nc-cyan";
  if (s === "failed") return "border-destructive text-destructive";
  if (s === "cancelled") return "border-muted-foreground text-muted-foreground";
  return "border-nc-yellow text-nc-yellow";
}

export default function Missions() {
  const { data: me } = useAuthMe();
  const isStaff = !!me && (me.isFixer || me.isAdmin);

  const mine = useListMyMissions();
  const all = useListAllMissions(undefined, {
    query: { enabled: isStaff, queryKey: getListAllMissionsQueryKey() },
  });

  return (
    <div className="max-w-6xl mx-auto space-y-8 pb-12">
      <div>
        <h1 className="text-3xl md:text-4xl font-display text-nc-magenta tracking-widest flex items-center gap-3">
          <Briefcase className="w-7 h-7" /> MISSIONS
        </h1>
        <p className="text-muted-foreground font-mono text-sm mt-1">
          Jobs logged by fixers, with payouts to your characters.
        </p>
      </div>

      <Card className="rounded-none border-border bg-card/50">
        <CardHeader>
          <CardTitle className="font-display tracking-widest">YOUR MISSIONS</CardTitle>
        </CardHeader>
        <CardContent>
          {mine.isLoading ? (
            <div className="font-mono text-nc-cyan animate-pulse">Loading...</div>
          ) : !mine.data || mine.data.length === 0 ? (
            <div className="font-mono text-muted-foreground italic">No missions yet.</div>
          ) : (
            <MissionTable rows={mine.data} mode="mine" />
          )}
        </CardContent>
      </Card>

      {isStaff && (
        <Card className="rounded-none border-border bg-card/50" data-testid="card-all-missions">
          <CardHeader>
            <CardTitle className="font-display tracking-widest text-nc-cyan">
              ALL MISSIONS <span className="text-xs text-muted-foreground font-mono">(fixer/admin)</span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {all.isLoading ? (
              <div className="font-mono text-nc-cyan animate-pulse">Loading...</div>
            ) : !all.data || all.data.length === 0 ? (
              <div className="font-mono text-muted-foreground italic">No missions logged anywhere yet.</div>
            ) : (
              <MissionTable rows={all.data} mode="all" />
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function MissionTable({ rows, mode }: { rows: MissionGroupSummary[]; mode: "mine" | "all" }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full font-mono text-sm">
        <thead className="border-b border-border bg-card">
          <tr className="text-nc-cyan uppercase text-xs tracking-widest">
            <th className="text-left p-2">When</th>
            <th className="text-left p-2">Title</th>
            <th className="text-left p-2">Fixer</th>
            {mode === "mine" ? (
              <>
                <th className="text-left p-2">Your Char(s)</th>
                <th className="text-right p-2">Your Payout</th>
              </>
            ) : (
              <th className="text-right p-2">Total Payout</th>
            )}
            <th className="text-right p-2">Runners</th>
            <th className="text-left p-2">Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((m) => {
            const when = new Date(m.occurredAt ?? m.createdAt);
            return (
              <tr
                key={m.id}
                className="border-b border-border/30 hover:bg-card/80 cursor-pointer"
                data-testid={`row-mission-${m.id}`}
              >
                <td className="p-0">
                  <Link href={`/missions/${m.id}`} className="block p-2 text-muted-foreground text-xs">
                    {when.toLocaleDateString()}
                  </Link>
                </td>
                <td className="p-0">
                  <Link href={`/missions/${m.id}`} className="block p-2 text-foreground">
                    <div className="font-display">{m.title}</div>
                    {m.summary && <div className="text-xs text-muted-foreground line-clamp-1">{m.summary}</div>}
                  </Link>
                </td>
                <td className="p-0">
                  <Link href={`/missions/${m.id}`} className="block p-2 text-nc-magenta">
                    {m.fixerName ?? "—"}
                  </Link>
                </td>
                {mode === "mine" ? (
                  <>
                    <td className="p-0">
                      <Link href={`/missions/${m.id}`} className="block p-2">
                        {m.myCharacters.length === 0 ? (
                          <span className="text-muted-foreground">—</span>
                        ) : (
                          <div className="flex flex-wrap gap-1">
                            {m.myCharacters.map((c) => (
                              <Badge
                                key={c.id}
                                variant="outline"
                                className="rounded-none border-nc-cyan/40 text-nc-cyan/80 text-[10px]"
                              >
                                {c.name}
                              </Badge>
                            ))}
                          </div>
                        )}
                      </Link>
                    </td>
                    <td className="p-0">
                      <Link href={`/missions/${m.id}`} className="block p-2 text-right text-nc-yellow">
                        {m.myPayoutEddies ? `€$${m.myPayoutEddies.toLocaleString()}` : "—"}
                      </Link>
                    </td>
                  </>
                ) : (
                  <td className="p-0">
                    <Link href={`/missions/${m.id}`} className="block p-2 text-right text-nc-yellow">
                      €${m.totalPayoutEddies.toLocaleString()}
                    </Link>
                  </td>
                )}
                <td className="p-0">
                  <Link href={`/missions/${m.id}`} className="block p-2 text-right">
                    {m.participantCount}
                  </Link>
                </td>
                <td className="p-0">
                  <Link href={`/missions/${m.id}`} className="block p-2">
                    <Badge variant="outline" className={`rounded-none text-[10px] px-1 py-0 ${statusBadgeClass(m.status)}`}>
                      {m.status.toUpperCase()}
                    </Badge>
                  </Link>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
