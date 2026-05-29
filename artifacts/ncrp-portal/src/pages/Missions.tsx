import { Link } from "wouter";
import {
  useListMyMissions,
  useListAllMissions,
  getListAllMissionsQueryKey,
  type MissionGroupSummary,
} from "@workspace/api-client-react";
import { useAuthMe } from "@/hooks/useAuthMe";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Briefcase, CalendarDays, User, Users } from "lucide-react";
import { missionStatusClass, missionStatusLabel } from "@/lib/missionStatus";

export default function Missions() {
  const { data: me } = useAuthMe();
  const isStaff = !!me && (me.isFixer || me.isAdmin);
  const isAdmin = !!me?.isAdmin;

  const mine = useListMyMissions();
  const all = useListAllMissions(undefined, {
    query: { enabled: isStaff, queryKey: getListAllMissionsQueryKey() },
  });

  return (
    <div className="max-w-5xl mx-auto space-y-8 pb-12">
      <div>
        <h1 className="text-3xl md:text-4xl font-display text-nc-magenta tracking-widest flex items-center gap-3">
          <Briefcase className="w-7 h-7" /> MISSIONS
        </h1>
        <p className="text-muted-foreground font-mono text-sm mt-1">
          Jobs logged by fixers, with payouts to your characters.
        </p>
      </div>

      <section className="space-y-4">
        <h2 className="font-display tracking-widest text-lg">YOUR MISSIONS</h2>
        {mine.isLoading ? (
          <div className="font-mono text-nc-cyan animate-pulse">Loading...</div>
        ) : !mine.data || mine.data.length === 0 ? (
          <div className="font-mono text-muted-foreground italic">No missions yet.</div>
        ) : (
          <MissionCardList rows={mine.data} isAdmin={isAdmin} />
        )}
      </section>

      {isStaff && (
        <section className="space-y-4" data-testid="card-all-missions">
          <h2 className="font-display tracking-widest text-lg text-nc-cyan">
            ALL MISSIONS{" "}
            <span className="text-xs text-muted-foreground font-mono">(fixer/admin)</span>
          </h2>
          {all.isLoading ? (
            <div className="font-mono text-nc-cyan animate-pulse">Loading...</div>
          ) : !all.data || all.data.length === 0 ? (
            <div className="font-mono text-muted-foreground italic">
              No missions logged anywhere yet.
            </div>
          ) : (
            <MissionCardList rows={all.data} isAdmin={isAdmin} />
          )}
        </section>
      )}
    </div>
  );
}

function MissionCardList({ rows, isAdmin }: { rows: MissionGroupSummary[]; isAdmin: boolean }) {
  return (
    <div className="space-y-5">
      {rows.map((m) => (
        <MissionCard key={m.id} m={m} isAdmin={isAdmin} />
      ))}
    </div>
  );
}

function MissionCard({ m, isAdmin }: { m: MissionGroupSummary; isAdmin: boolean }) {
  const when = new Date(m.occurredAt ?? m.createdAt);
  return (
    <Card
      className="rounded-none border-border bg-card/50 hover:border-nc-cyan/50 transition-colors"
      data-testid={`row-mission-${m.id}`}
    >
      <CardHeader className="space-y-3">
        {/* 1. Dominant title */}
        <Link href={`/missions/${m.id}`}>
          <CardTitle className="font-display text-2xl md:text-3xl leading-tight text-foreground hover:text-nc-cyan transition-colors cursor-pointer break-words">
            {m.title}
          </CardTitle>
        </Link>
        {/* 2. Big, bold, color-coded status */}
        <div>
          <span
            className={`inline-block font-display font-bold tracking-widest text-sm md:text-base px-3 py-1 border rounded-none uppercase ${missionStatusClass(
              m.status,
            )}`}
            data-testid={`status-mission-${m.id}`}
          >
            {missionStatusLabel(m.status)}
          </span>
        </div>
      </CardHeader>
      <CardContent className="space-y-4 font-mono text-sm">
        {/* 3. Full description, never truncated */}
        {m.summary ? (
          <p className="text-foreground/90 whitespace-pre-wrap leading-relaxed">{m.summary}</p>
        ) : (
          <p className="text-muted-foreground italic">No description provided.</p>
        )}

        {/* 4. Date */}
        <div className="flex items-center gap-2 text-muted-foreground">
          <CalendarDays className="w-4 h-4 shrink-0" />
          <span>{when.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" })}</span>
        </div>

        {/* 5. Fixer (clickable for admins) */}
        <div className="flex items-center gap-2">
          <User className="w-4 h-4 shrink-0 text-muted-foreground" />
          <span className="text-muted-foreground uppercase text-xs tracking-widest">Fixer:</span>
          <FixerLink fixerId={m.fixerId} fixerName={m.fixerName} isAdmin={isAdmin} />
        </div>

        {/* 6. Players (clickable) */}
        <div className="flex items-start gap-2">
          <Users className="w-4 h-4 shrink-0 text-muted-foreground mt-0.5" />
          <span className="text-muted-foreground uppercase text-xs tracking-widest mt-0.5">Players:</span>
          <PlayerLinks m={m} />
        </div>
      </CardContent>
    </Card>
  );
}

function FixerLink({
  fixerId,
  fixerName,
  isAdmin,
}: {
  fixerId: string | null | undefined;
  fixerName: string | null | undefined;
  isAdmin: boolean;
}) {
  if (!fixerName) return <span className="text-muted-foreground">—</span>;
  // Only admins have a user profile route to link to. Everyone else sees the
  // name as plain text (graceful degradation — there is no public fixer page).
  if (isAdmin && fixerId) {
    return (
      <Link
        href={`/admin/users/${fixerId}`}
        className="text-nc-magenta hover:underline font-semibold"
        data-testid={`link-fixer-${fixerId}`}
      >
        {fixerName}
      </Link>
    );
  }
  return <span className="text-nc-magenta font-semibold">{fixerName}</span>;
}

function PlayerLinks({ m }: { m: MissionGroupSummary }) {
  // Characters the caller owns get the rich owner page; everyone else routes to
  // the directory profile (visible to owners, fixers, and admins).
  const mineIds = new Set((m.myCharacters ?? []).map((c) => c.id));
  const players = m.players ?? [];
  if (players.length === 0) {
    if (m.participantCount > 0) {
      return (
        <span className="text-muted-foreground italic">
          {m.participantCount} player{m.participantCount === 1 ? "" : "s"} (legacy)
        </span>
      );
    }
    return <span className="text-muted-foreground">—</span>;
  }
  return (
    <div className="flex flex-wrap gap-x-2 gap-y-1">
      {players.map((p, i) => {
        const href = mineIds.has(p.characterId)
          ? `/characters/${p.characterId}`
          : `/directory/characters/${p.characterId}`;
        return (
          <span key={p.characterId} className="inline-flex items-center">
            <Link
              href={href}
              className="text-nc-cyan hover:underline"
              data-testid={`link-player-${p.characterId}`}
            >
              {p.name}
            </Link>
            {i < players.length - 1 ? <span className="text-muted-foreground">,</span> : null}
          </span>
        );
      })}
    </div>
  );
}
