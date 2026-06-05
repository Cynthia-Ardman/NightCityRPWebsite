import { ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { useGetMyWallet, getGetMyWalletQueryKey, useListMyOffers, getListMyOffersQueryKey, useGetReviewUnseenCounts, getGetReviewUnseenCountsQueryKey, useGetMyUnseen, getGetMyUnseenQueryKey, useListLoreEdits, getListLoreEditsQueryKey, useListGuidebookEdits, getListGuidebookEditsQueryKey, useGetMyBreachPendingCount, getGetMyBreachPendingCountQueryKey, useDismissOnboarding, getGetMeQueryKey } from "@workspace/api-client-react";
import { useEffectiveMe, useViewAs } from "@/contexts/ViewAsContext";
import { useAuthMe } from "@/hooks/useAuthMe";
import { ONBOARDING_BANNER_LINKS, guidebookSectionHref } from "@/lib/guidebookLinks";
import { LogOut, User, Users, Shield, Store, Syringe, Skull, Dice5, FileText, Menu, Briefcase, Receipt, ClipboardList, ShoppingBag, BookOpen, BookMarked, Cpu, CalendarDays, Settings, X, Stethoscope, HeartPulse, Wrench, Building2, Warehouse, Archive, Network } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { ViewAsControl, ViewAsBanner } from "@/components/layout/ViewAsControl";
import ncrpLogo from "@assets/image_1780331782394.png";

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen w-full flex flex-col md:flex-row bg-background">
      {/* Mobile Header */}
      <div className="md:hidden flex items-center justify-between p-4 border-b border-border bg-card">
        <Link href="/" className="flex items-center gap-2" data-testid="link-brand-mobile">
          <img src={ncrpLogo} alt="NCRP" className="h-12 w-12 object-contain" />
          <span className="font-display font-bold text-lg text-nc-cyan glitch-hover">NCRP_PORTAL</span>
        </Link>
        <Sheet>
          <SheetTrigger asChild>
            <Button variant="outline" size="icon" className="border-nc-cyan text-nc-cyan">
              <Menu className="h-5 w-5" />
            </Button>
          </SheetTrigger>
          <SheetContent side="left" className="w-64 bg-sidebar border-sidebar-border p-0">
            <SidebarContent />
          </SheetContent>
        </Sheet>
      </div>

      {/* Desktop Sidebar */}
      <div className="hidden md:flex flex-col w-64 bg-sidebar border-r border-sidebar-border h-screen sticky top-0 overflow-y-auto">
        <SidebarContent />
      </div>

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0">
        <TestEnvBanner />
        <TopBar />
        <ViewAsBanner />
        <OnboardingBanner />
        <main className="flex-1 p-4 md:p-8 overflow-x-hidden">
          {children}
        </main>
        <BrandFooter />
      </div>
    </div>
  );
}

