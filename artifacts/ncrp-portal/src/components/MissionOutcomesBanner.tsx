import { useState } from "react";
import { Link } from "wouter";
import {
  useListMyApplicationOutcomes,
  getListMyApplicationOutcomesQueryKey,
  type MissionApplicationOutcome,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { CheckCircle2, XCircle, X } from "lucide-react";

// Per-device "seen" state. We key on the application id AND its review time so a
// re-applied → re-reviewed application re-surfaces, but a once-dismissed outcome
// never nags again. localStorage keeps this lightweight (no server round-trip).
const STORAGE_KEY = "ncrp.missionOutcomes.dismissed.v1";

function outcomeKey(o: MissionApplicationOutcome): string {
  return `${o.id}:${o.reviewedAt ?? ""}`;
}

function loadDismissed(): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? new Set(arr.filter((x) => typeof x === "string")) : new Set();
  } catch {
    return new Set();
  }
}

function saveDismissed(set: Set<string>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...set]));
  } catch {
    /* storage unavailable — dismissal just won't persist */
  }
}

/**
 * In-portal notice of accepted/declined mission applications. Closes the loop
 * for players regardless of whether the Discord DM was delivered. Each outcome
 * can be dismissed (persisted per-device) so it doesn't nag indefinitely.
 */
export function MissionOutcomesBanner() {
  const { data } = useListMyApplicationOutcomes({
    query: { queryKey: getListMyApplicationOutcomesQueryKey() },
  });
  const [dismissed, setDismissed] = useState<Set<string>>(() => loadDismissed());

  const dismiss = (keys: string[]) => {
    setDismissed((prev) => {
      const next = new Set(prev);
      for (const k of keys) next.add(k);
      saveDismissed(next);
      return next;
    });
  };

  const visible = (data ?? []).filter((o) => !dismissed.has(outcomeKey(o)));
  if (visible.length === 0) return null;

  return (
    <section className="space-y-3" data-testid="card-application-outcomes">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-display tracking-widest text-lg text-nc-magenta">APPLICATION RESULTS</h2>
        {visible.length > 1 && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => dismiss(visible.map(outcomeKey))}
            className="rounded-none font-mono text-xs text-muted-foreground hover:text-foreground"
            data-testid="button-dismiss-all-outcomes"
          >
            DISMISS ALL
          </Button>
        )}
      </div>
      <div className="space-y-2">
        {visible.map((o) => (
          <OutcomeRow key={outcomeKey(o)} o={o} onDismiss={() => dismiss([outcomeKey(o)])} />
        ))}
      </div>
    </section>
  );
}

function OutcomeRow({ o, onDismiss }: { o: MissionApplicationOutcome; onDismiss: () => void }) {
  const accepted = o.status === "accepted";
  const char = o.characterName ?? "Your character";
  return (
    <div
      className={`flex items-start gap-3 border p-3 font-mono text-sm ${
        accepted
          ? "border-green-500/50 bg-green-500/10"
          : "border-destructive/50 bg-destructive/10"
      }`}
      data-testid={`row-outcome-${o.id}`}
    >
      {accepted ? (
        <CheckCircle2 className="w-4 h-4 shrink-0 text-green-400 mt-0.5" />
      ) : (
        <XCircle className="w-4 h-4 shrink-0 text-destructive mt-0.5" />
      )}
      <div className="flex-1 min-w-0">
        <Link
          href={`/missions/${o.missionId}`}
          className="hover:underline"
          data-testid={`link-outcome-${o.id}`}
        >
          {accepted ? (
            <span className="text-green-400">
              <strong className="font-display tracking-wide">{char}</strong> was accepted for{" "}
              <strong className="text-foreground">{o.missionTitle}</strong>.
            </span>
          ) : (
            <span className="text-destructive">
              <strong className="font-display tracking-wide">{char}</strong>'s application to{" "}
              <strong className="text-foreground">{o.missionTitle}</strong> was declined.
            </span>
          )}
        </Link>
      </div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="shrink-0 text-muted-foreground hover:text-foreground"
        data-testid={`button-dismiss-outcome-${o.id}`}
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}
