import { Link } from "wouter";
import { useListLore } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { BookOpen, Plus, Download, Building2, Users, Skull, MapPin, Boxes, Map as MapIcon } from "lucide-react";
import { useEffectiveMe } from "@/contexts/ViewAsContext";
import mapImage from "@assets/gk5g5y2f1ln81_1784064405878.jpg";

const SECTIONS = [
  { category: "location", label: "LOCATIONS", icon: MapPin, text: "text-nc-green", hover: "hover:border-nc-green", desc: "Bars, clinics, landmarks and hangouts across the city." },
  { category: "faction", label: "FACTIONS", icon: Users, text: "text-nc-yellow", hover: "hover:border-nc-yellow", desc: "Organizations and groups vying for influence." },
  { category: "gang", label: "GANGS", icon: Skull, text: "text-destructive", hover: "hover:border-destructive", desc: "The street crews that hold Night City's turf." },
  { category: "corporation", label: "CORPS", icon: Building2, text: "text-nc-cyan", hover: "hover:border-nc-cyan", desc: "The megacorps that really run everything." },
  { category: "misc", label: "MISC", icon: Boxes, text: "text-muted-foreground", hover: "hover:border-muted-foreground", desc: "Everything else worth knowing." },
] as const;

export default function DirectoryLore() {
  const { data: me } = useEffectiveMe();
  const isStaff = !!me && (me.isAdmin || me.isFixer);
  const isAdmin = !!me?.isAdmin;
  const { data: entries } = useListLore({});

  const counts: Record<string, number> = {};
  for (const e of entries ?? []) counts[e.category] = (counts[e.category] ?? 0) + 1;

  return (
    <div className="max-w-7xl mx-auto space-y-6 pb-12">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-4xl font-display text-foreground flex items-center gap-3" data-testid="text-lore-title">
            <BookOpen className="w-8 h-8 text-nc-cyan" /> LORE DIRECTORY
          </h1>
          <p className="font-mono text-muted-foreground mt-2">
            The places, corporations, gangs and factions that run Night City.
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

      <Link href="/directory/map">
        <Card className="rounded-none border-border bg-card/50 hover:border-nc-green transition-all cursor-pointer overflow-hidden group" data-testid="card-lore-map">
          <div className="relative h-64 md:h-80 overflow-hidden">
            <img
              src={mapImage}
              alt="Night City map"
              className="w-full h-full object-cover object-center opacity-70 group-hover:opacity-90 group-hover:scale-105 transition-all duration-500"
            />
            <div className="absolute inset-0 bg-gradient-to-t from-background via-background/40 to-transparent" />
            <div className="absolute bottom-4 left-6 right-6 flex items-end justify-between gap-4">
              <div>
                <h2 className="font-display text-3xl text-nc-green flex items-center gap-3">
                  <MapIcon className="w-7 h-7" /> CITY MAP
                </h2>
                <p className="font-mono text-xs text-muted-foreground mt-1">
                  Explore Night City district by district. Click a district to open its lore.
                </p>
              </div>
              <span className="font-display text-xs tracking-widest text-nc-green border border-nc-green px-3 py-2 whitespace-nowrap">
                OPEN MAP →
              </span>
            </div>
          </div>
        </Card>
      </Link>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {SECTIONS.map((s) => {
          const Icon = s.icon;
          const n = counts[s.category] ?? 0;
          return (
            <Link key={s.category} href={`/directory/lore/section/${s.category}`}>
              <Card
                className={`rounded-none border-border bg-card/50 ${s.hover} transition-all cursor-pointer h-full`}
                data-testid={`card-lore-section-${s.category}`}
              >
                <CardContent className="p-6 flex flex-col gap-3 h-full">
                  <div className="flex items-center justify-between">
                    <Icon className={`w-8 h-8 ${s.text}`} />
                    <span className="font-mono text-xs text-muted-foreground" data-testid={`text-lore-count-${s.category}`}>
                      {n} {n === 1 ? "ENTRY" : "ENTRIES"}
                    </span>
                  </div>
                  <h3 className={`font-display text-2xl tracking-widest ${s.text}`}>{s.label}</h3>
                  <p className="font-mono text-xs text-muted-foreground">{s.desc}</p>
                </CardContent>
              </Card>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
