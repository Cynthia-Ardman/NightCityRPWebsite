import { Link } from "wouter";
import { useListRipperdocs } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Syringe } from "lucide-react";

export default function DirectoryRipperdocs() {
  const { data, isLoading } = useListRipperdocs();
  return (
    <div className="max-w-6xl mx-auto space-y-6 pb-12">
      <div>
        <h1 className="text-4xl font-display" data-testid="text-ripperdocs-title">RIPPERDOC DIRECTORY</h1>
        <p className="font-mono text-muted-foreground mt-2">Find a ripperdoc for your next upgrade.</p>
      </div>
      {isLoading ? <div className="text-nc-cyan font-display animate-pulse">SCANNING...</div> :
        !data?.length ? (
          <div className="py-20 text-center border border-dashed border-border bg-card/30">
            <Syringe className="w-12 h-12 text-muted-foreground mx-auto mb-4 opacity-50" />
            <h3 className="font-display text-xl">NO RIPPERDOCS REGISTERED</h3>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {data.map((r) => (
              <Link key={r.id} href={`/directory/ripperdocs/${r.id}`}>
                <Card className="rounded-none border-border bg-card/50 hover:border-nc-magenta transition-all cursor-pointer h-full" data-testid={`card-ripperdoc-${r.id}`}>
                  <CardHeader>
                    <CardTitle className="font-display text-xl">{r.name}</CardTitle>
                    <CardDescription className="font-mono text-xs">{r.location ?? "—"}</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <p className="text-xs font-mono text-muted-foreground line-clamp-2">{r.description ?? ""}</p>
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
        )}
    </div>
  );
}
