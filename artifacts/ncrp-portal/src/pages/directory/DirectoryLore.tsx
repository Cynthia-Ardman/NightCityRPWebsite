import { useState } from "react";
import { Link } from "wouter";
import { useListLore } from "@workspace/api-client-react";
import type { LoreEntrySummaryCategory } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { BookOpen, Plus, Lock, Download } from "lucide-react";
import { useAuthMe } from "@/hooks/useAuthMe";

type LoreSort = "recent" | "alpha";

const CATEGORY_LABEL: Record<string, string> = {
  corporation: "CORPORATIONS",
  gang: "GANGS",
  faction: "FACTIONS",
  misc: "MISC",
};
const CATEGORY_BADGE: Record<string, string> = {
  corporation: "border-nc-cyan text-nc-cyan",
  gang: "border-destructive text-destructive",
  faction: "border-nc-yellow text-nc-yellow",
  misc: "border-muted-foreground text-muted-foreground",
};

export default function DirectoryLore() {
  const { data: me } = useAuthMe();
  const isStaff = !!me && (me.isAdmin || me.isFixer);
  const isAdmin = !!me?.isAdmin;
  const [tab, setTab] = useState<"all" | LoreEntrySummaryCategory>("all");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<LoreSort>("recent");

  const { data, isLoading } = useListLore({
    ...(tab === "all" ? {} : { category: tab }),
    ...(q.trim() ? { q: q.trim() } : {}),
    sort,
  });

  return (
    <div className="max-w-6xl mx-auto space-y-6 pb-12">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-4xl font-display text-foreground flex items-center gap-3" data-testid="text-lore-title">
            <BookOpen className="w-8 h-8 text-nc-cyan" /> LORE DIRECTORY
          </h1>
          <p className="font-mono text-muted-foreground mt-2">
            The corporations, gangs and factions that run Night City.
          </p>
        </div>
        {isStaff && (
          <div className="flex gap-2">
            <Link href="/directory/lore/mine">
              <Button variant="outline" className="rounded-none border-nc-cyan text-nc-cyan font-display" data-testid="button-lore-mine">
                <BookOpen className="w-4 h-4 mr-2" /> MY SUBMISSIONS
              </Button>
            </Link>
            {isAdmin && (
              <Link href="/directory/lore/import">
                <Button variant="outline" className="rounded-none border-nc-yellow text-nc-yellow font-display" data-testid="button-lore-import">
                  <Download className="w-4 h-4 mr-2" /> IMPORT
                </Button>
              </Link>
            )}
            <Link href="/directory/lore/new">
              <Button className="rounded-none bg-nc-cyan text-background font-display" data-testid="button-lore-new">
                <Plus className="w-4 h-4 mr-2" /> {isAdmin ? "NEW ENTRY" : "PROPOSE ENTRY"}
              </Button>
            </Link>
          </div>
        )}
      </div>

      <div className="flex flex-col md:flex-row md:items-center gap-3 justify-between">
        <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
          <TabsList className="rounded-none bg-card/60 border border-border p-1 flex flex-wrap h-auto justify-start gap-1">
            <TabsTrigger value="all" className="rounded-none font-display tracking-widest" data-testid="tab-lore-all">ALL</TabsTrigger>
            {Object.entries(CATEGORY_LABEL).map(([value, label]) => (
              <TabsTrigger key={value} value={value} className="rounded-none font-display tracking-widest" data-testid={`tab-lore-${value}`}>
                {label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <div className="flex items-center gap-3">
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
            placeholder="Search lore..."
            className="rounded-none font-mono md:max-w-xs"
            data-testid="input-lore-search"
          />
        </div>
      </div>

      {isLoading ? (
        <div className="text-nc-cyan font-display animate-pulse">SCANNING ARCHIVES...</div>
      ) : !data?.length ? (
        <Empty />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
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
                        className="w-full h-32 object-cover"
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

function Empty() {
  return (
    <div className="py-20 text-center border border-dashed border-border bg-card/30">
      <BookOpen className="w-12 h-12 text-muted-foreground mx-auto mb-4 opacity-50" />
      <h3 className="font-display text-xl">NO LORE ON RECORD</h3>
    </div>
  );
}
