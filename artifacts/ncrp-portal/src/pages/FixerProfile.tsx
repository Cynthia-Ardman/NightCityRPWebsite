import { useParams, Link } from "wouter";
import { useGetFixerMissions } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { TrialFixerBadge } from "@/components/TrialFixerBadge";
import { ArrowLeft, Crosshair } from "lucide-react";

const STATUS_LABELS: Record<string, string> = {
  open: "OPEN",
  pending: "PENDING",
  completed: "COMPLETED",
  completed_players_paid: "COMPLETED",
  completed_paid: "COMPLETED",
  cancelled: "CANCELLED",
};

function fmtDate(iso: string | null | undefined) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export default function FixerProfile() {
  const { id } = useParams<{ id: string }>();
  const { data, isLoading, isError } = useGetFixerMissions(id ?? "");

  if (isLoading) {
    return (
      <div className="max-w-7xl mx-auto p-6 font-mono text-muted-foreground animate-pulse">
        LOADING FIXER PROFILE…
      </div>
    );
  }
  if (isError || !data) {
    return (
      <div className="max-w-7xl mx-auto p-6 space-y-3">
        <div className="font-mono text-destructive">Fixer not found.</div>
        <Link href="/missions" className="inline-flex items-center gap-1 font-mono text-xs text-nc-magenta hover:underline">
          <ArrowLeft className="w-3 h-3" /> Back to missions
        </Link>
      </div>
    );
  }

  const { fixer, missions } = data;
  const name = fixer.name ?? "(unknown fixer)";

  return (
    <div className="max-w-7xl mx-auto p-6 space-y-6">
      <Link
        href="/missions"
        className="inline-flex items-center gap-1 font-mono text-xs text-muted-foreground hover:text-nc-magenta"
        data-testid="link-back-missions"
      >
        <ArrowLeft className="w-3 h-3" /> MISSIONS
      </Link>

      <div className="flex items-center gap-4" data-testid="block-fixer-header">
        <Avatar className="border border-nc-magenta/30 rounded-none w-16 h-16">
          <AvatarImage src={fixer.avatarUrl ?? undefined} />
          <AvatarFallback className="bg-background text-nc-magenta rounded-none font-display text-lg">
            {name.substring(0, 2).toUpperCase()}
          </AvatarFallback>
        </Avatar>
        <div>
          <div className="flex items-center gap-2">
            <h1 className="font-display text-2xl text-foreground" data-testid="text-fixer-name">{name}</h1>
            <TrialFixerBadge show={fixer.isTrial} testId="badge-fixer-trial" />
          </div>
          <div className="text-xs font-mono text-muted-foreground uppercase tracking-widest">Fixer</div>
        </div>
      </div>

      <Card className="rounded-none border-border bg-card/50">
        <CardHeader>
          <CardTitle className="font-display tracking-widest text-xs uppercase text-muted-foreground">
            Missions run ({missions.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {missions.length === 0 ? (
            <div className="font-mono text-muted-foreground italic">No missions to show.</div>
          ) : (
            <ul className="divide-y divide-border">
              {missions.map((m) => (
                <li key={m.id}>
                  <Link
                    href={`/missions/${m.id}`}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1 py-3 group"
                    data-testid={`link-mission-${m.id}`}
                  >
                    <Crosshair className="w-3.5 h-3.5 text-nc-magenta/60 shrink-0" />
                    <span className="font-display text-foreground group-hover:text-nc-magenta">
                      {m.title}
                    </span>
                    <Badge variant="outline" className="rounded-none font-mono text-[10px]">
                      TIER {m.tier}
                    </Badge>
                    <Badge variant="outline" className="rounded-none font-mono text-[10px] text-muted-foreground">
                      {STATUS_LABELS[m.status] ?? m.status.toUpperCase()}
                    </Badge>
                    {m.workflowState !== "posted" && (
                      <Badge variant="outline" className="rounded-none font-mono text-[10px] text-nc-yellow">
                        {m.workflowState.toUpperCase()}
                      </Badge>
                    )}
                    <span className="ml-auto font-mono text-xs text-muted-foreground">
                      {fmtDate(m.startAt) ?? "—"}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
