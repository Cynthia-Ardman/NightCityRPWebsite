import { Link } from "wouter";
import { useListMyFixerNpcs, useListAllFixerNpcs } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import ErrorBoundary from "@/components/ErrorBoundary";
import { Plus, Users, FileText, Search, Briefcase, BarChart3, Coins, UserSearch, ArrowRight, PartyPopper, UserPlus, ShieldAlert, Building2, Activity, Tag as TagIcon, type LucideIcon } from "lucide-react";

type FixerTool = {
  href: string;
  testId: string;
  icon: LucideIcon;
  title: string;
  description: string;
  cta: string;
  accent: "cyan" | "magenta" | "yellow";
};

const FIXER_TOOLS: FixerTool[] = [
  {
    href: "/fixer/characters/new",
    testId: "link-fixer-create-character",
    icon: UserPlus,
    title: "Create Character",
    description: "Hand-create a PC or NPC. Skips the sheet review queue and lands approved & active.",
    cta: "Create a character",
    accent: "magenta",
  },
  {
    href: "/directory/characters",
    testId: "link-fixer-archive",
    icon: FileText,
    title: "Character Archive",
    description: "Browse the full roster of every character sheet on the server, including backgrounds and history.",
    cta: "Open archive",
    accent: "cyan",
  },
  {
    href: "/fixer/missions",
    testId: "link-fixer-missions",
    icon: Briefcase,
    title: "Mission Log",
    description: "Create, track, and resolve missions — assign players, set rewards, and mark completion.",
    cta: "Open mission log",
    accent: "magenta",
  },
  {
    href: "/fixer/events",
    testId: "link-fixer-events",
    icon: PartyPopper,
    title: "Events",
    description: "Schedule sessions, socials, and other non-mission events — they sync to Discord and show on the calendar.",
    cta: "Manage events",
    accent: "cyan",
  },
  {
    href: "/fixer/analytics",
    testId: "link-fixer-analytics",
    icon: Activity,
    title: "Server Analytics",
    description: "Server health at a glance — economy flow, mission throughput, review-queue aging, and player activity.",
    cta: "View analytics",
    accent: "yellow",
  },
  {
    href: "/fixer/reports",
    testId: "link-fixer-reports",
    icon: BarChart3,
    title: "Mission Reports",
    description: "Review payout summaries and activity across completed missions.",
    cta: "View reports",
    accent: "cyan",
  },
  {
    href: "/fixer/pay-actors",
    testId: "link-fixer-pay-actors",
    icon: Coins,
    title: "Pay Actors",
    description: "Issue payouts to the actors who ran a scene, tracking who has been paid.",
    cta: "Pay actors",
    accent: "magenta",
  },
  {
    href: "/fixer/items",
    testId: "link-fixer-items",
    icon: Search,
    title: "Item Trace",
    description: "Search every character's inventory to trace who owns a given item, gear, or piece of cyberware.",
    cta: "Trace an item",
    accent: "yellow",
  },
  {
    href: "/fixer/players",
    testId: "link-fixer-players",
    icon: UserSearch,
    title: "Player Lookup",
    description: "Find a player and see the characters, wallets, and accounts tied to them.",
    cta: "Look up a player",
    accent: "cyan",
  },
  {
    href: "/fixer/off-map-properties",
    testId: "link-fixer-off-map-properties",
    icon: Building2,
    title: "Off-Map Properties",
    description: "Every off-map lease — residential homes and business spaces not tied to a catalog building, with the venue each business backs.",
    cta: "Browse off-map",
    accent: "yellow",
  },
  {
    href: "/fixer/tag-roles",
    testId: "link-fixer-tag-roles",
    icon: TagIcon,
    title: "Tag Roles",
    description: "Link character tags to Discord roles and choose which tags need fixer approval before players can wear them.",
    cta: "Manage tag roles",
    accent: "cyan",
  },
  {
    href: "/fixer/cyberware-violations",
    testId: "link-fixer-cyberware-violations",
    icon: ShieldAlert,
    title: "Slot Violations",
    description: "Players holding more than one cyberware item in a single capped body slot. Misc and Custom chrome are unlimited.",
    cta: "View violations",
    accent: "magenta",
  },
];

