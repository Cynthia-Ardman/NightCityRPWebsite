import { Badge } from "@/components/ui/badge";
import type { BreachPuzzle } from "@workspace/api-client-react";

export function statusBadge(status: BreachPuzzle["status"]) {
  switch (status) {
    case "sent":
      return <Badge className="rounded-none bg-nc-cyan text-background font-mono">SENT</Badge>;
    case "in_progress":
      return <Badge className="rounded-none bg-nc-yellow text-background font-mono">IN PROGRESS</Badge>;
    case "success":
      return <Badge className="rounded-none bg-nc-green text-background font-mono">SUCCESS</Badge>;
    case "failed":
      return <Badge className="rounded-none bg-destructive text-destructive-foreground font-mono">FAILED</Badge>;
    case "expired":
      return <Badge variant="outline" className="rounded-none font-mono text-muted-foreground">EXPIRED</Badge>;
    default:
      return <Badge variant="outline" className="rounded-none font-mono">{String(status).toUpperCase()}</Badge>;
  }
}

const DIFF_CLASS: Record<string, string> = {
  easy: "bg-nc-green text-background",
  medium: "bg-nc-yellow text-background",
  hard: "bg-nc-magenta text-background",
  very_hard: "bg-orange-500 text-background",
  nightmare: "bg-purple-600 text-white",
  impossible: "bg-destructive text-destructive-foreground",
};

export function difficultyBadge(difficulty: string) {
  return (
    <Badge className={`rounded-none font-mono ${DIFF_CLASS[difficulty] ?? "bg-nc-cyan text-background"}`}>
      {difficulty.toUpperCase()}
    </Badge>
  );
}

export function rewardSummary(p: BreachPuzzle): string {
  const parts: string[] = [];
  if (p.rewardEddies > 0) parts.push(`€$${p.rewardEddies.toLocaleString()}`);
  if (p.rewardItemName) parts.push(p.rewardItemName);
  return parts.length ? parts.join(" + ") : "—";
}
