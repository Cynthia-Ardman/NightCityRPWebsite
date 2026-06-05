import { Link } from "wouter";
import { useListMyBreachPuzzles, getListMyBreachPuzzlesQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { statusBadge, difficultyBadge, rewardSummary } from "./breachUtils";
import { Cpu, Play, Dumbbell } from "lucide-react";

export default function MyBreaches() {
  // Poll so a freshly-sent breach shows up here without a manual refresh.
  const { data: puzzles, isLoading } = useListMyBreachPuzzles({
    query: { queryKey: getListMyBreachPuzzlesQueryKey(), refetchInterval: 10000 },
  });

  const playable = (puzzles ?? []).filter((p) => !p.completedAt);
  const history = (puzzles ?? []).filter((p) => p.completedAt);

  return (
    <div className="max-w-5xl mx-auto pb-12 space-y-8">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-4xl font-display font-bold text-foreground flex items-center gap-3">
            <Cpu className="w-8 h-8 text-nc-magenta" /> MY BREACHES
          </h1>
          <p className="font-mono text-sm text-muted-foreground mt-1">
            Breach Protocol puzzles assigned to your characters. Solve them before the timer runs out to claim rewards.
          </p>
        </div>
        <Link href="/breach/practice">
          <Button
            variant="outline"
            className="rounded-none font-display border-nc-cyan/50 text-nc-cyan hover:bg-nc-cyan/10"
            data-testid="button-practice"
          >
            <Dumbbell className="w-4 h-4 mr-1" /> PRACTICE
          </Button>
        </Link>
      </div>

      {isLoading ? (
        <div className="py-12 text-center font-mono text-muted-foreground animate-pulse">Loading...</div>
      ) : (
        <>
          <Card className="rounded-none border-nc-cyan/40 bg-card/50">
            <CardHeader>
              <CardTitle className="font-display tracking-widest text-nc-cyan">ACTIVE</CardTitle>
            </CardHeader>
            <CardContent>
              {playable.length === 0 ? (
                <div className="py-6 text-center font-mono text-muted-foreground italic">No active breaches.</div>
              ) : (
                <div className="space-y-3">
                  {playable.map((p) => (
                    <div
                      key={p.id}
                      className="flex items-center justify-between gap-4 border border-border/40 bg-background/40 px-4 py-3"
                      data-testid={`active-breach-${p.id}`}
                    >
                      <div className="space-y-1">
                        <div className="font-mono text-sm text-foreground">
                          Breach #{p.id} · {p.assignedCharacterName ?? "—"}
                        </div>
                        <div className="flex items-center gap-2 text-xs">
                          {difficultyBadge(p.difficulty)}
                          <span className="font-mono text-muted-foreground">{p.timeLimitSeconds}s</span>
                          <span className="font-mono text-nc-yellow">{rewardSummary(p)}</span>
                        </div>
                      </div>
                      <Link href={`/breach/play/${p.id}`}>
                        <Button className="rounded-none font-display tracking-widest bg-nc-magenta text-background hover:bg-nc-magenta/80" data-testid={`button-play-${p.id}`}>
                          <Play className="w-4 h-4 mr-1" /> {p.status === "in_progress" ? "RESUME" : "JACK IN"}
                        </Button>
                      </Link>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="rounded-none border-border bg-card/50">
            <CardHeader>
              <CardTitle className="font-display tracking-widest text-muted-foreground">HISTORY</CardTitle>
            </CardHeader>
            <CardContent>
              {history.length === 0 ? (
                <div className="py-6 text-center font-mono text-muted-foreground italic">No completed breaches yet.</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="font-mono text-xs uppercase tracking-widest text-muted-foreground border-b border-border/40">
                        <th className="text-left py-2 pr-4">#</th>
                        <th className="text-left py-2 pr-4">Character</th>
                        <th className="text-left py-2 pr-4">Diff</th>
                        <th className="text-left py-2 pr-4">Result</th>
                        <th className="text-left py-2 pr-4">Reward</th>
                        <th className="text-left py-2 pr-4">When</th>
                      </tr>
                    </thead>
                    <tbody className="font-mono">
                      {history.map((p) => (
                        <tr key={p.id} className="border-b border-border/20" data-testid={`history-breach-${p.id}`}>
                          <td className="py-2 pr-4 text-muted-foreground">{p.id}</td>
                          <td className="py-2 pr-4 text-foreground">{p.assignedCharacterName ?? "—"}</td>
                          <td className="py-2 pr-4">{difficultyBadge(p.difficulty)}</td>
                          <td className="py-2 pr-4">
                            {statusBadge(p.status)}
                            <span className="ml-2 text-xs text-muted-foreground">{p.solvedCount}/{p.daemons.length}</span>
                          </td>
                          <td className="py-2 pr-4 text-nc-yellow">
                            {p.rewardPaidAt ? rewardSummary(p) : "—"}
                          </td>
                          <td className="py-2 pr-4 text-xs text-muted-foreground">
                            {p.completedAt ? new Date(p.completedAt).toLocaleString() : "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