const ACCENT: Record<FixerTool["accent"], { border: string; text: string }> = {
  cyan: { border: "hover:border-nc-cyan", text: "text-nc-cyan" },
  magenta: { border: "hover:border-nc-magenta", text: "text-nc-magenta" },
  yellow: { border: "hover:border-nc-yellow", text: "text-nc-yellow" },
};

function ToolCard({ tool }: { tool: FixerTool }) {
  const Icon = tool.icon;
  const accent = ACCENT[tool.accent];
  return (
    <Link href={tool.href} data-testid={tool.testId}>
      <Card className={`rounded-none border-border bg-card/50 cursor-pointer h-full flex flex-col transition-colors ${accent.border}`}>
        <CardHeader>
          <CardTitle className={`font-display tracking-widest flex items-center gap-2 ${accent.text}`}>
            <Icon className="w-4 h-4" /> {tool.title.toUpperCase()}
          </CardTitle>
          <CardDescription className="font-mono text-xs leading-relaxed">{tool.description}</CardDescription>
        </CardHeader>
        <CardContent className="mt-auto">
          <span className={`font-display text-xs tracking-widest inline-flex items-center gap-1 ${accent.text}`}>
            {tool.cta.toUpperCase()} <ArrowRight className="w-3 h-3" />
          </span>
        </CardContent>
      </Card>
    </Link>
  );
}

export default function FixerHub() {
  const { data: mine } = useListMyFixerNpcs();
  const { data: all } = useListAllFixerNpcs();

  return (
    <div className="max-w-7xl mx-auto space-y-6 pb-12">
      <h1 className="text-4xl font-display" data-testid="text-fixer-title">FIXER HUB</h1>

      <ErrorBoundary>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {FIXER_TOOLS.map((tool) => (
            <ToolCard key={tool.href} tool={tool} />
          ))}
        </div>
      </ErrorBoundary>

      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-xl font-display text-muted-foreground tracking-widest">FIXER NPCS</h2>
          <p className="font-mono text-xs text-muted-foreground/70">
            New NPCs use the full character sheet and go through staff review. Existing roster shown below.
          </p>
        </div>
        <Link
          href="/sheets/new?type=NPC"
          className="rounded-none bg-nc-cyan text-background hover:bg-nc-cyan/80 font-display inline-flex items-center px-4 py-2 text-sm"
          data-testid="button-new-npc"
        >
          <Plus className="w-4 h-4 mr-2" /> NEW NPC
        </Link>
      </div>

      <Tabs defaultValue="mine">
        <TabsList className="rounded-none border border-border bg-transparent">
          <TabsTrigger value="mine" className="rounded-none font-display" data-testid="tab-mine">MY NPCS</TabsTrigger>
          <TabsTrigger value="all" className="rounded-none font-display" data-testid="tab-all">ALL NPCS</TabsTrigger>
        </TabsList>
        <TabsContent value="mine"><ErrorBoundary><NpcGrid items={mine ?? []} kind="mine" /></ErrorBoundary></TabsContent>
        <TabsContent value="all"><ErrorBoundary><NpcGrid items={all ?? []} kind="all" /></ErrorBoundary></TabsContent>
      </Tabs>
    </div>
  );
}

function NpcGrid({ items, kind }: { items: Array<{ id: number; name: string; archetype?: string | null; district?: string | null; fixerName?: string | null }>; kind: string }) {
  if (!items.length) return (
    <div className="py-20 text-center border border-dashed border-border bg-card/30 mt-4">
      <Users className="w-12 h-12 text-muted-foreground mx-auto mb-4 opacity-50" />
      <h3 className="font-display text-xl">NO NPCS</h3>
    </div>
  );
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mt-4">
      {items.map((n) => (
        <Link key={n.id} href={`/characters/${n.id}`}>
          <Card className="rounded-none border-border bg-card/50 hover:border-nc-cyan cursor-pointer h-full" data-testid={`card-npc-${kind}-${n.id}`}>
            <CardHeader>
              <CardTitle className="font-display">{n.name}</CardTitle>
              <CardDescription className="font-mono text-xs">{n.archetype ?? "—"} · {n.district ?? "—"}</CardDescription>
            </CardHeader>
            {n.fixerName && <CardContent className="text-xs font-mono text-muted-foreground">handler: {n.fixerName}</CardContent>}
          </Card>
        </Link>
      ))}
    </div>
  );
}