// Brand footer shown under every page's content so the NCRP identity is present
// no matter where the user navigates.
function BrandFooter() {
  return (
    <footer className="border-t border-border bg-card/40 px-4 md:px-8 py-5 flex flex-col sm:flex-row items-center justify-center gap-4 sm:gap-6">
      <div className="flex items-center gap-3">
        <img src={ncrpLogo} alt="NCRP" className="h-7 w-7 object-contain shrink-0 opacity-80" />
        <div className="text-center sm:text-left">
          <div className="font-display tracking-widest text-sm text-nc-cyan">NCRP</div>
          <div className="font-mono text-[10px] text-muted-foreground uppercase tracking-widest">
            Night City RP // Subnet Portal
          </div>
        </div>
      </div>
      <a
        href="https://discord.gg/ncrp"
        target="_blank"
        rel="noreferrer"
        className="group flex w-full sm:w-auto items-center justify-center gap-2.5 border border-nc-cyan bg-nc-cyan/10 px-5 py-3 font-display text-sm text-nc-cyan shadow-[0_0_18px_rgba(0,255,255,0.25)] transition-all hover:bg-nc-cyan/20 hover:shadow-[0_0_26px_rgba(0,255,255,0.45)]"
        data-testid="link-footer-discord"
      >
        <DiscordIcon className="h-5 w-5 shrink-0" />
        <span className="uppercase tracking-widest">Join Night City Today</span>
        <span className="font-mono text-[11px] text-nc-cyan/70 normal-case tracking-normal">discord.gg/ncrp</span>
      </a>
      <a
        href="https://vrchat.com/home/group/grp_667e7e40-7ea9-4142-a81e-5939c18c990f"
        target="_blank"
        rel="noreferrer"
        className="group flex w-full sm:w-auto items-center justify-center gap-2.5 border border-nc-magenta bg-nc-magenta/10 px-5 py-3 font-display text-sm text-nc-magenta shadow-[0_0_18px_rgba(255,0,128,0.2)] transition-all hover:bg-nc-magenta/20 hover:shadow-[0_0_26px_rgba(255,0,128,0.4)]"
        data-testid="link-footer-vrchat"
      >
        <VRChatIcon className="h-6 w-auto shrink-0" />
        <span className="uppercase tracking-widest">Join the Group</span>
      </a>
      <a
        href="https://github.com/Cynthia-Ardman/NightCityRPWebsite"
        target="_blank"
        rel="noreferrer"
        className="group flex w-full sm:w-auto items-center justify-center gap-2 border border-border bg-card/60 px-4 py-3 font-mono text-xs text-muted-foreground transition-colors hover:border-nc-cyan/60 hover:text-nc-cyan"
        data-testid="link-footer-github"
      >
        <GitHubIcon className="h-4 w-4 shrink-0" />
        <span className="uppercase tracking-widest">View Source</span>
      </a>
    </footer>
  );
}

function GitHubIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.52 11.52 0 0 1 12 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222 0 1.606-.014 2.898-.014 3.293 0 .322.216.694.825.576C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
    </svg>
  );
}

function VRChatIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 6.4 24 11.4" fill="currentColor" className={className} aria-label="VRChat" role="img">
      <path d="M22.732 6.767H1.268A1.27 1.27 0 0 0 0 8.035v5.296c0 .7.57 1.268 1.268 1.268h18.594l1.725 2.22c.215.275.443.415.68.415.153 0 .296-.06.403-.167.128-.129.193-.308.193-.536l-.002-1.939A1.27 1.27 0 0 0 24 13.331V8.035c0-.7-.569-1.269-1.268-1.269Zm.8 6.564a.8.8 0 0 1-.8.801h-.34v.031l.004 2.371c0 .155-.05.233-.129.233s-.19-.079-.31-.235l-1.866-2.4H1.268a.8.8 0 0 1-.8-.8V8.064a.8.8 0 0 1 .8-.8h21.464a.8.8 0 0 1 .8.8v5.266ZM4.444 8.573c-.127 0-.225.041-.254.15l-.877 3.129-.883-3.128c-.03-.11-.127-.15-.254-.15-.202 0-.473.126-.473.311 0 .012.005.035.011.058l1.114 3.63c.058.173.265.254.485.254s.433-.08.484-.254l1.109-3.63c.005-.023.011-.04.011-.058 0-.179-.27-.312-.473-.312Zm2.925 2.36c.433-.132.757-.49.757-1.153 0-.918-.612-1.207-1.368-1.207H5.614a.234.234 0 0 0-.242.231v3.752c0 .156.184.237.374.237s.376-.081.376-.237V11.05h.484l.82 1.593c.058.115.156.179.26.179.219 0 .467-.203.467-.393a.155.155 0 0 0-.028-.092l-.756-1.403Zm-.61-.473h-.636V9.231h.635c.375 0 .618.162.618.618s-.242.612-.618.612Zm10.056.826h1.004l-.502-1.772-.502 1.772Zm4.684-3.095H9.366a.8.8 0 0 0-.8.8v3.383a.8.8 0 0 0 .8.8h12.132a.8.8 0 0 0 .8-.8V8.992a.8.8 0 0 0-.8-.801Zm-10.946 3.977c.525 0 .571-.374.589-.617.011-.179.173-.236.369-.236.26 0 .38.075.38.369 0 .698-.57 1.142-1.379 1.142-.727 0-1.327-.357-1.327-1.322v-1.61c0-.963.606-1.322 1.333-1.322.802 0 1.374.427 1.374 1.097 0 .3-.121.37-.375.37-.214 0-.37-.064-.375-.238-.012-.178-.052-.57-.6-.57-.387 0-.606.213-.606.663v1.61c0 .45.219.664.617.664Zm4.703.388c0 .156-.19.237-.375.237s-.375-.081-.375-.237V10.9h-1.299v1.656c0 .156-.19.237-.375.237s-.375-.081-.375-.237V8.804c0-.161.185-.23.375-.23s.375.069.375.23v1.507h1.299V8.804c0-.161.185-.23.375-.23s.375.069.375.23v3.752Zm3.198.236c-.127 0-.225-.04-.254-.15l-.22-.768h-1.322l-.219.768c-.029.11-.127.15-.254.15-.202 0-.473-.127-.473-.311 0-.012.006-.035.012-.058l1.114-3.63c.051-.173.265-.254.478-.254s.433.08.485.254l1.114 3.63c.006.023.012.04.012.058 0 .179-.272.311-.473.311Zm2.989-3.543h-.843v3.306c0 .156-.19.237-.375.237s-.375-.081-.375-.237V9.25h-.848c-.15 0-.237-.157-.237-.34 0-.162.075-.336.237-.336h2.44c.162 0 .238.173.238.335 0 .18-.087.34-.237.34Z" />
    </svg>
  );
}

function DiscordIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M20.317 4.369a19.79 19.79 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.249a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.036A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.1 13.1 0 0 1-1.872-.892.077.077 0 0 1-.008-.128c.126-.094.252-.192.372-.291a.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.061 0a.074.074 0 0 1 .078.009c.12.099.246.198.373.292a.077.077 0 0 1-.006.127 12.3 12.3 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.84 19.84 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.331c-1.182 0-2.157-1.085-2.157-2.419 0-1.333.956-2.418 2.157-2.418 1.21 0 2.176 1.094 2.157 2.418 0 1.334-.956 2.419-2.157 2.419zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.418 2.157-2.418 1.21 0 2.176 1.094 2.157 2.418 0 1.334-.946 2.419-2.157 2.419z" />
    </svg>
  );
}

// Muted per-section accent palette. Each nav section gets ONE calm color so the
// sidebar reads as organized groups, not a rainbow. Icons + headings rest at low
// opacity (not bright); the icon brightens on hover and the active row shows the
// full tone on its icon and left border. "neutral" keeps utility rows uncolored.
const NAV_TONES = {
  cyan: { icon: "text-nc-cyan/60 group-hover:text-nc-cyan", iconActive: "text-nc-cyan", activeBorder: "border-nc-cyan", heading: "text-nc-cyan/70", hover: "hover:text-nc-cyan hover:border-nc-cyan/50 hover:bg-nc-cyan/5" },
  green: { icon: "text-nc-green/60 group-hover:text-nc-green", iconActive: "text-nc-green", activeBorder: "border-nc-green", heading: "text-nc-green/70", hover: "hover:text-nc-green hover:border-nc-green/50 hover:bg-nc-green/5" },
  yellow: { icon: "text-nc-yellow/60 group-hover:text-nc-yellow", iconActive: "text-nc-yellow", activeBorder: "border-nc-yellow", heading: "text-nc-yellow/70", hover: "hover:text-nc-yellow hover:border-nc-yellow/50 hover:bg-nc-yellow/5" },
  magenta: { icon: "text-nc-magenta/60 group-hover:text-nc-magenta", iconActive: "text-nc-magenta", activeBorder: "border-nc-magenta", heading: "text-nc-magenta/70", hover: "hover:text-nc-magenta hover:border-nc-magenta/50 hover:bg-nc-magenta/5" },
  orange: { icon: "text-nc-orange/60 group-hover:text-nc-orange", iconActive: "text-nc-orange", activeBorder: "border-nc-orange", heading: "text-nc-orange/70", hover: "hover:text-nc-orange hover:border-nc-orange/50 hover:bg-nc-orange/5" },
  neutral: { icon: "text-muted-foreground group-hover:text-foreground", iconActive: "text-foreground", activeBorder: "border-foreground/40", heading: "text-muted-foreground", hover: "hover:text-foreground hover:border-foreground/30 hover:bg-foreground/5" },
} as const;

