import { Link, useParams } from "wouter";
import { useGetMission } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Briefcase, ArrowLeft } from "lucide-react";
import { missionStatusClass, missionStatusLabel } from "@/lib/missionStatus";

export default function MissionDetail() {
  const { id } = useParams();
  const { data, isLoading, error } = useGetMission(String(id ?? ""));

  if (isLoading) {
    return <div className="max-w-4xl mx-auto font-mono text-nc-cyan animate-pulse">Loading mission...</div>;
  }
  if (error || !data) {
    return (
      <div className="max-w-4xl mx-auto space-y-4">
        <Link href="/missions" className="text-nc-cyan font-mono text-sm hover:underline inline-flex items-center gap-1">
          <ArrowLeft className="w-4 h-4" /> back to missions
        </Link>
        <div className="font-mono text-destructive">Mission not found or you don't have access.</div>
      </div>
    );
  }

  const when = new Date(data.occurredAt ?? data.createdAt);

  return (
    <div className="max-w-4xl mx-auto space-y-6 pb-12">
      <Link
        href="/missions"
        className="text-nc-cyan font-mono text-sm hover:underline inline-flex items-center gap-1"
        data-testid="link-back-missions"
      >
        <ArrowLeft className="w-4 h-4" /> back to missions
      </Link>

      <div>
        <div className="flex items-center gap-3 text-nc-magenta">
          <Briefcase className="w-6 h-6" />
          <span className="font-display text-xs uppercase tracking-widest">Mission Log</span>
        </div>
        <h1 className="text-3xl md:text-4xl font-display text-foreground tracking-wider mt-1" data-testid="text-mission-title">
          {data.title}
        </h1>
        <div className="flex flex-wrap gap-3 mt-3 font-mono text-xs uppercase tracking-widest">
          <Badge variant="outline" className={`rounded-none font-bold ${missionStatusClass(data.status)}`}>
            {missionStatusLabel(data.status)}
          </Badge>
          <span className="text-muted-foreground">{when.toLocaleDateString()} {when.toLocaleTimeString()}</span>
          <span className="text-nc-yellow">Total payout €${data.totalPayoutEddies.toLocaleString()}</span>
        </div>
      </div>

      {data.summary && (
        <Card className="rounded-none border-border bg-card/50">
          <CardHeader>
            <CardTitle className="font-display tracking-widest text-xs uppercase text-muted-foreground">Brief</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="font-mono text-sm whitespace-pre-wrap text-foreground">{data.summary}</p>
          </CardContent>
        </Card>
      )}

      <Card className="rounded-none border-border bg-card/50">
        <CardHeader>
          <CardTitle className="font-display tracking-widest text-xs uppercase text-muted-foreground">Fixer</CardTitle>
        </CardHeader>
        <CardContent>
          {data.fixerId ? (
            <div className="flex items-center gap-3" data-testid="block-fixer">
              <Avatar className="border border-nc-magenta/30 rounded-none w-12 h-12">
                <AvatarImage src={data.fixerAvatarUrl ?? undefined} />
                <AvatarFallback className="bg-background text-nc-magenta rounded-none font-display">
                  {(data.fixerName ?? "??").substring(0, 2).toUpperCase()}
                </AvatarFallback>
              </Avatar>
              <div>
                <div className="font-display text-foreground">{data.fixerName ?? "(unknown fixer)"}</div>
                <div className="text-xs font-mono text-muted-foreground">Fixer who ran this job</div>
              </div>
            </div>
          ) : (
            <div className="font-mono text-muted-foreground italic">Fixer record unavailable.</div>
          )}
        </CardContent>
      </Card>

      <Card className="rounded-none border-border bg-card/50">
        <CardHeader>
          <CardTitle className="font-display tracking-widest text-xs uppercase text-muted-foreground">
            Runners ({data.participants.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="divide-y divide-border/40">
            {data.participants.map((p) => {
              const inner = (
                <div className="flex items-center gap-3 py-3">
                  <Avatar className="border border-nc-cyan/30 rounded-none w-10 h-10">
                    <AvatarImage src={p.characterPortraitUrl ?? undefined} />
                    <AvatarFallback className="bg-background text-nc-cyan rounded-none font-display text-xs">
                      {(p.characterName ?? "??").substring(0, 2).toUpperCase()}
                    </AvatarFallback>
                  </Avatar>
                  <div className="flex-1 min-w-0">
                    <div className="font-display text-foreground">
                      {p.characterName ?? <span className="text-muted-foreground italic">(deleted character)</span>}
                    </div>
                    {p.summary && p.summary !== data.summary && (
                      <div className="text-xs font-mono text-muted-foreground line-clamp-2">{p.summary}</div>
                    )}
                  </div>
                  <div className="text-right">
                    <div className="text-nc-yellow font-mono text-sm">
                      {p.payoutEddies ? `€$${p.payoutEddies.toLocaleString()}` : "—"}
                    </div>
                    <Badge
                      variant="outline"
                      className={`rounded-none text-[10px] mt-1 ${missionStatusClass(p.status)}`}
                    >
                      {missionStatusLabel(p.status)}
                    </Badge>
                  </div>
                </div>
              );
              return (
                <li key={p.entryId} data-testid={`row-participant-${p.entryId}`}>
                  {p.characterId ? (
                    <Link
                      href={`/directory/characters/${p.characterId}`}
                      className="block hover:bg-card/80 transition px-2 -mx-2"
                    >
                      {inner}
                    </Link>
                  ) : (
                    <div className="px-2 -mx-2">{inner}</div>
                  )}
                </li>
              );
            })}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
