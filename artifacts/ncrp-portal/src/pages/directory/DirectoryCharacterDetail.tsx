import { useState } from "react";
import { useParams } from "wouter";
import { useGetArchiveCharacter } from "@workspace/api-client-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Pencil } from "lucide-react";
import Markdown from "@/components/Markdown";
import {
  KindBadge,
  LifecycleBadge,
  ClaimBadge,
  CwpBadge,
  TagPill,
  type CwpBand,
} from "@/components/directory/CharacterBadges";
import ArchiveEditDialog from "@/components/directory/ArchiveEditDialog";

export default function DirectoryCharacterDetail() {
  const { id } = useParams();
  const charId = Number(id);
  const { data: char, isLoading } = useGetArchiveCharacter(charId);
  const [editOpen, setEditOpen] = useState(false);

  if (isLoading) return <div className="p-8 text-nc-cyan font-display text-xl animate-pulse">DECRYPTING_IDENTITY...</div>;
  if (!char) return <div className="p-8 text-destructive font-display text-xl">ERROR: IDENTITY_NOT_FOUND</div>;

  const sheet = char.sheetData as { sections?: Record<string, string>; preamble?: string } | null | undefined;
  const sections = sheet?.sections;
  const rawEntries = sections ? Object.entries(sections).filter(([, v]) => v && v.trim().length > 0) : [];
  const preamble = sheet?.preamble?.trim() ?? "";
  const sectionEntries: [string, string][] =
    rawEntries.length > 0
      ? rawEntries
      : preamble.length > 0
        ? [["Backstory", preamble]]
        : char.background && char.background.trim().length > 0
          ? [["Backstory", char.background.trim()]]
          : [];

  return (
    <div className="space-y-8 max-w-6xl mx-auto pb-12">
      <div className="flex flex-col md:flex-row gap-6 items-start md:items-end border-b border-border pb-6">
        <Avatar className="h-32 w-32 border-2 border-nc-cyan rounded-none shadow-[0_0_20px_rgba(0,255,255,0.2)] bg-card p-1">
          <AvatarImage src={char.portraitUrl || char.portraitUrls?.[0] || ""} className="object-cover rounded-none" />
          <AvatarFallback className="bg-background text-nc-cyan rounded-none font-display text-4xl">
            {char.name.substring(0, 2).toUpperCase()}
          </AvatarFallback>
        </Avatar>
        <div className="flex-1 space-y-2">
          <div className="flex items-center gap-3 flex-wrap justify-between">
            <h1 className="text-4xl md:text-5xl font-display font-bold text-foreground" data-testid="text-public-char-name">
              {char.name}
            </h1>
            <Button
              onClick={() => setEditOpen(true)}
              className="rounded-none font-display tracking-widest"
              data-testid="button-open-edit"
            >
              <Pencil className="h-4 w-4 mr-1" /> Edit
            </Button>
          </div>
          <div className="flex flex-wrap gap-1">
            <KindBadge kind={char.kind} />
            <LifecycleBadge archived={char.archived} />
            <ClaimBadge claimed={char.claimed} />
            <CwpBadge band={char.cwpBand as CwpBand} />
          </div>
          {(char.tags ?? []).length > 0 && (
            <div className="flex flex-wrap gap-1">
              {(char.tags ?? []).map((t) => (
                <TagPill key={t} tag={t} />
              ))}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-4 text-sm font-mono uppercase tracking-widest text-muted-foreground">
            {char.archetype && (
              <div className="flex items-center gap-2">
                <span className="text-foreground">ARCHETYPE:</span>
                <span className="text-nc-cyan">{char.archetype}</span>
              </div>
            )}
            {char.ownerName ? (
              <div className="flex items-center gap-2">
                <span className="text-foreground">OWNER:</span>
                <span className="text-nc-cyan">@{char.ownerName}</span>
              </div>
            ) : char.legacyDiscordUsername ? (
              <div className="flex items-center gap-2">
                <span className="text-foreground">LEGACY USER:</span>
                <span className="text-muted-foreground">{char.legacyDiscordUsername}</span>
              </div>
            ) : null}
            {char.importedFromChannelName && (
              <div className="flex items-center gap-2">
                <span className="text-foreground">FROM:</span>
                <span className="text-muted-foreground">#{char.importedFromChannelName}</span>
              </div>
            )}
          </div>
        </div>
      </div>

      {sectionEntries.length === 0 ? (
        <Card className="rounded-none border-border bg-card/50">
          <CardContent className="py-6 text-muted-foreground font-mono italic">No sheet data recorded.</CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {sectionEntries.map(([heading, body]) => (
            <Card key={heading} className="rounded-none border-border bg-card/50" data-testid={`public-section-${heading}`}>
              <CardHeader>
                <CardTitle className="font-display text-nc-cyan tracking-widest text-base">{heading.toUpperCase()}</CardTitle>
              </CardHeader>
              <CardContent>
                <Markdown className="font-mono text-sm text-foreground/90 leading-relaxed">{body}</Markdown>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Gallery title="PORTRAITS" urls={char.portraitUrls ?? []} />
      <Gallery title="STATS / SHEET IMAGES" urls={char.statsImageUrls ?? []} />

      <ArchiveEditDialog character={char} open={editOpen} onOpenChange={setEditOpen} />
    </div>
  );
}

function Gallery({ title, urls }: { title: string; urls: string[] }) {
  if (!urls || urls.length === 0) return null;
  return (
    <Card className="rounded-none border-border bg-card/50" data-testid={`public-gallery-${title}`}>
      <CardHeader>
        <CardTitle className="font-display text-nc-cyan tracking-widest text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap gap-3">
          {urls.map((u, i) => (
            <a key={`${u}-${i}`} href={u} target="_blank" rel="noreferrer" className="block border border-border bg-background p-1 hover:border-nc-cyan transition">
              <img src={u} alt={`${title} ${i + 1}`} loading="lazy" className="max-h-56 object-contain" />
            </a>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
