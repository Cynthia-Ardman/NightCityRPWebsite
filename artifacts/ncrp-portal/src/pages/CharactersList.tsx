import { Link } from "wouter";
import { useState } from "react";
import { useListMyCharacters, useListMySheets, type Character } from "@workspace/api-client-react";
import { Users, Plus, Shield, ShieldAlert, FileText, Clock, AlertCircle, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import EditCharacterDialog from "@/components/EditCharacterDialog";

export default function CharactersList() {
  const { data: characters, isLoading: charsLoading } = useListMyCharacters();
  const { data: sheets, isLoading: sheetsLoading } = useListMySheets();
  const [editing, setEditing] = useState<Character | null>(null);

  const drafts = (sheets ?? []).filter((s) => s.status === "draft" || s.status === "changes_requested");
  const pendingSheets = (sheets ?? []).filter((s) => s.status === "pending");
  const isLoading = charsLoading || sheetsLoading;

  return (
    <div className="space-y-8 max-w-6xl mx-auto pb-12">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-4xl font-display font-bold text-foreground" data-testid="text-characters-title">CHARACTERS</h1>
          <p className="text-muted-foreground font-mono mt-2">Your PCs, NPCs, drafts, and pending submissions.</p>
        </div>
        <Button asChild className="rounded-none bg-nc-cyan text-background hover:bg-nc-cyan/80 font-display font-bold tracking-widest" data-testid="button-new-character">
          <Link href="/sheets/new"><Plus className="w-4 h-4 mr-2" /> NEW_CHARACTER</Link>
        </Button>
      </div>

      {drafts.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-lg font-display tracking-widest text-nc-yellow flex items-center gap-2">
            <FileText className="w-4 h-4" /> DRAFTS &amp; CHANGES REQUESTED
            <span className="text-xs font-mono text-muted-foreground">({drafts.length})</span>
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {drafts.map((s) => (
              <Link key={s.id} href={`/sheets/${s.id}/edit`}>
                <Card className="rounded-none border-nc-yellow/60 bg-card/40 hover:border-nc-yellow hover:bg-card transition-all cursor-pointer h-full" data-testid={`card-draft-${s.id}`}>
                  <CardHeader>
                    <CardTitle className="text-lg font-display truncate">{s.name || "(untitled draft)"}</CardTitle>
                    <CardDescription className="font-mono text-xs">
                      {s.data?.sheetType ?? "PC"} {s.data?.archetype ? `// ${s.data.archetype}` : ""}
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="flex justify-between items-center border-t border-border/50 pt-3 text-xs font-mono">
                    <span className="text-muted-foreground">Updated {new Date(s.createdAt).toLocaleDateString()}</span>
                    {s.status === "draft" ? (
                      <Badge variant="outline" className="rounded-none border-nc-yellow text-nc-yellow">
                        <FileText className="w-3 h-3 mr-1" /> DRAFT
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="rounded-none border-destructive text-destructive">
                        <AlertCircle className="w-3 h-3 mr-1" /> CHANGES REQ
                      </Badge>
                    )}
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
        </section>
      )}

      {pendingSheets.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-lg font-display tracking-widest text-nc-cyan flex items-center gap-2">
            <Clock className="w-4 h-4" /> AWAITING APPROVAL
            <span className="text-xs font-mono text-muted-foreground">({pendingSheets.length})</span>
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {pendingSheets.map((s) => (
              <Link key={s.id} href={`/sheets/${s.id}`}>
                <Card className="rounded-none border-border bg-card/50 hover:border-nc-cyan transition-all cursor-pointer h-full" data-testid={`card-pending-${s.id}`}>
                  <CardHeader>
                    <CardTitle className="text-lg font-display truncate">{s.name}</CardTitle>
                    <CardDescription className="font-mono text-xs">
                      {s.data?.sheetType ?? "PC"} {s.data?.archetype ? `// ${s.data.archetype}` : ""}
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="flex justify-between items-center border-t border-border/50 pt-3 text-xs font-mono">
                    <span className="text-muted-foreground">Submitted {new Date(s.createdAt).toLocaleDateString()}</span>
                    <Badge variant="outline" className="rounded-none border-nc-yellow text-nc-yellow">
                      <Clock className="w-3 h-3 mr-1" /> PENDING
                    </Badge>
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
        </section>
      )}

      <section className="space-y-3">
        <h2 className="text-lg font-display tracking-widest text-foreground flex items-center gap-2">
          <Users className="w-4 h-4" /> APPROVED IDENTITIES
          {characters && <span className="text-xs font-mono text-muted-foreground">({characters.length})</span>}
        </h2>
        {isLoading ? (
          <div className="py-20 text-center text-nc-cyan animate-pulse font-display text-xl">SCANNING_DATABASE...</div>
        ) : (characters?.length ?? 0) === 0 ? (
          <div className="py-12 text-center border border-dashed border-border bg-card/30">
            <Users className="w-12 h-12 text-muted-foreground mx-auto mb-4 opacity-50" />
            <h3 className="text-xl font-display text-foreground mb-2">NO APPROVED IDENTITIES</h3>
            <p className="text-muted-foreground font-mono text-sm">
              {drafts.length > 0 || pendingSheets.length > 0
                ? "Finish a draft or wait for approval to see characters here."
                : "Create your first character to get started."}
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {characters?.map(char => (
              <div key={char.id} className="relative">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="absolute top-2 right-2 z-10 rounded-none border-nc-cyan/40 text-nc-cyan hover:bg-nc-cyan hover:text-background h-7 px-2 font-display tracking-widest text-xs"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setEditing(char);
                  }}
                  data-testid={`button-edit-character-${char.id}`}
                >
                  <Pencil className="w-3 h-3 mr-1" /> EDIT
                </Button>
                <Link href={`/characters/${char.id}`}>
                <Card className="rounded-none border-border bg-card/50 hover:border-nc-cyan hover:shadow-[0_0_15px_rgba(0,255,255,0.1)] transition-all cursor-pointer group h-full flex flex-col" data-testid={`card-character-${char.id}`}>
                  <CardHeader className="flex flex-row items-start gap-4 space-y-0 pb-2">
                    <Avatar className="h-16 w-16 border border-border rounded-none group-hover:border-nc-cyan transition-colors shadow-sm">
                      <AvatarImage src={char.portraitUrl || char.portraitUrls?.[0] || ''} className="object-cover" />
                      <AvatarFallback className="bg-background text-nc-cyan rounded-none font-display text-2xl">
                        {char.name.substring(0, 2).toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                    <div className="flex-1 min-w-0">
                      <CardTitle className="text-xl font-display group-hover:text-nc-cyan transition-colors truncate" title={char.name}>{char.name}</CardTitle>
                      <CardDescription className="font-mono text-xs uppercase mt-1">
                        <span className={char.kind === 'pc' ? 'text-nc-magenta' : 'text-nc-yellow'}>{char.kind}</span>
                        {char.archetype && ` // ${char.archetype}`}
                      </CardDescription>
                    </div>
                  </CardHeader>
                  <CardContent className="mt-auto pt-4 border-t border-border/50">
                    <div className="flex items-center justify-between text-xs font-mono">
                      <div className="flex items-center gap-2">
                        <span className={`w-2 h-2 rounded-full ${char.isActive ? 'bg-nc-cyan animate-pulse shadow-[0_0_5px_currentColor]' : 'bg-muted'}`} />
                        <span className={char.isActive ? 'text-foreground' : 'text-muted-foreground'}>
                          {char.isActive ? 'ACTIVE' : 'STANDBY'}
                        </span>
                      </div>
                      {char.approved ? (
                        <span className="flex items-center gap-1 text-nc-cyan">
                          <Shield className="w-3 h-3" /> APPROVED
                        </span>
                      ) : (
                        <span className="flex items-center gap-1 text-nc-yellow">
                          <ShieldAlert className="w-3 h-3" /> PENDING
                        </span>
                      )}
                    </div>
                  </CardContent>
                </Card>
                </Link>
              </div>
            ))}
          </div>
        )}
      </section>

      {editing && (
        <EditCharacterDialog
          character={editing}
          open={!!editing}
          onOpenChange={(o) => { if (!o) setEditing(null); }}
        />
      )}
    </div>
  );
}
