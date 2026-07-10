import { useParams, Link } from "wouter";
import { useGetNcpdRecord, getGetNcpdRecordQueryKey } from "@workspace/api-client-react";
import { useEffectiveMe } from "@/contexts/ViewAsContext";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import NcpdRecordPanel from "@/components/NcpdRecordPanel";
import { Shield, ArrowLeft } from "lucide-react";

// Per-character NCPD record page, reached from the NCPD hub (warrant board,
// reports feed, or lookup). Same clearance gate as the hub.
export default function NcpdCharacterRecord() {
  const { id } = useParams();
  const charId = Number(id);
  const me = useEffectiveMe();
  const canAccess = !!(me.data?.isNcpd || me.data?.isFixer || me.data?.isAdmin);
  const { data: record } = useGetNcpdRecord(charId, {
    query: { enabled: canAccess && Number.isFinite(charId), queryKey: getGetNcpdRecordQueryKey(charId) },
  });

  if (me.isLoading) {
    return <div className="text-nc-cyan font-display animate-pulse py-12 text-center">VERIFYING CLEARANCE...</div>;
  }
  if (!canAccess) {
    return (
      <div className="max-w-7xl mx-auto py-12 text-center space-y-2">
        <Shield className="w-10 h-10 mx-auto text-destructive" />
        <p className="font-display tracking-widest text-destructive">ACCESS DENIED</p>
        <p className="font-mono text-sm text-muted-foreground">NCPD clearance required.</p>
      </div>
    );
  }

  const c = record?.character;
  return (
    <div className="max-w-7xl mx-auto space-y-6 pb-12">
      <Link href="/ncpd" className="inline-flex items-center gap-2 font-mono text-sm text-muted-foreground hover:text-nc-cyan" data-testid="link-ncpd-back">
        <ArrowLeft className="w-4 h-4" /> NCPD DATABASE
      </Link>
      {c && (
        <div className="flex items-center gap-4">
          <Avatar className="w-16 h-16 rounded-none border border-border">
            <AvatarImage src={c.portraitUrl ?? undefined} alt={c.name} className="object-cover" />
            <AvatarFallback className="rounded-none font-display">{c.name.slice(0, 2).toUpperCase()}</AvatarFallback>
          </Avatar>
          <div>
            <h1 className="text-3xl font-display text-foreground flex items-center gap-3" data-testid="text-ncpd-record-name">
              {c.name}
              {c.archived && (
                <Badge variant="outline" className="rounded-none uppercase font-display text-[10px] text-muted-foreground">
                  Archived
                </Badge>
              )}
            </h1>
            <p className="font-mono text-xs text-muted-foreground">
              {c.kind.toUpperCase()}
              {c.archetype ? ` · ${c.archetype}` : ""}
              {c.lifeStatus && c.lifeStatus !== "alive" ? ` · ${c.lifeStatus.toUpperCase()}` : ""}
              {" · "}
              <Link href={`/characters/${c.id}`} className="text-nc-cyan hover:underline">
                full dossier
              </Link>
            </p>
          </div>
        </div>
      )}
      {Number.isFinite(charId) && <NcpdRecordPanel characterId={charId} />}
    </div>
  );
}
