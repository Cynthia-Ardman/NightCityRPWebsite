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
import { BarChart3, Users } from "lucide-react";

export default function FixerReports() {
  const { data: actors, isLoading: actorsLoading } = useGetActorReport();
  const { data: attendance, isLoading: attLoading } = useGetAttendanceReport();

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
                  <TableHead className="font-display text-nc-cyan">Actor</TableHead>
                  <TableHead className="font-display text-nc-cyan text-right">Acts</TableHead>
                  <TableHead className="font-display text-nc-cyan text-right">Total Paid</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody className="font-mono text-sm">
                {actors.map((a) => (
                  <TableRow key={a.userId} className="border-border" data-testid={`row-actor-${a.userId}`}>
                    <TableCell className="text-foreground">{a.userName ?? a.userId}</TableCell>
                    <TableCell className="text-right">{a.actCount}</TableCell>
                    <TableCell className="text-right text-nc-yellow">€$ {a.totalPaid.toLocaleString()}</TableCell>
                  </TableRow>
                ))}
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
                  <TableHead className="font-display text-nc-cyan">Player</TableHead>
                  <TableHead className="font-display text-nc-cyan text-right">Missions Attended</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody className="font-mono text-sm">
                {attendance.map((p) => (
                  <TableRow key={p.userId} className="border-border" data-testid={`row-attendance-${p.userId}`}>
                    <TableCell className="text-foreground">{p.userName ?? p.userId}</TableCell>
                    <TableCell className="text-right text-nc-cyan">{p.attendedCount}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