type NavTone = keyof typeof NAV_TONES;

function SidebarContent() {
  const { data: user } = useEffectiveMe();
  const [location] = useLocation();
  const { data: offers } = useListMyOffers({ query: { enabled: !!user, queryKey: getListMyOffersQueryKey() } });
  const pendingOffers = (offers ?? []).filter((o) => o.status === "pending").length;
  // Staff review queue counter (misc requests + new-character sheets awaiting
  // approval). Only fetched for staff so regular players never trigger the
  // staff-scoped endpoints.
  const isStaff = !!user && (user.isFixer || user.isCsApprover || user.isAdmin);
  // Unseen-by-me review counts (edits + misc requests + sheets). These already
  // role-gate and exclude the viewer's own submissions server-side, and drop as
  // the reviewer opens each item. Lore has no seen-tracking (single admin
  // approver), so it keeps the raw pending count.
  const { data: unseen } = useGetReviewUnseenCounts({ query: { enabled: isStaff, queryKey: getGetReviewUnseenCountsQueryKey() } });
  const { data: pendingLore } = useListLoreEdits(
    { status: "pending" },
    { query: { enabled: !!user?.isAdmin, queryKey: getListLoreEditsQueryKey({ status: "pending" }) } },
  );
  const { data: pendingGuidebook } = useListGuidebookEdits(
    { status: "pending" },
    { query: { enabled: !!user?.isAdmin, queryKey: getListGuidebookEditsQueryKey({ status: "pending" }) } },
  );
  const staffPending =
    (unseen?.edits ?? 0) +
    (unseen?.requests ?? 0) +
    (unseen?.sheets ?? 0) +
    (user?.isAdmin ? pendingLore?.length ?? 0 : 0) +
    (user?.isAdmin ? pendingGuidebook?.length ?? 0 : 0);
  // Player-facing "My Requests" badge: how many of the player's OWN submissions
  // have unseen activity (a reviewer comment, a decision, or a close). Fetched
  // for every logged-in user, not just staff.
  const { data: myUnseen } = useGetMyUnseen({ query: { enabled: !!user, queryKey: getGetMyUnseenQueryKey() } });
  const myRequestsUnseen = myUnseen?.total ?? 0;

  // Poll for un-started incoming breaches so the "My Breaches" nav can flash
  // red the moment a fixer sends one. No number is shown — just the alert.
  const { data: breachPending } = useGetMyBreachPendingCount({
    query: { enabled: !!user, queryKey: getGetMyBreachPendingCountQueryKey(), refetchInterval: 15000 },
  });
  const hasIncomingBreach = (breachPending?.count ?? 0) > 0;

  const NavItem = ({ href, icon: Icon, label, disabled, badge, alert, tone = "cyan" }: { href: string, icon: any, label: string, disabled?: boolean, badge?: number, alert?: boolean, tone?: NavTone }) => {
    const isActive = location === href || location.startsWith(href + '/');
    if (disabled) return null;
    const t = NAV_TONES[tone];

    return (
      <Link href={href} className={`group flex items-center gap-3 px-4 py-3 text-sm transition-colors border-l-2 ${alert ? "border-destructive" : ""} ${isActive ? `bg-sidebar-accent text-sidebar-accent-foreground ${t.activeBorder}` : `text-sidebar-foreground border-transparent ${t.hover}`}`}>
        <Icon className={`h-4 w-4 transition-colors ${alert ? "text-destructive nav-alert" : isActive ? t.iconActive : t.icon}`} />
        <span className={`font-display tracking-widest uppercase ${alert ? "nav-alert" : ""}`}>{label}</span>
        {badge ? (
          <span
            className="ml-auto min-w-5 h-5 px-1.5 flex items-center justify-center bg-nc-yellow text-background font-mono text-xs font-bold shadow-[0_0_8px_rgba(255,255,0,0.6)] animate-pulse"
            data-testid={`badge-nav-${label.toLowerCase().replace(/\s+/g, '-')}`}
          >
            {badge}
          </span>
        ) : null}
      </Link>
    );
  };

  return (
    <div className="flex flex-col h-full">
      <div className="p-6 border-b border-sidebar-border">
        <Link href="/" className="flex items-center gap-3" data-testid="link-brand-desktop">
          <img src={ncrpLogo} alt="NCRP" className="h-16 w-16 object-contain shrink-0" />
          <div className="min-w-0">
            <h1 className="font-display font-bold text-2xl text-nc-cyan tracking-wider glitch-hover">NCRP</h1>
            <div className="text-xs text-muted-foreground font-mono mt-1">NIGHT_CITY_OS v2.1.4</div>
          </div>
        </Link>
      </div>

      {user && (
        <div className="p-4 border-b border-sidebar-border flex items-center gap-3 bg-card/50">
          <Avatar className="border border-nc-cyan/30 rounded-none">
            <AvatarImage src={user.avatarUrl || ''} />
            <AvatarFallback className="bg-background text-nc-cyan rounded-none font-display">
              {user.username.substring(0, 2).toUpperCase()}
            </AvatarFallback>
          </Avatar>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-bold truncate text-foreground">{user.globalName || user.username}</div>
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto py-4 flex flex-col gap-1">
        <NavItem href="/guidebook" icon={BookMarked} label="Guidebook" tone="cyan" />

        <div className={`px-4 text-xs font-mono ${NAV_TONES.cyan.heading} mb-2 mt-4 uppercase tracking-widest`}>Personal</div>
        <NavItem href="/" icon={User} label="Dashboard" tone="cyan" />
        <NavItem href="/characters" icon={Users} label="Characters" tone="cyan" />
        <NavItem href="/ledger" icon={Receipt} label="Ledger" tone="cyan" />
        <NavItem href="/requests/mine" icon={ClipboardList} label="My Requests" badge={myRequestsUnseen} tone="cyan" />
        <NavItem href="/offers/mine" icon={ShoppingBag} label="My Offers" badge={pendingOffers} tone="cyan" />
        <NavItem href="/breach/mine" icon={Cpu} label="My Breaches" alert={hasIncomingBreach} tone="cyan" />
        <NavItem href="/dice" icon={Dice5} label="Dice Roller" tone="cyan" />

        <div className={`px-4 text-xs font-mono ${NAV_TONES.green.heading} mb-2 mt-6 uppercase tracking-widest`}>Directory</div>
        <NavItem href="/missions" icon={Briefcase} label="Missions" tone="green" />
        <NavItem href="/directory/calendar" icon={CalendarDays} label="Calendar" tone="green" />
        <NavItem href="/directory/stores" icon={Store} label="Stores" tone="green" />
        <NavItem href="/directory/ripperdocs" icon={Stethoscope} label="Ripperdocs" tone="green" />
        <NavItem href="/directory/lore" icon={BookOpen} label="Lore" tone="green" />

        <div className={`px-4 text-xs font-mono ${NAV_TONES.yellow.heading} mb-2 mt-6 uppercase tracking-widest`}>Marketplace</div>
        <NavItem href="/catalog/guns" icon={Skull} label="Guns" tone="yellow" />
        <NavItem href="/catalog/cyberware" icon={Syringe} label="Cyberware" tone="yellow" />
        <NavItem href="/catalog/rent" icon={Building2} label="Property" tone="yellow" />

        {user && (user.isStoreOwner || user.isRipperdoc || user.isFixer || user.isCsApprover || user.isAdmin) && (
          <div className={`px-4 text-xs font-mono ${NAV_TONES.magenta.heading} mb-2 mt-6 uppercase tracking-widest`}>Management</div>
        )}
        
        {user?.isStoreOwner && <NavItem href="/stores" icon={Warehouse} label="Manage Stores" tone="magenta" />}
        {user?.isRipperdoc && <NavItem href="/clinics" icon={HeartPulse} label="Manage Clinics" tone="magenta" />}
        {(user?.isRipperdoc || user?.isAdmin) && <NavItem href="/ripperdoc" icon={Wrench} label="Ripperdoc Console" tone="magenta" />}
        {user && (user.isFixer || user.isAdmin) && <NavItem href="/fixer" icon={Network} label="Fixer Hub" tone="magenta" />}
        {/* Character Archive lists rosters of every sheet; sheet bodies are
            owner/staff-only (see directory.ts), so it lives in the staff-only
            Management group rather than the public Directory. */}
        {user && (user.isFixer || user.isAdmin) && (
          <NavItem href="/directory/characters" icon={Archive} label="Character Archive" tone="magenta" />
        )}
        {user && (user.isFixer || user.isAdmin) && <NavItem href="/breach" icon={Cpu} label="Breach Control" tone="magenta" />}
        {/* Unified staff review queue (misc requests / character edits /
            new characters). Each tab self-gates by role inside the page,
            but only fixers / cs-approvers / admins have anything to do here,
            so the nav link is staff-gated. */}
        {user && (user.isFixer || user.isCsApprover || user.isAdmin) && (
          <NavItem href="/requests" icon={FileText} label="Pending Requests" badge={staffPending} tone="magenta" />
        )}
        {user?.isAdmin && <NavItem href="/admin" icon={Shield} label="System Admin" tone="magenta" />}

        {/* Settings sits on its own at the very bottom, below every category. */}
        <div className="mt-6">
          <NavItem href="/settings" icon={Settings} label="Settings" tone="neutral" />
        </div>
      </div>

      <div className="p-4 border-t border-sidebar-border mt-auto">
        {user ? (
          <form action="/api/auth/logout" method="POST">
            <Button type="submit" variant="ghost" className="w-full justify-start text-muted-foreground hover:text-destructive hover:bg-destructive/10 border-transparent rounded-none font-display">
              <LogOut className="h-4 w-4 mr-2" />
              DISCONNECT
            </Button>
          </form>
        ) : (
          <Button asChild className="w-full rounded-none font-display bg-nc-cyan text-background hover:bg-nc-cyan/80">
            <a href="/api/auth/discord/login">
              LOGIN VIA DISCORD
            </a>
          </Button>
        )}
      </div>
    </div>
  );
}

// Test-environment banner. The live site is a production Vite build
// (import.meta.env.DEV === false); the free community test site runs from the
// Replit dev workspace (DEV === true). Showing this only in dev makes it
// obvious to testers that nothing here affects the real server: outbound
// Discord posts/DMs and real eddie movements are suppressed off-deployment.
function TestEnvBanner() {
  if (!import.meta.env.DEV) return null;
  return (
    <div
      className="w-full bg-nc-yellow/10 border-b border-nc-yellow/40 text-nc-yellow px-4 py-2 text-center font-mono text-xs tracking-wider"
      data-testid="banner-test-env"
    >
      ⚠ TEST ENVIRONMENT — this is a sandbox copy of live data. Nothing you do
      here touches the real server, economy, or Discord.
    </div>
  );
}

// First-run onboarding banner. Shown to a newly-joined player for their first
// few logins, pointing at the most important Guidebook sections. Disappears
// automatically once the login count passes the threshold, or immediately when
// the player dismisses it. Uses the REAL identity (useAuthMe), not the
// admin "View as" override, since onboarding state is per real account.
const ONBOARDING_LOGIN_THRESHOLD = 5;

function OnboardingBanner() {
  const qc = useQueryClient();
  const { data: user } = useAuthMe();
  const { realIsAdmin } = useEffectiveMe();
  const { viewAs, setViewAs } = useViewAs();
  const dismiss = useDismissOnboarding();

  // When an admin previews the app as a brand-new user, force the first-run
  // banner on regardless of the admin's real login count / dismissed flag, so
  // the preview actually reflects what a new player sees.
  const isNewUserPreview = realIsAdmin && viewAs === "new_user";

  if (!user) return null;
  const count = user.loginCount ?? 0;
  if (
    !isNewUserPreview &&
    (user.onboardingBannerDismissed || count > ONBOARDING_LOGIN_THRESHOLD)
  )
    return null;

  function onDismiss() {
    // In a "View as: New User" preview the X just exits the preview — never
    // persist a dismissal against the real admin's account.
    if (isNewUserPreview) {
      setViewAs(null);
      return;
    }
    // Optimistically hide, then persist. Re-fetch /auth/me so the flag sticks.
    qc.setQueryData(getGetMeQueryKey(), (prev: any) =>
      prev ? { ...prev, onboardingBannerDismissed: true } : prev,
    );
    dismiss.mutate(undefined, {
      onSettled: () => qc.invalidateQueries({ queryKey: getGetMeQueryKey() }),
    });
  }

  return (
    <div
      className="w-full bg-nc-cyan/10 border-b border-nc-cyan/40 px-4 md:px-8 py-3"
      data-testid="banner-onboarding"
    >
      <div className="flex items-start gap-3">
        <BookMarked className="h-5 w-5 text-nc-cyan shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <div className="font-display tracking-widest uppercase text-sm text-nc-cyan">
            New to Night City?
          </div>
          <p className="font-mono text-xs text-muted-foreground mt-1">
            Start with the Guidebook — here are the essentials:
          </p>
          <div className="flex flex-wrap gap-2 mt-2">
            {ONBOARDING_BANNER_LINKS.map((l) => (
              <Link
                key={l.key}
                href={guidebookSectionHref(l.key)}
                className="border border-nc-cyan/50 bg-nc-cyan/5 px-3 py-1 font-mono text-xs text-nc-cyan hover:bg-nc-cyan/20 transition-colors"
                data-testid={`link-onboarding-${l.key}`}
              >
                {l.label}
              </Link>
            ))}
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon"
          onClick={onDismiss}
          disabled={dismiss.isPending}
          className="shrink-0 text-muted-foreground hover:text-nc-cyan h-7 w-7 rounded-none"
          aria-label="Dismiss onboarding banner"
          data-testid="button-onboarding-dismiss"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

function TopBar() {
  const { data: user } = useEffectiveMe();
  // Eddies live on the Discord account via Unbelievaboat, not per-character —
  // so the pill is keyed off the user, not the active PC.
  const { data: wallet } = useGetMyWallet({ query: { enabled: !!user, queryKey: getGetMyWalletQueryKey() } });

  return (
    <div className="h-16 border-b border-border bg-card/50 backdrop-blur-sm sticky top-0 z-10 flex items-center justify-between px-4 md:px-8">
      <div className="flex items-center gap-4">
        <ViewAsControl />
      </div>

      <div className="flex items-center gap-6">
        {user && wallet && typeof wallet.balance === "number" && (
          <div className="flex items-center gap-3 border border-nc-yellow/30 bg-nc-yellow/5 px-4 py-1.5 shadow-[0_0_10px_rgba(255,255,0,0.1)]" data-testid="pill-eddies">
            <div className="text-nc-yellow font-display text-sm tracking-widest">EDDIES</div>
            <div className="text-nc-yellow font-mono text-lg font-bold">
              {wallet.balance.toLocaleString()}
              <span className="text-nc-yellow/50 text-xs ml-1">€$</span>
            </div>
            <div className="w-1.5 h-1.5 rounded-full bg-nc-yellow animate-pulse ml-2" title={`Source: ${wallet.source ?? "unknown"}`} />
          </div>
        )}
      </div>
    </div>
  );
}
