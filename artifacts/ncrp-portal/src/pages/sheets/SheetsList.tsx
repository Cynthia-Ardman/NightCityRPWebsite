import { useListMySheets } from "@workspace/api-client-react";
import { Link } from "wouter";
import { Plus, FileText, CheckCircle, XCircle, Clock } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

export default function SheetsList() {
  const { data: sheets, isLoading } = useListMySheets();

  return (
    <div className="space-y-8 max-w-6xl mx-auto pb-12">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-4xl font-display font-bold text-foreground" data-testid="text-sheets-title">CHARACTER SHEETS</h1>
          <p className="text-muted-foreground font-mono mt-2">Manage your submitted character applications.</p>
        </div>
        <Button asChild className="rounded-none bg-nc-cyan text-background hover:bg-nc-cyan/80 font-display font-bold tracking-widest" data-testid="button-new-sheet">
          <Link href="/sheets/new"><Plus className="w-4 h-4 mr-2" /> NEW_SHEET</Link>
        </Button>
      </div>

      {isLoading ? (
        <div className="py-20 text-center text-nc-cyan animate-pulse font-display text-xl">SCANNING_ARCHIVES...</div>
      ) : sheets?.length === 0 ? (
        <div className="py-20 text-center border border-dashed border-border bg-card/30">
          <FileText className="w-12 h-12 text-muted-foreground mx-auto mb-4 opacity-50" />
          <h3 className="text-xl font-display text-foreground mb-2">NO SHEETS FOUND</h3>
          <p className="text-muted-foreground font-mono text-sm">You haven't submitted any character sheets yet.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {sheets?.map(sheet => (
            <Link key={sheet.id} href={`/sheets/${sheet.id}`}>
              <Card className="rounded-none border-border bg-card/50 hover:border-nc-cyan hover:shadow-[0_0_15px_rgba(0,255,255,0.1)] transition-all cursor-pointer h-full flex flex-col" data-testid={`card-sheet-${sheet.id}`}>
                <CardHeader>
                  <CardTitle className="text-xl font-display truncate">{sheet.name}</CardTitle>
                  <CardDescription className="font-mono text-xs">
                    {sheet.data.archetype} // {sheet.data.age} Y/O
                  </CardDescription>
                </CardHeader>
                <CardContent className="mt-auto flex justify-between items-center border-t border-border/50 pt-4">
                  <div className="text-xs font-mono text-muted-foreground">
                    {new Date(sheet.createdAt).toLocaleDateString()}
                  </div>
                  {sheet.status === 'approved' && (
                    <Badge variant="outline" className="border-nc-cyan text-nc-cyan rounded-none"><CheckCircle className="w-3 h-3 mr-1"/> APPROVED</Badge>
                  )}
                  {sheet.status === 'pending' && (
                    <Badge variant="outline" className="border-nc-yellow text-nc-yellow rounded-none"><Clock className="w-3 h-3 mr-1"/> PENDING</Badge>
                  )}
                  {sheet.status === 'rejected' && (
                    <Badge variant="outline" className="border-destructive text-destructive rounded-none"><XCircle className="w-3 h-3 mr-1"/> REJECTED</Badge>
                  )}
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
