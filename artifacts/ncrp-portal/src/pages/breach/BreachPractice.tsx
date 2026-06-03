import { useState } from "react";
import { Link } from "wouter";
import {
  generatePuzzleByDifficulty,
  PRACTICE_DIFFICULTIES,
  type PracticeDifficulty,
  type GeneratedPuzzle,
} from "@workspace/breach";
import { useGetBreachPracticeLeaderboard } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { useAuthMe } from "@/hooks/useAuthMe";
import BreachBoard, { type Pos, type BreachOutcome } from "./BreachBoard";
import { difficultyBadge } from "./breachUtils";
import { Cpu, ArrowLeft, RefreshCw, BarChart3, Trash2, Cloud, Loader2, Trophy } from "lucide-react";
import { formatClearTime, winRate } from "./breachPracticeStats";
import { usePracticeStats } from "./usePracticeStats";

const DIFFICULTIES: PracticeDifficulty[] = PRACTICE_DIFFICULTIES;

// Practice time limits mirror the spirit of the staff defaults but are purely
// client-side — nothing here is recorded.
const TIME_BY_DIFFICULTY: Record<PracticeDifficulty, number> = {
  easy: 90,
  medium: 60,
  hard: 45,
  // Bigger 6x6 / 7x7 boards have longer solution paths, so they get more time
  // on the bench to scan and execute the chain.
  very_hard: 75,
  nightmare: 90,
};

type Session = {
  puzzle: GeneratedPuzzle;
  difficulty: PracticeDifficulty;
  timeLimitSeconds: number;
  startAt: number;
  nonce: number;
};

