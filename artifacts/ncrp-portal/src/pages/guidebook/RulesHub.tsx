import { useMemo } from "react";
import { Link } from "wouter";
import { useListGuidebook, type GuidebookPage } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ArrowLeft, ArrowRight, Scale, Drama, UserRound, ShieldAlert } from "lucide-react";

// Code-defined "Rules at a Glance" hub (a static route BEFORE /guidebook/:id,
// like /guidebook/weapons). Summarizes each rule area with jump links into the
// full pages — the summaries are navigation aids; the linked pages remain the
// only authoritative text. Rules pages are flagged publicRead, so this hub also
// works for logged-out visitors arriving from the Start Here page or Discord.

type RuleArea = {
  key: string;
  title: string;
  icon: typeof Scale;
  summary: string[];
  // Slug of the full guidebook page + optional heading anchor within it.
  pageSlug: string;
  anchor?: string;
  linkLabel: string;
};

const RULE_AREAS: RuleArea[] = [
  {
    key: "server",
    title: "Server Rules",
    icon: Scale,
    summary: [
      "You must be 18+ and verified on VRChat, in the VRChat group, with VRChat and Discord linked.",
      "Consent is mandatory for all RP and interactions; bigotry and discrimination are not tolerated.",
      "Adult themes exist in roleplay — joining means acknowledging that. No IRL money for IC money.",
    ],
    pageSlug: "rp-rules",
    anchor: "server-rules",
    linkLabel: "Read the full server rules",
  },
  {
    key: "safety",
    title: "Platform & Content Safety",
    icon: ShieldAlert,
    summary: [
      "No sexual-violence content may be posted, shared, recorded or referenced anywhere in NCRP — even with OOC consent.",
      "Content banned by Discord's ToS or VRChat's Community Guidelines is strictly prohibited, regardless of context.",
      "Violations can mean immediate removal and disciplinary action.",
    ],
    pageSlug: "rp-rules",
    anchor: "platform-content-safety-rules",
    linkLabel: "Read the content safety rules",
  },
  {
    key: "rp",
    title: "RP Rules",
    icon: Drama,
    summary: [
      "Maintain immersion: nameplates off, status set to your character's name, no breaking character mid-event.",
      "No powergaming — your character is mortal. Killing players is allowed but carries heavy consequences.",
      "Events are recorded; do not stream them. Sexual contact requires explicit OOC consent from everyone involved.",
    ],
    pageSlug: "rp-rules",
    anchor: "rp-rules",
    linkLabel: "Read the full RP rules",
  },
  {
    key: "avatar",
    title: "Avatar Rules",
    icon: UserRound,
    summary: [
      "Hard stat caps: 70mb file size, 450k polygons, 125mb texture memory, capped materials and particles.",
      "No cloth physics, realtime lights with shadows, mesh particles or prohibited shaders; audio sources off by default.",
      "Can't update your avatar? Contact staff — they'll figure something out.",
    ],
    pageSlug: "avatar-restrictions",
    linkLabel: "Read the avatar restrictions",
  },
];

export default function RulesHub() {
  const { data, isLoading } = useListGuidebook();
  const pagesBySlug = useMemo(() => {
    const map = new Map<string, GuidebookPage>();
    for (const s of data?.sections ?? []) for (const p of s.pages) map.set(p.slug, p);
    return map;
  }, [data]);

  return (
    <div className="max-w-7xl mx-auto space-y-6 pb-12">
      <Link href="/guidebook">
        <Button variant="ghost" className="rounded-none font-mono text-xs text-muted-foreground -ml-2" data-testid="link-rules-hub-back">
          <ArrowLeft className="w-4 h-4 mr-1" /> GUIDEBOOK
        </Button>
      </Link>

      <div>
        <h1 className="text-4xl font-display text-foreground flex items-center gap-3" data-testid="text-rules-hub-title">
          <Scale className="w-8 h-8 text-nc-magenta" /> RULES AT A GLANCE
        </h1>
        <p className="font-mono text-muted-foreground mt-2 max-w-3xl">
          The short version of every rule area. These summaries are a map, not the law — the
          linked pages are the authoritative rules and the ones you accept when you join.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {RULE_AREAS.map((area) => {
          const page = pagesBySlug.get(area.pageSlug);
          const href = page ? `/guidebook/${page.id}${area.anchor ? `#${area.anchor}` : ""}` : null;
          const Icon = area.icon;
          return (
            <Card key={area.key} className="rounded-none border-border bg-card/50 flex flex-col" data-testid={`card-rules-area-${area.key}`}>
              <CardHeader>
                <CardTitle className="font-display text-lg flex items-center gap-2">
                  <Icon className="w-5 h-5 text-nc-magenta" /> {area.title}
                </CardTitle>
                <CardDescription className="font-mono text-xs">Summary — see the full page for the complete rules.</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col flex-1 gap-4">
                <ul className="space-y-2 flex-1">
                  {area.summary.map((line, i) => (
                    <li key={i} className="font-mono text-xs text-foreground/85 flex gap-2">
                      <span className="text-nc-magenta shrink-0">▸</span> {line}
                    </li>
                  ))}
                </ul>
                {href ? (
                  <Link href={href}>
                    <Button
                      variant="outline"
                      className="rounded-none border-nc-cyan text-nc-cyan font-display w-full"
                      data-testid={`link-rules-full-${area.key}`}
                    >
                      {area.linkLabel.toUpperCase()} <ArrowRight className="w-4 h-4 ml-2" />
                    </Button>
                  </Link>
                ) : (
                  <p className="font-mono text-[10px] text-muted-foreground">
                    {isLoading ? "Loading full page link..." : "Full page unavailable."}
                  </p>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      <p className="font-mono text-[10px] text-muted-foreground/60 text-center pt-4">
        Breaking the rules can cost you your spot in Night City. When in doubt, ask staff.
      </p>
    </div>
  );
}
