import { Link, useParams } from "wouter";
import { useGetRipperdocPublic } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Settings } from "lucide-react";
import { useAuthMe } from "@/hooks/useAuthMe";

export default function DirectoryRipperdocDetail() {
  const { id } = useParams<{ id: string }>();
  const { data, isLoading } = useGetRipperdocPublic(Number(id));
  const { data: me } = useAuthMe();
  const isStaff = !!me && (me.isAdmin || me.isFixer);
  const isOwner = !!me && !!data?.ownerId && me.id === data.ownerId;
  const canManage = isStaff || isOwner;
  if (isLoading) return <div className="font-display text-nc-cyan animate-pulse">LOADING...</div>;
  if (!data) return <div className="font-display text-destructive">CLINIC NOT FOUND</div>;
  return (
    <div className="max-w-7xl mx-auto space-y-6 pb-12">
      {data.bannerUrl && (
        <div className="w-full overflow-hidden border border-nc-magenta/40 bg-black/30">
          <img
            src={data.bannerUrl}
            alt={`${data.name} banner`}
            className="w-full max-h-72 object-cover"
            data-testid="img-ripperdoc-banner"
          />
        </div>
      )}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-4xl font-display" data-testid="text-ripperdoc-name">{data.name}</h1>
          <p className="font-mono text-xs text-muted-foreground mt-1">{data.location ?? "—"}</p>
          <p className="font-mono text-xs text-nc-magenta mt-1" data-testid="text-ripperdoc-owner">OWNER: {data.ownerName ?? "UNCLAIMED"}</p>
          {data.purpose && <p className="font-mono text-xs text-muted-foreground mt-1" data-testid="text-ripperdoc-purpose">{data.purpose}</p>}
        </div>
        {canManage && (
          <Link href={`/clinics/${data.id}`}>
            <Button className="rounded-none bg-nc-magenta text-background font-display shrink-0" data-testid="button-manage-ripperdoc">
              <Settings className="w-4 h-4 mr-2" /> MANAGE
            </Button>
          </Link>
        )}
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
