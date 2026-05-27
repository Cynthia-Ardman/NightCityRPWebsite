import { useListPendingSheets } from "@workspace/api-client-react";
import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { FileText, Clock } from "lucide-react";
import { Badge } from "@/components/ui/badge";

export default function PendingSheets() {
  const { data: sheets, isLoading } = useListPendingSheets();

  return (
    <div className="space-y-8 max-w-6xl mx-auto pb-12">
      <div>
        <h1 className="text-4xl font-display font-bold text-foreground flex items-center gap-3" data-testid="text-pending-title">
          <Clock className="w-8 h-8 text-nc-yellow" /> PENDING SHEETS
        </h1>
        <p className="text-muted-foreground font-mono mt-2">Approve or reject character submissions.</p>
      </div>

      {isLoading ? (
        <div className="py-20 text-center text-nc-cyan animate-pulse font-display text-xl">LOADING_QUEUE...</div>
      ) : sheets?.length === 0 ? (
        <div className="py-20 text-center border border-dashed border-border bg-card/30">
          <FileText className="w-12 h-12 text-muted-foreground mx-auto mb-4 opacity-50" />
          <h3 className="text-xl font-display text-foreground mb-2">QUEUE EMPTY</h3>
          <p className="text-muted-foreground font-mono text-sm">No pending sheets require attention.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {sheets?.map((sheet: any) => (
            <Link key={sheet.id} href={`/sheets/${sheet.id}`}>
              <Card className="rounded-none border-border bg-card/50 hover:border-nc-yellow hover:shadow-[0_0_15px_rgba(255,255,0,0.1)] transition-all cursor-pointer h-full flex flex-col" data-testid={`card-pending-sheet-${sheet.id}`}>
                <CardHeader>
                  <CardTitle className="text-xl font-display truncate">{sheet.name}</CardTitle>
                  <CardDescription className="font-mono text-xs">
                    By {sheet.ownerName || sheet.ownerId}
                  </CardDescription>
                </CardHeader>
                <CardContent className="mt-auto flex justify-between items-center border-t border-border/50 pt-4">
                  <div className="text-xs font-mono text-muted-foreground">
                    {new Date(sheet.createdAt).toLocaleDateString()}
                  </div>
                  <Badge variant="outline" className="border-nc-yellow text-nc-yellow rounded-none animate-pulse">REVIEW REQ</Badge>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
