import { useState } from "react";
import { formatDateTime } from "@/lib/format";
import { Link } from "wouter";
import {
  useListMyBreachPuzzles,
  getListMyBreachPuzzlesQueryKey,
  type BreachPuzzle,
  type BreachPos,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { statusBadge, difficultyBadge, rewardSummary } from "./breachUtils";
import { Cpu, Play, Dumbbell, Route, ArrowRight } from "lucide-react";

// Renders a completed puzzle's code matrix with the worked solution path
// numbered step-by-step, so players can study the correct route afterwards.
function SolutionGrid({ grid, path }: { grid: string[][]; path: BreachPos[] }) {
  const stepAt = new Map<string, number>();
  path.forEach((pos, i) => stepAt.set(`${pos.r},${pos.c}`, i + 1));
  const cols = grid[0]?.length ?? 0;
  const cellSize =
    cols >= 7 ? "h-9 w-9 text-xs" : cols === 6 ? "h-10 w-10 text-sm" : "h-12 w-12 text-sm";
  return (
    <div className="inline-block border border-nc-cyan/30 bg-background/60 p-2">
      {grid.map((row, r) => (
        <div key={r} className="flex">
          {row.map((cell, c) => {
            const step = stepAt.get(`${r},${c}`);
            return (
              <div
                key={c}
                className={`${cellSize} relative flex items-center justify-center font-mono border border-border/20 ${
                  step != null
                    ? "bg-nc-cyan/20 text-nc-cyan border-nc-cyan/60"
                    : "text-muted-foreground"
                }`}
              >
                {cell}
                {step != null && (
                  <span className="absolute top-0 right-0.5 text-[0.6rem] leading-none text-nc-yellow font-bold">
                    {step}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function SolutionDialog({ puzzle, onClose }: { puzzle: BreachPuzzle; onClose: () => void }) {
  const grid = (puzzle.grid ?? []) as string[][];
  const path = puzzle.solutionPath ?? [];
  const sequence = path.map((pos) => grid[pos.r]?.[pos.c] ?? "??");
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="rounded-none border-nc-cyan/40 max-w-lg">
        <DialogHeader>
          <DialogTitle className="font-display tracking-widest text-nc-cyan flex items-center gap-2">
            <Route className="w-5 h-5" /> SOLUTION — BREACH #{puzzle.id}
          </DialogTitle>
        </DialogHeader>
        {path.length === 0 ? (
          <p className="font-mono text-sm text-muted-foreground">
            This grid had no valid path breaching every daemon — it was unwinnable at full completion.
          </p>
        ) : (
          <div className="space-y-4">
            <p className="font-mono text-xs text-muted-foreground">
              Numbered cells show one correct route (alternating row → column picks). Follow the
              order to breach every daemon within the buffer.
            </p>
            <div className="flex justify-center">
              <SolutionGrid grid={grid} path={path} />
            </div>
            <div className="font-mono text-sm text-foreground flex items-center flex-wrap gap-1" data-testid="solution-sequence">
              {sequence.map((code, i) => (
                <span key={i} className="flex items-center gap-1">
                  <span className="border border-nc-cyan/50 bg-nc-cyan/10 text-nc-cyan px-1.5 py-0.5">
                    {code}
                  </span>
                  {i < sequence.length - 1 && <ArrowRight className="w-3 h-3 text-muted-foreground" />}
                </span>
              ))}
            </div>
            <div className="space-y-1">
              <div className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
                Daemons
              </div>
              {((puzzle.daemons ?? []) as string[][]).map((daemon, i) => (
                <div key={i} className="font-mono text-sm text-foreground">
                  <span className="text-muted-foreground mr-2">[{i + 1}]</span>
                  {daemon.join(" ")}
                </div>
              ))}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export default function MyBreaches() {
  // Poll so a freshly-sent breach shows up here without a manual refresh — even
  // while the tab is backgrounded, and again the moment it regains focus.
  const { data: puzzles, isLoading } = useListMyBreachPuzzles({
    query: {
      queryKey: getListMyBreachPuzzlesQueryKey(),
      refetchInterval: 5000,
      refetchIntervalInBackground: true,
      refetchOnWindowFocus: true,
    },
  });
  const [solutionFor, setSolutionFor] = useState<BreachPuzzle | null>(null);

  const playable = (puzzles ?? []).filter((p) => !p.completedAt);
  const history = (puzzles ?? []).filter((p) => p.completedAt);

  return (
    <div className="max-w-5xl mx-auto pb-12 space-y-8">
      <div>
        <h1 className="text-4xl font-display font-bold text-foreground flex items-center gap-3">
          <Cpu className="w-8 h-8 text-nc-magenta" /> MY BREACHES
        </h1>
        <p className="font-mono text-sm text-muted-foreground mt-1">
          Breach Protocol puzzles assigned to your characters. Solve them before the timer runs out to claim rewards.
        </p>
      </div>

      <Card className="rounded-none border-nc-cyan/50 bg-nc-cyan/5" data-testid="card-practice">
        <CardContent className="py-5">
          <div className="flex items-center justify-between flex-wrap gap-4">
            <div className="flex items-start gap-4">
              <Dumbbell className="w-8 h-8 text-nc-cyan shrink-0 mt-1" />
              <div>
                <div className="font-display tracking-widest text-nc-cyan text-lg">PRACTICE MODE</div>
                <p className="font-mono text-sm text-muted-foreground mt-1 max-w-xl">
                  Sharpen your skills on unlimited practice grids at every difficulty — no timers on
                  your record, no stakes. Track your stats and climb the practice leaderboard.
                </p>
              </div>
            </div>
            <Link href="/breach/practice">
              <Button
                size="lg"
                className="rounded-none font-display tracking-widest bg-nc-cyan text-background hover:bg-nc-cyan/80"
                data-testid="button-practice"
              >
                <Dumbbell className="w-5 h-5 mr-2" /> START PRACTICE
              </Button>
            </Link>
          </div>
        </CardContent>
      </Card>

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
                        <th className="text-left py-2 pr-4">Solution</th>
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
                            {p.completedAt ? formatDateTime(p.completedAt) : "—"}
                          </td>
                          <td className="py-2 pr-4">
                            {p.solutionPath != null ? (
                              <Button
                                variant="outline"
                                size="sm"
                                className="rounded-none font-display border-nc-cyan/50 text-nc-cyan hover:bg-nc-cyan/10"
                                onClick={() => setSolutionFor(p)}
                                data-testid={`button-solution-${p.id}`}
                              >
                                <Route className="w-3.5 h-3.5 mr-1" /> VIEW
                              </Button>
                            ) : (
                              <span className="text-xs text-muted-foreground">—</span>
                            )}
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

      {solutionFor && <SolutionDialog puzzle={solutionFor} onClose={() => setSolutionFor(null)} />}
    </div>
  );
}
