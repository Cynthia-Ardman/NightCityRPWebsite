import { Fragment, useState } from "react";
import { Link } from "wouter";
import { useGetActorReport, useGetAttendanceReport } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { BarChart3, Users, ChevronDown, ChevronRight } from "lucide-react";

function fmtDate(d: string | null | undefined): string {
  if (!d) return "—";
  const parsed = new Date(d);
  return Number.isNaN(parsed.getTime()) ? "—" : parsed.toLocaleDateString();
}

export default function FixerReports() {
  const { data: actors, isLoading: actorsLoading } = useGetActorReport();
  const { data: attendance, isLoading: attLoading } = useGetAttendanceReport();
  const [openActors, setOpenActors] = useState<Record<string, boolean>>({});
  const [openPlayers, setOpenPlayers] = useState<Record<string, boolean>>({});

  return (
    <div className="max-w-6xl mx-auto space-y-6 pb-12">
      <div className="flex items-center justify-between">
        <h1 className="text-4xl font-display flex items-center gap-3" data-testid="text-reports-title">
          <BarChart3 className="w-7 h-7 text-nc-cyan" /> MISSION REPORTS
        </h1>
        <Link href="/fixer/missions" className="text-nc-magenta font-mono text-xs hover:underline">
          ← missions
        </Link>
      </div>

      <Card className="rounded-none border-border bg-card/50">
        <CardHeader>
          <CardTitle className="font-display tracking-widest flex items-center gap-2">
            <Users className="w-4 h-4 text-nc-magenta" /> ACTOR PAYMENTS
          </CardTitle>
        </CardHeader>
        <CardContent>
          {actorsLoading ? (
            <div className="font-mono text-nc-cyan animate-pulse">Loading actor report...</div>
          ) : !actors || actors.length === 0 ? (
            <p className="font-mono text-muted-foreground italic">No actor payments recorded.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="font-display text-nc-cyan w-8"></TableHead>
                  <TableHead className="font-display text-nc-cyan">Actor</TableHead>
                  <TableHead className="font-display text-nc-cyan text-right">Acts</TableHead>
                  <TableHead className="font-display text-nc-cyan text-right">Total Paid</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody className="font-mono text-sm">
                {actors.map((a) => {
                  const isOpen = !!openActors[a.userId];
                  return (
                    <Fragment key={a.userId}>
                      <TableRow
                        className="border-border cursor-pointer"
                        data-testid={`row-actor-${a.userId}`}
                        onClick={() => setOpenActors((s) => ({ ...s, [a.userId]: !s[a.userId] }))}
                      >
                        <TableCell className="text-muted-foreground">
                          {a.missions.length > 0 ? (
                            isOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />
                          ) : null}
                        </TableCell>
                        <TableCell className="text-foreground">{a.userName ?? a.userId}</TableCell>
                        <TableCell className="text-right">{a.actCount}</TableCell>
                        <TableCell className="text-right text-nc-yellow">€$ {a.totalPaid.toLocaleString()}</TableCell>
                      </TableRow>
                      {isOpen &&
                        a.missions.map((m, i) => (
                          <TableRow
                            key={`${a.userId}-${m.missionId}-${i}`}
                            className="border-border bg-muted/20"
                            data-testid={`row-actor-mission-${a.userId}-${m.missionId}`}
                          >
                            <TableCell></TableCell>
                            <TableCell className="text-muted-foreground pl-6">
                              {m.missionName ?? `Mission #${m.missionId}`}
                            </TableCell>
                            <TableCell className="text-right text-muted-foreground">{fmtDate(m.missionDate)}</TableCell>
                            <TableCell className="text-right text-nc-yellow/80">
                              €$ {m.amount.toLocaleString()}
                            </TableCell>
                          </TableRow>
                        ))}
                    </Fragment>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card className="rounded-none border-border bg-card/50">
        <CardHeader>
          <CardTitle className="font-display tracking-widest flex items-center gap-2">
            <Users className="w-4 h-4 text-nc-cyan" /> PLAYER ATTENDANCE
          </CardTitle>
        </CardHeader>
        <CardContent>
          {attLoading ? (
            <div className="font-mono text-nc-cyan animate-pulse">Loading attendance report...</div>
          ) : !attendance || attendance.length === 0 ? (
            <p className="font-mono text-muted-foreground italic">No attendance recorded.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="font-display text-nc-cyan w-8"></TableHead>
                  <TableHead className="font-display text-nc-cyan">Player</TableHead>
                  <TableHead className="font-display text-nc-cyan text-right">Missions Attended</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody className="font-mono text-sm">
                {attendance.map((p) => {
                  const isOpen = !!openPlayers[p.userId];
                  return (
                    <Fragment key={p.userId}>
                      <TableRow
                        className="border-border cursor-pointer"
                        data-testid={`row-attendance-${p.userId}`}
                        onClick={() => setOpenPlayers((s) => ({ ...s, [p.userId]: !s[p.userId] }))}
                      >
                        <TableCell className="text-muted-foreground">
                          {p.missions.length > 0 ? (
                            isOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />
                          ) : null}
                        </TableCell>
                        <TableCell className="text-foreground">{p.userName ?? p.userId}</TableCell>
                        <TableCell className="text-right text-nc-cyan">{p.attendedCount}</TableCell>
                      </TableRow>
                      {isOpen &&
                        p.missions.map((m, i) => (
                          <TableRow
                            key={`${p.userId}-${m.missionId}-${i}`}
                            className="border-border bg-muted/20"
                            data-testid={`row-attendance-mission-${p.userId}-${m.missionId}`}
                          >
                            <TableCell></TableCell>
                            <TableCell className="text-muted-foreground pl-6">
                              {m.missionName ?? `Mission #${m.missionId}`}
                              {m.characterName ? (
                                <span className="text-nc-magenta/80"> · {m.characterName}</span>
                              ) : null}
                            </TableCell>
                            <TableCell className="text-right text-muted-foreground">{fmtDate(m.missionDate)}</TableCell>
                          </TableRow>
                        ))}
                    </Fragment>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
