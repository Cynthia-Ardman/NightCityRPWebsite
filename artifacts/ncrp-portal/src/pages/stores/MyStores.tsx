import { Link } from "wouter";
import { useListMyStores } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Store } from "lucide-react";

export default function MyStores() {
  const { data, isLoading } = useListMyStores();
  return (
    <div className="max-w-6xl mx-auto space-y-6 pb-12">
      <h1 className="text-4xl font-display" data-testid="text-my-stores-title">MY STORES</h1>
      {isLoading ? <div className="text-nc-cyan font-display animate-pulse">LOADING...</div> :
        !data?.length ? (
          <div className="py-20 text-center border border-dashed border-border bg-card/30">
            <Store className="w-12 h-12 text-muted-foreground mx-auto mb-4 opacity-50" />
            <h3 className="font-display text-xl">NO STORES ASSIGNED</h3>
            <p className="font-mono text-sm text-muted-foreground mt-2">Contact an admin to register a store.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {data.map((s) => (
              <Link key={s.id} href={`/stores/${s.id}`}>
                <Card className="rounded-none border-border bg-card/50 hover:border-nc-cyan transition-all cursor-pointer" data-testid={`card-mystore-${s.id}`}>
                  <CardHeader><CardTitle className="font-display">{s.name}</CardTitle></CardHeader>
                  <CardContent className="flex justify-between">
                    <span className="font-mono text-xs text-muted-foreground">{s.location ?? "—"}</span>
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