export default function BreachPractice() {
  const [difficulty, setDifficulty] = useState<PracticeDifficulty>("medium");
  const [session, setSession] = useState<Session | null>(null);
  const [outcome, setOutcome] = useState<BreachOutcome | null>(null);
  const { toast } = useToast();
  const me = useAuthMe();
  const myId = me.data?.id;
  const { data: leaderboard, isLoading: leaderboardLoading } = useGetBreachPracticeLeaderboard();
  const {
    stats,
    canSync,
    synced,
    syncBusy,
    recordAttempt,
    resetStats,
    enableSync,
    disableSync,
  } = usePracticeStats();

  const start = (diff: PracticeDifficulty) => {
    const puzzle = generatePuzzleByDifficulty(diff);
    setOutcome(null);
    setSession({
      puzzle,
      difficulty: diff,
      timeLimitSeconds: TIME_BY_DIFFICULTY[diff],
      startAt: Date.now(),
      nonce: Math.random(),
    });
  };

  const handleFinish = (_sel: Pos[], result: BreachOutcome) => {
    setOutcome(result);
    if (!session) return;
    // Clamp elapsed to the run's time limit so a backgrounded tab can't record
    // a wildly inflated "clear time".
    const elapsedMs = Math.min(
      Date.now() - session.startAt,
      session.timeLimitSeconds * 1000,
    );
    recordAttempt(session.difficulty, result.success, elapsedMs);
  };

  const handleSyncToggle = async (next: boolean) => {
    if (next) {
      try {
        await enableSync();
        toast({
          title: "Practice sync on",
          description: "Your practice stats now follow you across devices.",
        });
      } catch {
        toast({
          title: "Couldn't turn on sync",
          description: "Something went wrong saving your stats. Try again.",
          variant: "destructive",
        });
      }
    } else {
      disableSync();
      toast({
        title: "Practice sync off",
        description: "Your account stats are kept, but this browser is back to local-only.",
      });
    }
  };

  const hasAnyStats = DIFFICULTIES.some((d) => stats[d].attempts > 0);

  return (
    <div className="max-w-5xl mx-auto pb-12 space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h1 className="text-4xl font-display font-bold text-foreground flex items-center gap-3">
          <Cpu className="w-8 h-8 text-nc-magenta" /> BREACH PRACTICE
        </h1>
        <Link href="/breach/mine">
          <Button variant="outline" className="rounded-none font-display">
            <ArrowLeft className="w-4 h-4 mr-1" /> MY BREACHES
          </Button>
        </Link>
      </div>

      <p className="font-mono text-sm text-muted-foreground">
        Unlimited training runs. Generate a puzzle at any difficulty and breach it — results are
        <span className="text-nc-yellow"> not recorded</span> and carry no rewards. Pure practice.
      </p>

      <Card className="rounded-none border-border bg-card/50">
        <CardHeader className="pb-3">
          <CardTitle className="font-display tracking-widest text-nc-cyan text-sm">SELECT DIFFICULTY</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-2">
            {DIFFICULTIES.map((d) => (
              <button
                key={d}
                onClick={() => setDifficulty(d)}
                data-testid={`difficulty-${d}`}
                className={[
                  "px-4 py-2 font-mono text-xs uppercase tracking-widest border transition-colors",
                  difficulty === d
                    ? "border-nc-magenta bg-nc-magenta/20 text-nc-magenta"
                    : "border-border/40 text-muted-foreground hover:border-nc-cyan/50 hover:text-nc-cyan",
                ].join(" ")}
              >
                {d}
              </button>
            ))}
          </div>
          <Button
            onClick={() => start(difficulty)}
            className="rounded-none font-display bg-nc-cyan text-background hover:bg-nc-cyan/80"
            data-testid="button-generate-practice"
          >
            <RefreshCw className="w-4 h-4 mr-1" />
            {session ? "GENERATE NEW PUZZLE" : "GENERATE PUZZLE"}
          </Button>
        </CardContent>
      </Card>

      {session && (
        <BreachBoard
          key={session.nonce}
          grid={session.puzzle.grid}
          daemons={session.puzzle.daemons}
          bufferSize={session.puzzle.bufferSize}
          timeLimitSeconds={session.timeLimitSeconds}
          startAt={session.startAt}
          onFinish={handleFinish}
          heading={
            <>
              <h2 className="text-2xl font-display font-bold text-foreground">PRACTICE RUN</h2>
              {difficultyBadge(session.difficulty)}
            </>
          }
          resultFooter={
            outcome ? (
              <Button
                onClick={() => start(session.difficulty)}
                className="rounded-none font-display bg-nc-magenta text-background hover:bg-nc-magenta/80"
                data-testid="button-replay-practice"
              >
                <RefreshCw className="w-4 h-4 mr-1" /> PLAY AGAIN
              </Button>
            ) : null
          }
        />
      )}

      <Card className="rounded-none border-border bg-card/50" data-testid="practice-stats">
        <CardHeader className="pb-3 flex-row items-center justify-between space-y-0">
          <CardTitle className="font-display tracking-widest text-nc-cyan text-sm flex items-center gap-2">
            <BarChart3 className="w-4 h-4" /> YOUR PRACTICE STATS
          </CardTitle>
          {hasAnyStats && (
            <Button
              variant="ghost"
              size="sm"
              onClick={resetStats}
              data-testid="button-reset-stats"
              className="rounded-none font-mono text-xs text-muted-foreground hover:text-destructive"
            >
              <Trash2 className="w-3 h-3 mr-1" /> RESET
            </Button>
          )}
        </CardHeader>
        <CardContent>
          {canSync && (
            <div
              className="flex items-start justify-between gap-3 mb-4 border border-border/40 bg-background/40 px-3 py-2"
              data-testid="practice-sync-toggle-row"
            >
              <label
                htmlFor="practice-sync"
                className="font-mono text-xs text-muted-foreground flex items-start gap-2 cursor-pointer"
              >
                {syncBusy ? (
                  <Loader2 className="w-4 h-4 mt-0.5 shrink-0 text-nc-cyan animate-spin" />
                ) : (
                  <Cloud
                    className={`w-4 h-4 mt-0.5 shrink-0 ${synced ? "text-nc-cyan" : "text-muted-foreground"}`}
                  />
                )}
                <span>
                  <span className="text-foreground uppercase tracking-widest">Sync to my account</span>
                  <br />
                  Save these stats to your account so they follow you across devices.
                </span>
              </label>
              <Switch
                id="practice-sync"
                checked={synced}
                disabled={syncBusy}
                onCheckedChange={handleSyncToggle}
                data-testid="switch-practice-sync"
              />
            </div>
          )}
          <p className="font-mono text-xs text-muted-foreground mb-4">
            {synced
              ? "Synced to your account — these stats follow you across devices. Your fastest clear times appear on the leaderboard below by username. No rewards."
              : canSync
                ? "Saved only in this browser. Turn on sync above to keep them on your account across devices and join the leaderboard below."
                : "Saved only in this browser — never sent to the server. Clearing your browser data resets it."}
          </p>
          <div className="overflow-x-auto">
            <table className="w-full font-mono text-sm">
              <thead>
                <tr className="text-left text-muted-foreground border-b border-border/40">
                  <th className="py-2 pr-4 font-normal uppercase tracking-widest text-xs">Difficulty</th>
                  <th className="py-2 px-4 font-normal uppercase tracking-widest text-xs text-right">Attempts</th>
                  <th className="py-2 px-4 font-normal uppercase tracking-widest text-xs text-right">Solves</th>
                  <th className="py-2 px-4 font-normal uppercase tracking-widest text-xs text-right">Win Rate</th>
                  <th className="py-2 pl-4 font-normal uppercase tracking-widest text-xs text-right">Fastest Clear</th>
                </tr>
              </thead>
              <tbody>
                {DIFFICULTIES.map((d) => {
                  const s = stats[d];
                  return (
                    <tr key={d} className="border-b border-border/20" data-testid={`stats-row-${d}`}>
                      <td className="py-2 pr-4 uppercase text-foreground">{d}</td>
                      <td className="py-2 px-4 text-right text-foreground" data-testid={`stats-attempts-${d}`}>
                        {s.attempts}
                      </td>
                      <td className="py-2 px-4 text-right text-nc-green" data-testid={`stats-solves-${d}`}>
                        {s.solves}
                      </td>
                      <td className="py-2 px-4 text-right text-foreground" data-testid={`stats-winrate-${d}`}>
                        {winRate(s)}
                      </td>
                      <td className="py-2 pl-4 text-right text-nc-yellow" data-testid={`stats-fastest-${d}`}>
                        {formatClearTime(s.fastestClearMs)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <Card className="rounded-none border-border bg-card/50" data-testid="practice-leaderboard">
        <CardHeader className="pb-3">
          <CardTitle className="font-display tracking-widest text-nc-yellow text-sm flex items-center gap-2">
            <Trophy className="w-4 h-4" /> LEADERBOARD — FASTEST CLEARS
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <p className="font-mono text-xs text-muted-foreground">
            Fastest individual practice runs by username — a single runner can hold several spots.
            Only players who turned on account sync appear here.
          </p>
          {leaderboardLoading ? (
            <div className="py-6 text-center font-mono text-muted-foreground animate-pulse">Loading...</div>
          ) : (
            DIFFICULTIES.map((d) => {
              const entries = leaderboard?.[d] ?? [];
              return (
                <div key={d} data-testid={`leaderboard-${d}`}>
                  <div className="flex items-center gap-2 mb-2">
                    {difficultyBadge(d)}
                  </div>
                  {entries.length === 0 ? (
                    <div className="py-3 text-center font-mono text-xs text-muted-foreground italic border border-border/20">
                      No ranked times yet.
                    </div>
                  ) : (
                    <table className="w-full font-mono text-sm">
                      <thead>
                        <tr className="text-left text-muted-foreground border-b border-border/40">
                          <th className="py-1 pr-4 font-normal uppercase tracking-widest text-xs w-12">#</th>
                          <th className="py-1 px-4 font-normal uppercase tracking-widest text-xs">Runner</th>
                          <th className="py-1 pl-4 font-normal uppercase tracking-widest text-xs text-right">Fastest Clear</th>
                        </tr>
                      </thead>
                      <tbody>
                        {entries.map((entry, i) => {
                          const isMe = !!myId && entry.userId === myId;
                          return (
                            <tr
                              key={entry.id}
                              className={[
                                "border-b border-border/20",
                                isMe ? "bg-nc-cyan/10" : "",
                              ].join(" ")}
                              data-testid={`leaderboard-${d}-row-${i}`}
                            >
                              <td className="py-1.5 pr-4 text-muted-foreground">{i + 1}</td>
                              <td className="py-1.5 px-4 text-foreground">
                                {entry.username}
                                {isMe && <span className="ml-2 text-xs text-nc-cyan">(you)</span>}
                              </td>
                              <td className="py-1.5 pl-4 text-right text-nc-yellow">
                                {formatClearTime(entry.clearMs)}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  )}
                </div>
              );
            })
          )}
        </CardContent>
      </Card>
    </div>
  );
}
