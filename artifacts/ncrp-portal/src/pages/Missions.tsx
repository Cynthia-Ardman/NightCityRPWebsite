import { Link } from "wouter";
import {
  useListMyMissions,
  useListMissions,
  getListMissionsQueryKey,
  type MissionSummary,
} from "@workspace/api-client-react";
import { useAuthMe } from "@/hooks/useAuthMe";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Briefcase, CalendarDays, MapPin, User, Users } from "lucide-react";
import {
  missionStatusClass,
  missionStatusLabel,
  missionTierClass,
  missionTierLabel,
} from "@/lib/missionStatus";

export default function Missions() {
  const { data: me } = useAuthMe();
  const isStaff = !!me && (me.isFixer || me.isAdmin);
  const isAdmin = !!me?.isAdmin;

  const mine = useListMyMissions();
  const all = useListMissions(undefined, {
    query: { enabled: isStaff, queryKey: getListMissionsQueryKey() },
  });

  return (
    <div className="max-w-5xl mx-auto space-y-8 pb-12">
      <div>
        <h1 className="text-3xl md:text-4xl font-display text-nc-magenta tracking-widest flex items-center gap-3">
          <Briefcase className="w-7 h-7" /> MISSIONS
        </h1>
        <p className="text-muted-foreground font-mono text-sm mt-1">
          Scheduled jobs run by fixers, with payouts to the players who show up.
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
              No missions scheduled anywhere yet.
            </div>
          ) : (
            <MissionCardList rows={all.data} isAdmin={isAdmin} />
          )}
        </section>
      )}
    </div>
  );
}

function MissionCardList({ rows, isAdmin }: { rows: MissionSummary[]; isAdmin: boolean }) {
  return (
    <div className="space-y-5">
      {rows.map((m) => (
        <MissionCard key={m.id} m={m} isAdmin={isAdmin} />
      ))}
    </div>
  );
}

function MissionCard({ m, isAdmin }: { m: MissionSummary; isAdmin: boolean }) {
  const when = m.startAt ? new Date(m.startAt) : null;
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
        {/* 2. Big, bold, color-coded status + tier */}
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={`inline-block font-display font-bold tracking-widest text-sm md:text-base px-3 py-1 border rounded-none uppercase ${missionStatusClass(
              m.status,
            )}`}
            data-testid={`status-mission-${m.id}`}
          >
            {missionStatusLabel(m.status)}
          </span>
          <span
            className={`inline-block font-display font-bold tracking-widest text-xs px-2 py-1 border rounded-none uppercase ${missionTierClass(
              m.tier,
            )}`}
            data-testid={`tier-mission-${m.id}`}
          >
            {missionTierLabel(m.tier)}
          </span>
        </div>
      </CardHeader>
      <CardContent className="space-y-4 font-mono text-sm">
        {/* 3. Description preview */}
        {m.descriptionPreview ? (
          <p className="text-foreground/90 whitespace-pre-wrap leading-relaxed">{m.descriptionPreview}</p>
        ) : (
          <p className="text-muted-foreground italic">No description provided.</p>
        )}

        {/* 4. Schedule */}
        <div className="flex items-center gap-2 text-muted-foreground">
          <CalendarDays className="w-4 h-4 shrink-0" />
          {when ? (
            <span>
              {when.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" })}{" "}
              {when.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
              {m.durationMinutes ? ` · ${m.durationMinutes} min` : ""}
            </span>
          ) : (
            <span className="italic">Not scheduled</span>
          )}
        </div>

        {/* 5. Location */}
        {m.location && (
          <div className="flex items-center gap-2 text-muted-foreground">
            <MapPin className="w-4 h-4 shrink-0" />
            <span>{m.location}</span>
          </div>
        )}

        {/* 6. Slots + player pay */}
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-muted-foreground">
          <span className="flex items-center gap-2">
            <Users className="w-4 h-4 shrink-0" />
            {m.assignedCount}
            {m.slots > 0 ? ` / ${m.slots}` : ""} players
          </span>
          <span className="text-nc-yellow">Player pay: €${m.playerPay.toLocaleString()}</span>
        </div>

        {/* 7. Fixer (clickable for admins) */}
        <div className="flex items-center gap-2">
          <User className="w-4 h-4 shrink-0 text-muted-foreground" />
          <span className="text-muted-foreground uppercase text-xs tracking-widest">Fixer:</span>
          <FixerLink fixerId={m.fixerId} fixerName={m.fixerName} isAdmin={isAdmin} />
        </div>

        {/* 8. Players (clickable) */}
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

function PlayerLinks({ m }: { m: MissionSummary }) {
  // The caller's own assigned character routes to the rich owner page; everyone
  // else routes to the directory profile (visible to owners, fixers, admins).
  const players = m.players ?? [];
  if (players.length === 0) {
    return <span className="text-muted-foreground">—</span>;
  }
  return (
    <div className="flex flex-wrap gap-x-2 gap-y-1">
      {players.map((p, i) => {
        const href =
          m.myCharacterId === p.characterId
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
