import { useState } from "react";
import { Link } from "wouter";
import {
  generatePuzzleByDifficulty,
  type Difficulty,
  type GeneratedPuzzle,
} from "@workspace/breach";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import BreachBoard, { type Pos, type BreachOutcome } from "./BreachBoard";
import { difficultyBadge } from "./breachUtils";
import { Cpu, ArrowLeft, RefreshCw } from "lucide-react";

const DIFFICULTIES: Difficulty[] = ["easy", "medium", "hard", "impossible"];

// Practice time limits mirror the spirit of the staff defaults but are purely
// client-side — nothing here is recorded.
const TIME_BY_DIFFICULTY: Record<Difficulty, number> = {
  easy: 90,
  medium: 60,
  hard: 45,
  impossible: 30,
};

type Session = {
  puzzle: GeneratedPuzzle;
  difficulty: Difficulty;
  timeLimitSeconds: number;
  startAt: number;
  nonce: number;
};

export default function BreachPractice() {
  const [difficulty, setDifficulty] = useState<Difficulty>("medium");
  const [session, setSession] = useState<Session | null>(null);
  const [outcome, setOutcome] = useState<BreachOutcome | null>(null);

  const start = (diff: Difficulty) => {
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
  };

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
    </div>
  );
}
