import { Link } from "wouter";
import { useListStores } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Store } from "lucide-react";

export default function DirectoryStores() {
  const { data, isLoading } = useListStores();
  return (
    <div className="max-w-6xl mx-auto space-y-6 pb-12">
      <div>
        <h1 className="text-4xl font-display text-foreground" data-testid="text-stores-title">STORE DIRECTORY</h1>
        <p className="font-mono text-muted-foreground mt-2">All registered storefronts in Night City.</p>
      </div>
      {isLoading ? (
        <div className="text-nc-cyan font-display animate-pulse">SCANNING...</div>
      ) : !data?.length ? (
        <Empty />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {data.map((s) => (
            <Link key={s.id} href={`/directory/stores/${s.id}`}>
              <Card className="rounded-none border-border bg-card/50 hover:border-nc-cyan transition-all cursor-pointer h-full" data-testid={`card-store-${s.id}`}>
                <CardHeader>
                  <CardTitle className="font-display text-xl">{s.name}</CardTitle>
                  <CardDescription className="font-mono text-xs">{s.location ?? "—"}</CardDescription>
                </CardHeader>
                <CardContent className="flex justify-between items-end">
                  <p className="text-xs font-mono text-muted-foreground line-clamp-2">{s.description ?? ""}</p>
                  <Badge variant="outline" className="rounded-none border-nc-yellow text-nc-yellow uppercase">{s.kind}</Badge>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
function Empty() {
  return (
    <div className="py-20 text-center border border-dashed border-border bg-card/30">
      <Store className="w-12 h-12 text-muted-foreground mx-auto mb-4 opacity-50" />
      <h3 className="font-display text-xl">NO STORES REGISTERED</h3>
    </div>
  );
}
