import { useState } from "react";
import { Link, useParams } from "wouter";
import { useListLore } from "@workspace/api-client-react";
import type { LoreEntrySummaryCategory } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { BookOpen, Lock, ArrowLeft } from "lucide-react";
import { districtLabel, subDistrictLabel } from "@/lib/districts";

type LoreSort = "recent" | "alpha";

const SECTION_META: Record<string, { label: string; text: string; desc: string }> = {
  location: { label: "LOCATIONS", text: "text-nc-green", desc: "Bars, clinics, landmarks and hangouts across the city." },
  faction: { label: "FACTIONS", text: "text-nc-yellow", desc: "Organizations and groups vying for influence." },
  gang: { label: "GANGS", text: "text-destructive", desc: "The street crews that hold Night City's turf." },
  corporation: { label: "CORPS", text: "text-nc-cyan", desc: "The megacorps that really run everything." },
  misc: { label: "MISC", text: "text-muted-foreground", desc: "Everything else worth knowing." },
};

const CATEGORY_BADGE: Record<string, string> = {
  corporation: "border-nc-cyan text-nc-cyan",
  gang: "border-destructive text-destructive",
  faction: "border-nc-yellow text-nc-yellow",
  location: "border-nc-green text-nc-green",
  misc: "border-muted-foreground text-muted-foreground",
};

export default function DirectoryLoreSection() {
  const { category } = useParams<{ category: string }>();
  const meta = SECTION_META[category];
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<LoreSort>("recent");

  const { data, isLoading } = useListLore({
    category: category as LoreEntrySummaryCategory,
    ...(q.trim() ? { q: q.trim() } : {}),
    sort,
  });

  if (!meta) {
    return (
      <div className="max-w-7xl mx-auto py-20 text-center">
        <h1 className="font-display text-2xl">UNKNOWN SECTION</h1>
        <Link href="/directory/lore" className="font-mono text-nc-cyan text-sm underline">Back to lore</Link>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto space-y-6 pb-12">
      <div>
        <Link href="/directory/lore" className="font-mono text-xs text-muted-foreground hover:text-nc-cyan flex items-center gap-1" data-testid="link-lore-back">
          <ArrowLeft className="w-3 h-3" /> LORE DIRECTORY
        </Link>
        <h1 className={`text-4xl font-display mt-2 flex items-center gap-3 ${meta.text}`} data-testid="text-lore-section-title">
          <BookOpen className="w-8 h-8" /> {meta.label}
        </h1>
        <p className="font-mono text-muted-foreground mt-2">{meta.desc}</p>
      </div>

      <div className="flex flex-col md:flex-row md:items-center gap-3 md:justify-end">
        <Select value={sort} onValueChange={(v) => setSort(v as LoreSort)}>
          <SelectTrigger className="rounded-none font-mono text-xs md:w-48" data-testid="select-lore-sort">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="recent">Recently Updated</SelectItem>
            <SelectItem value="alpha">Alphabetical</SelectItem>
          </SelectContent>
        </Select>
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search this section..."
          className="rounded-none font-mono md:max-w-xs"
          data-testid="input-lore-search"
        />
      </div>

      {isLoading ? (
        <div className="text-nc-cyan font-display animate-pulse">SCANNING ARCHIVES...</div>
      ) : !data?.length ? (
        <div className="py-20 text-center border border-dashed border-border bg-card/30">
          <BookOpen className="w-12 h-12 text-muted-foreground mx-auto mb-4 opacity-50" />
          <h3 className="font-display text-xl">NO LORE ON RECORD</h3>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4">
          {data.map((e) => (
            <Link key={e.id} href={`/directory/lore/${e.id}`}>
              <Card className="rounded-none border-border bg-card/50 hover:border-nc-cyan transition-all cursor-pointer h-full flex flex-col" data-testid={`card-lore-${e.id}`}>
                <CardHeader>
                  <div className="flex items-center justify-between gap-2">
                    <Badge variant="outline" className={`rounded-none uppercase ${CATEGORY_BADGE[e.category]}`}>{e.category}</Badge>
                    {e.hasFixerContent && (
                      <Badge variant="outline" className="rounded-none border-nc-yellow text-nc-yellow text-[10px]" data-testid={`badge-lore-fixer-${e.id}`}>
                        <Lock className="w-3 h-3 mr-1" /> FIXER
                      </Badge>
                    )}
                  </div>
                  {e.imageUrl && (
                    <div className="mt-2 -mx-6 border-y border-border/50 bg-background/40">
                      <img
                        src={e.imageUrl}
                        alt={e.name}
                        className="w-full h-32 object-contain"
                        loading="lazy"
                        data-testid={`img-lore-${e.id}`}
                      />
                    </div>
                  )}
                  <CardTitle className="font-display text-xl mt-2">{e.name}</CardTitle>
                  {e.responsibleFixer && (
                    <CardDescription className="font-mono text-xs text-nc-cyan" data-testid={`text-lore-lead-${e.id}`}>
                      STORY LEAD: {e.responsibleFixer}
                    </CardDescription>
                  )}
                  {e.district && (
                    <CardDescription className="font-mono text-xs text-nc-green" data-testid={`text-lore-district-${e.id}`}>
                      DISTRICT: {districtLabel(e.district)}{e.subDistrict ? ` · ${subDistrictLabel(e.subDistrict)}` : ""}
                    </CardDescription>
                  )}
                </CardHeader>
                <CardContent className="mt-auto">
                  <p className="text-xs font-mono text-muted-foreground line-clamp-3">{e.summary ?? "No summary."}</p>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
