import { ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { useGetMyWallet, getGetMyWalletQueryKey } from "@workspace/api-client-react";
import { useAuthMe } from "@/hooks/useAuthMe";
import { LogOut, User, Users, Shield, Store, Syringe, Skull, Dice5, FileText, ChevronLeft, Menu, Briefcase, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";

export default function AppLayout({ children }: { children: ReactNode }) {
  const { data: user } = useAuthMe();
  
  return (
    <div className="min-h-screen w-full flex flex-col md:flex-row bg-background">
      {/* Mobile Header */}
      <div className="md:hidden flex items-center justify-between p-4 border-b border-border bg-card">
        <div className="font-display font-bold text-lg text-nc-cyan glitch-hover">NCRP_PORTAL</div>
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
        <TopBar />
        <main className="flex-1 p-4 md:p-8 overflow-x-hidden">
          {children}
        </main>
      </div>
    </div>
  );
}

function SidebarContent() {
  const { data: user } = useAuthMe();
  const [location] = useLocation();

  const NavItem = ({ href, icon: Icon, label, disabled }: { href: string, icon: any, label: string, disabled?: boolean }) => {
    const isActive = location === href || location.startsWith(href + '/');
    if (disabled) return null;
    
    return (
      <Link href={href} className={`flex items-center gap-3 px-4 py-3 text-sm transition-colors border-l-2 ${isActive ? 'bg-sidebar-accent text-sidebar-accent-foreground border-nc-cyan' : 'text-sidebar-foreground border-transparent hover:bg-sidebar-accent/50 hover:text-nc-cyan'}`}>
        <Icon className="h-4 w-4" />
        <span className="font-display tracking-widest uppercase">{label}</span>
      </Link>
    );
  };

  return (
    <div className="flex flex-col h-full">
      <div className="p-6 border-b border-sidebar-border">
        <h1 className="font-display font-bold text-2xl text-nc-cyan tracking-wider glitch-hover">NCRP</h1>
        <div className="text-xs text-muted-foreground font-mono mt-1">NIGHT_CITY_OS v2.1.4</div>
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
            <div className="text-xs text-nc-cyan font-mono truncate">{user.activeCharacterId ? 'Connected' : 'No Active PC'}</div>
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto py-4 flex flex-col gap-1">
        <div className="px-4 text-xs font-mono text-muted-foreground mb-2 mt-4 uppercase tracking-widest">Personal</div>
        <NavItem href="/" icon={User} label="Dashboard" />
        <NavItem href="/characters" icon={Users} label="Characters" />
        <NavItem href="/missions" icon={Briefcase} label="Missions" />
        <NavItem href="/dice" icon={Dice5} label="Dice Roller" />

        <div className="px-4 text-xs font-mono text-muted-foreground mb-2 mt-6 uppercase tracking-widest">Directory</div>
        {/* Character Archive lists rosters of every sheet. Sheet bodies
            (background, etc.) are owner/staff-only — see directory.ts — so
            clicking a row a non-owner doesn't own will 403 unless they're
            a fixer or admin. Surface the link only to staff to avoid that
            dead-end UX for regular players, who manage their own characters
            from /characters anyway. */}
        {user && (user.isFixer || user.isAdmin) && (
          <NavItem href="/directory/characters" icon={Users} label="Character Archive" />
        )}
        <NavItem href="/directory/stores" icon={Store} label="Stores" />
        <NavItem href="/directory/ripperdocs" icon={Syringe} label="Ripperdocs" />

        <div className="px-4 text-xs font-mono text-muted-foreground mb-2 mt-6 uppercase tracking-widest">Catalogs</div>
        <NavItem href="/catalog/guns" icon={Skull} label="Guns" />
        <NavItem href="/catalog/cyberware" icon={Syringe} label="Cyberware" />
        <NavItem href="/catalog/rent" icon={Store} label="Housing" />

        {user && (user.isStoreOwner || user.isRipperdoc || user.isFixer || user.isCsApprover || user.isAdmin) && (
          <div className="px-4 text-xs font-mono text-muted-foreground mb-2 mt-6 uppercase tracking-widest">Authorized Access</div>
        )}
        
        {user?.isStoreOwner && <NavItem href="/stores" icon={Store} label="Manage Stores" />}
        {user?.isRipperdoc && <NavItem href="/clinics" icon={Syringe} label="Manage Clinics" />}
        {(user?.isRipperdoc || user?.isAdmin) && <NavItem href="/ripperdoc" icon={Syringe} label="Ripperdoc Console" />}
        {user?.isFixer && <NavItem href="/fixer" icon={Users} label="Fixer Hub" />}
        {user?.isFixer && <NavItem href="/fixer/items" icon={Search} label="Item Trace" />}
        {user?.isCsApprover && <NavItem href="/sheets/pending" icon={FileText} label="Pending Sheets" />}
        {/* Pending Edits — everyone can open this. The API filters per-role:
            fixers / cs-approvers / admins see the full review queue;
            regular players see only their OWN pending submissions, so this
            doubles as a "where's my edit?" inbox for players who submitted
            a sheet change and want to track the vote. */}
        {user && (
          <NavItem href="/pending-edits" icon={FileText} label="Pending Edits" />
        )}
        {user?.isAdmin && <NavItem href="/admin" icon={Shield} label="System Admin" />}
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

function TopBar() {
  const { data: user } = useAuthMe();
  // Eddies live on the Discord account via Unbelievaboat, not per-character —
  // so the pill is keyed off the user, not the active PC.
  const { data: wallet } = useGetMyWallet({ query: { enabled: !!user, queryKey: getGetMyWalletQueryKey() } });

  return (
    <div className="h-16 border-b border-border bg-card/50 backdrop-blur-sm sticky top-0 z-10 flex items-center justify-between px-4 md:px-8">
      <div className="flex items-center gap-4">
        {/* Breadcrumbs or page title could go here */}
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
