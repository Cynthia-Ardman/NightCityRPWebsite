import { useParams } from "wouter";
import { useGetRipperdocPublic } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function DirectoryRipperdocDetail() {
  const { id } = useParams<{ id: string }>();
  const { data, isLoading } = useGetRipperdocPublic(Number(id));
  if (isLoading) return <div className="font-display text-nc-cyan animate-pulse">LOADING...</div>;
  if (!data) return <div className="font-display text-destructive">CLINIC NOT FOUND</div>;
  return (
    <div className="max-w-4xl mx-auto space-y-6 pb-12">
      <div>
        <h1 className="text-4xl font-display" data-testid="text-ripperdoc-name">{data.name}</h1>
        <p className="font-mono text-xs text-muted-foreground mt-1">{data.location ?? "—"}</p>
      </div>
      {data.description && <Card className="rounded-none border-border bg-card/50"><CardContent className="pt-6 font-mono text-sm whitespace-pre-wrap">{data.description}</CardContent></Card>}
      <Card className="rounded-none border-border bg-card/50">
        <CardHeader><CardTitle className="font-display tracking-widest">STAFF</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          {(data.employeeNames ?? []).length === 0 ? <p className="text-muted-foreground font-mono text-sm">No staff listed.</p> :
            (data.employeeNames ?? []).map((n, i) => (
              <div key={i} className="flex justify-between border-b border-border/30 py-2 text-sm font-mono" data-testid={`row-employee-${i}`}>
                <span>{n}</span>
              </div>
            ))}
        </CardContent>
      </Card>
    </div>
  );
}
