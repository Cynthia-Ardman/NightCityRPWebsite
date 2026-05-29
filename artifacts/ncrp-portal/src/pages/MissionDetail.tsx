import { useState } from "react";
import { Link, useParams } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetMission,
  usePayMissionPlayers,
  usePayMissionActors,
  getGetMissionQueryKey,
  type MissionDetail as MissionDetailModel,
  type MissionAssignmentView,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Briefcase,
  ArrowLeft,
  CalendarDays,
  MapPin,
  Users,
  Pencil,
  AlertTriangle,
  CheckCircle2,
} from "lucide-react";
import {
  missionStatusClass,
  missionStatusLabel,
  missionTierClass,
  missionTierLabel,
} from "@/lib/missionStatus";
import { MissionTestModeBanner } from "@/components/MissionTestModeBanner";

function errOf(e: unknown): string | null {
  const r = (e as { response?: { data?: { error?: string } } } | null)?.response?.data?.error;
  return r ?? (e ? "Request failed" : null);
}

export default function MissionDetail() {
  const { id } = useParams();
  const missionId = Number(id);
  const { data, isLoading, error } = useGetMission(missionId, {
    query: { enabled: Number.isInteger(missionId), queryKey: getGetMissionQueryKey(missionId) },
  });

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

  const when = data.startAt ? new Date(data.startAt) : null;

  return (
    <div className="max-w-4xl mx-auto space-y-6 pb-12">
      <Link
        href="/missions"
        className="text-nc-cyan font-mono text-sm hover:underline inline-flex items-center gap-1"
        data-testid="link-back-missions"
      >
        <ArrowLeft className="w-4 h-4" /> back to missions
      </Link>

      <MissionTestModeBanner live={data.live} />

      {data.imageUrl && (
        <div className="w-full overflow-hidden border border-border rounded-none bg-card/40">
          <img src={data.imageUrl} alt={data.title} className="w-full max-h-72 object-cover" />
        </div>
      )}

      <div>
        <div className="flex items-center gap-3 text-nc-magenta">
          <Briefcase className="w-6 h-6" />
          <span className="font-display text-xs uppercase tracking-widest">Mission</span>
        </div>
        <h1 className="text-3xl md:text-4xl font-display text-foreground tracking-wider mt-1" data-testid="text-mission-title">
          {data.title}
        </h1>
        <div className="flex flex-wrap gap-2 mt-3 items-center">
          <Badge variant="outline" className={`rounded-none font-bold tracking-widest uppercase ${missionStatusClass(data.status)}`}>
            {missionStatusLabel(data.status)}
          </Badge>
          <Badge variant="outline" className={`rounded-none font-bold tracking-widest uppercase ${missionTierClass(data.tier)}`}>
            {missionTierLabel(data.tier)}
          </Badge>
          <span className="text-nc-yellow font-mono text-xs uppercase tracking-widest">
            Player pay €${data.playerPay.toLocaleString()}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 font-mono text-sm">
        <div className="flex items-center gap-2 text-muted-foreground border border-border bg-card/40 p-3">
          <CalendarDays className="w-4 h-4 shrink-0" />
          {when ? (
            <span>
              {when.toLocaleDateString()} {when.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
              {data.durationMinutes ? ` · ${data.durationMinutes}m` : ""}
            </span>
          ) : (
            <span className="italic">Not scheduled</span>
          )}
        </div>
        <div className="flex items-center gap-2 text-muted-foreground border border-border bg-card/40 p-3">
          <MapPin className="w-4 h-4 shrink-0" />
          <span>{data.location || <span className="italic">No location</span>}</span>
        </div>
        <div className="flex items-center gap-2 text-muted-foreground border border-border bg-card/40 p-3">
          <Users className="w-4 h-4 shrink-0" />
          <span>
            {data.assignments.length}
            {data.slots > 0 ? ` / ${data.slots}` : ""} players
          </span>
        </div>
      </div>

      {data.canManage ? (
        <Tabs defaultValue="player" className="w-full">
          <TabsList className="rounded-none bg-card/60 border border-border">
            <TabsTrigger value="player" className="rounded-none font-display tracking-widest" data-testid="tab-player">
              PLAYER
            </TabsTrigger>
            <TabsTrigger value="fixer" className="rounded-none font-display tracking-widest" data-testid="tab-fixer">
              FIXER
            </TabsTrigger>
          </TabsList>
          <TabsContent value="player" className="mt-4 space-y-6">
            <PlayerView data={data} />
          </TabsContent>
          <TabsContent value="fixer" className="mt-4 space-y-6">
            <FixerView data={data} />
          </TabsContent>
        </Tabs>
      ) : (
        <PlayerView data={data} />
      )}
    </div>
  );
}

function PlayerView({ data }: { data: MissionDetailModel }) {
  return (
    <>
      {data.description && (
        <Card className="rounded-none border-border bg-card/50">
          <CardHeader>
            <CardTitle className="font-display tracking-widest text-xs uppercase text-muted-foreground">Brief</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="font-mono text-sm whitespace-pre-wrap text-foreground">{data.description}</p>
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
                <div className="text-xs font-mono text-muted-foreground">Fixer running this job</div>
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
            Players ({data.assignments.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {data.assignments.length === 0 ? (
            <p className="font-mono text-muted-foreground italic">No players assigned yet.</p>
          ) : (
            <ul className="divide-y divide-border/40">
              {data.assignments.map((a) => (
                <li key={a.id} data-testid={`row-assignment-${a.id}`}>
                  <AssignmentRow a={a} />
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </>
  );
}

function AssignmentRow({ a }: { a: MissionAssignmentView }) {
  const inner = (
    <div className="flex items-center gap-3 py-3">
      <Avatar className="border border-nc-cyan/30 rounded-none w-10 h-10">
        <AvatarImage src={a.characterPortraitUrl ?? a.userAvatarUrl ?? undefined} />
        <AvatarFallback className="bg-background text-nc-cyan rounded-none font-display text-xs">
          {(a.characterName ?? a.userName ?? "??").substring(0, 2).toUpperCase()}
        </AvatarFallback>
      </Avatar>
      <div className="flex-1 min-w-0">
        <div className="font-display text-foreground">
          {a.characterName ?? <span className="text-muted-foreground italic">(no character)</span>}
        </div>
        {a.userName && <div className="text-xs font-mono text-muted-foreground">{a.userName}</div>}
      </div>
      <div className="text-right space-y-1">
        {a.attendanceCreditedAt && (
          <div className="text-[10px] font-mono text-green-400 inline-flex items-center gap-1">
            <CheckCircle2 className="w-3 h-3" /> Attended
          </div>
        )}
        <PaymentBadge status={a.paymentStatus} amount={a.payAmount} error={a.paymentError} />
      </div>
    </div>
  );
  return a.characterId ? (
    <Link href={`/directory/characters/${a.characterId}`} className="block hover:bg-card/80 transition px-2 -mx-2">
      {inner}
    </Link>
  ) : (
    <div className="px-2 -mx-2">{inner}</div>
  );
}

function PaymentBadge({
  status,
  amount,
  error,
}: {
  status: string;
  amount?: number | null;
  error?: string | null;
}) {
  const cls =
    status === "paid"
      ? "border-green-500 text-green-400 bg-green-500/10"
      : status === "failed"
        ? "border-destructive text-destructive bg-destructive/10"
        : "border-nc-yellow text-nc-yellow bg-nc-yellow/10";
  const label = status === "paid" ? "Paid" : status === "failed" ? "Failed" : "Unpaid";
  return (
    <div className="inline-flex flex-col items-end gap-0.5">
      <Badge variant="outline" className={`rounded-none text-[10px] ${cls}`}>
        {label}
        {amount ? ` €$${amount.toLocaleString()}` : ""}
      </Badge>
      {error && <span className="text-[10px] font-mono text-destructive max-w-[12rem] truncate" title={error}>{error}</span>}
    </div>
  );
}

function FixerView({ data }: { data: MissionDetailModel }) {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: getGetMissionQueryKey(data.id) });

  const payPlayers = usePayMissionPlayers({ mutation: { onSuccess: invalidate } });
  const payActors = usePayMissionActors({ mutation: { onSuccess: invalidate } });

  const [actorIds, setActorIds] = useState<string[]>([]);
  const [actorAmount, setActorAmount] = useState(0);

  const toggleActor = (userId: string) =>
    setActorIds((prev) => (prev.includes(userId) ? prev.filter((x) => x !== userId) : [...prev, userId]));

  const playersPaid = data.status === "completed_players_paid" || data.status === "completed_paid";
  const payPlayersErr = errOf(payPlayers.error);
  const payActorsErr = errOf(payActors.error);

  return (
    <>
      {data.discordSyncError && (
        <div className="border border-destructive bg-destructive/10 text-destructive font-mono text-xs p-3 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <span>Discord event sync error: {data.discordSyncError}</span>
        </div>
      )}

      <Card className="rounded-none border-border bg-card/50">
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="font-display tracking-widest text-xs uppercase text-muted-foreground">
            Mission Tools
          </CardTitle>
          <Link
            href={`/fixer/missions?edit=${data.id}`}
            className="text-nc-cyan font-mono text-xs hover:underline inline-flex items-center gap-1"
            data-testid="link-edit-mission"
          >
            <Pencil className="w-3 h-3" /> edit
          </Link>
        </CardHeader>
        <CardContent className="space-y-4 font-mono text-sm">
          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              disabled={payPlayers.isPending || playersPaid || data.assignments.length === 0}
              onClick={() => payPlayers.mutate({ id: data.id })}
              className="rounded-none bg-nc-magenta text-background hover:bg-nc-magenta/80 font-display tracking-widest"
              data-testid="button-pay-players"
            >
              {payPlayers.isPending ? "PAYING..." : playersPaid ? "PLAYERS PAID" : "PAY PLAYERS"}
            </Button>
            <span className="text-muted-foreground text-xs">
              Pays €${data.playerPay.toLocaleString()} to each attending player and credits attendance.
            </span>
          </div>
          {payPlayersErr && <div className="text-destructive text-xs" data-testid="text-pay-players-error">{payPlayersErr}</div>}
        </CardContent>
      </Card>

      <Card className="rounded-none border-border bg-card/50">
        <CardHeader>
          <CardTitle className="font-display tracking-widest text-xs uppercase text-muted-foreground">
            Pay Actors / NPCs
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 font-mono text-sm">
          <p className="text-muted-foreground text-xs">
            Select assigned players who acted as NPCs and pay them a separate actor fee.
          </p>
          {data.assignments.length === 0 ? (
            <p className="text-muted-foreground italic">No assigned players to pay as actors.</p>
          ) : (
            <div className="space-y-2">
              {data.assignments.map((a) => (
                <label key={a.id} className="flex items-center gap-2 cursor-pointer" data-testid={`actor-pick-${a.userId}`}>
                  <input
                    type="checkbox"
                    checked={actorIds.includes(a.userId)}
                    onChange={() => toggleActor(a.userId)}
                  />
                  <span className="text-foreground">{a.characterName ?? a.userName ?? a.userId}</span>
                  {a.userName && a.characterName && (
                    <span className="text-muted-foreground text-xs">({a.userName})</span>
                  )}
                </label>
              ))}
            </div>
          )}
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <Label className="text-xs">ACTOR FEE €$</Label>
              <Input
                type="number"
                min={0}
                value={actorAmount || ""}
                onChange={(e) => setActorAmount(Number(e.target.value))}
                className="rounded-none w-40"
                data-testid="input-actor-amount"
              />
            </div>
            <Button
              type="button"
              disabled={payActors.isPending || actorIds.length === 0 || actorAmount <= 0}
              onClick={() =>
                payActors.mutate(
                  { id: data.id, data: { userIds: actorIds, amount: actorAmount } },
                  {
                    onSuccess: () => {
                      setActorIds([]);
                      setActorAmount(0);
                    },
                  },
                )
              }
              className="rounded-none bg-nc-cyan text-background hover:bg-nc-cyan/80 font-display tracking-widest"
              data-testid="button-pay-actors"
            >
              {payActors.isPending ? "PAYING..." : "PAY ACTORS"}
            </Button>
          </div>
          {payActorsErr && <div className="text-destructive text-xs" data-testid="text-pay-actors-error">{payActorsErr}</div>}
        </CardContent>
      </Card>

      {data.actorPayments.length > 0 && (
        <Card className="rounded-none border-border bg-card/50">
          <CardHeader>
            <CardTitle className="font-display tracking-widest text-xs uppercase text-muted-foreground">
              Actor Payments ({data.actorPayments.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="divide-y divide-border/40 font-mono text-sm">
              {data.actorPayments.map((p) => (
                <li key={p.id} className="flex items-center justify-between py-2" data-testid={`row-actor-payment-${p.id}`}>
                  <span className="text-foreground">{p.characterName ?? p.userName ?? p.userId}</span>
                  <span className="flex items-center gap-2">
                    <span className="text-muted-foreground text-xs uppercase">{p.source}</span>
                    <PaymentBadge status={p.paymentStatus} amount={p.amount} error={p.paymentError} />
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </>
  );
}
