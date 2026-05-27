import { useGetDashboardSummary, useGetRecentActivity, useListMyCharacters } from "@workspace/api-client-react";
import { useAuthMe } from "@/hooks/useAuthMe";
import { Link } from "wouter";
import { Activity, Users, Store, Wallet, Clock, ArrowRight, Skull } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";

export default function Home() {
  const { data: user, isLoading: userLoading } = useAuthMe();

  if (userLoading) {
    return <div className="h-full flex items-center justify-center text-nc-cyan animate-pulse font-display text-2xl">LOADING_SYS_DATA...</div>;
  }

  if (!user) {
    return (
      <div className="min-h-[80vh] flex items-center justify-center relative overflow-hidden">
        <div className="absolute inset-0 bg-background/80 z-0" />
        <div className="relative z-10 max-w-3xl text-center space-y-8 p-6">
          <h1 className="text-6xl md:text-8xl font-display font-bold text-nc-cyan glitch-hover tracking-tighter" data-testid="text-hero-title">
            NIGHT CITY RP
          </h1>
          <p className="text-xl md:text-2xl text-muted-foreground font-mono" data-testid="text-hero-subtitle">
            The premier Cyberpunk roleplay experience. Manage your characters, eddies, and empire.
          </p>
          <div className="pt-8">
            <Button asChild size="lg" className="h-16 px-12 text-xl font-display bg-nc-magenta hover:bg-nc-magenta/80 text-foreground rounded-none shadow-[0_0_20px_rgba(255,0,255,0.4)] transition-all hover:shadow-[0_0_40px_rgba(255,0,255,0.6)]" data-testid="button-login-hero">
              <a href="/api/auth/discord/login">
                CONNECT TO SUBNET <ArrowRight className="ml-3 h-6 w-6" />
              </a>
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return <Dashboard />;
}

function Dashboard() {
  const { data: summary, isLoading: summaryLoading } = useGetDashboardSummary();
  const { data: characters, isLoading: charsLoading } = useListMyCharacters();
  // We'll skip recent activity if the hook isn't fully implemented or we just use characters

  if (summaryLoading || charsLoading) {
    return <div className="h-full flex items-center justify-center text-nc-cyan animate-pulse font-display text-2xl">SYNCING_DASHBOARD...</div>;
  }

  return (
    <div className="space-y-8 max-w-6xl mx-auto pb-12">
      <div className="flex items-center justify-between">
        <h1 className="text-4xl font-display font-bold text-foreground" data-testid="text-dashboard-title">SYS_OVERVIEW</h1>
      </div>

      {summary && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <StatCard icon={Users} label="Total Characters" value={summary.characterCount} color="cyan" />
          <StatCard icon={Wallet} label="Total Eddies" value={`€$${summary.totalEddies.toLocaleString()}`} color="yellow" />
          <StatCard icon={Store} label="Open Shops" value={summary.openShops} color="magenta" />
          <StatCard icon={Activity} label="Pending Sheets" value={summary.pendingSheets} color="red" />
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        <div className="lg:col-span-2 space-y-6">
          <div className="flex items-center justify-between">
            <h2 className="text-2xl font-display font-bold text-foreground" data-testid="text-my-chars-title">MY_CHARACTERS</h2>
            <Button asChild variant="outline" size="sm" className="border-nc-cyan text-nc-cyan rounded-none hover:bg-nc-cyan/10">
              <Link href="/characters">VIEW_ALL</Link>
            </Button>
          </div>
          
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {characters?.slice(0, 4).map(char => (
              <Link key={char.id} href={`/characters/${char.id}`}>
                <Card className="rounded-none border-border bg-card/50 hover:border-nc-cyan/50 hover:bg-card transition-all cursor-pointer group" data-testid={`card-dashboard-char-${char.id}`}>
                  <CardHeader className="flex flex-row items-center gap-4 pb-2">
                    <Avatar className="h-12 w-12 border border-border rounded-none group-hover:border-nc-cyan transition-colors">
                      <AvatarImage src={char.portraitUrl || ''} />
                      <AvatarFallback className="bg-background text-nc-cyan rounded-none font-display text-lg">
                        {char.name.substring(0, 2).toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                    <div>
                      <CardTitle className="text-lg font-display group-hover:text-nc-cyan transition-colors">{char.name}</CardTitle>
                      <CardDescription className="font-mono text-xs uppercase">{char.kind} // {char.archetype || 'UNKNOWN'}</CardDescription>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <div className="flex items-center justify-between text-xs font-mono text-muted-foreground">
                      <span className="flex items-center gap-1">
                        <span className={`w-2 h-2 rounded-full ${char.isActive ? 'bg-nc-cyan' : 'bg-muted'} shadow-[0_0_5px_currentColor]`} />
                        {char.isActive ? 'ACTIVE' : 'STANDBY'}
                      </span>
                      {char.approved && <span className="text-nc-cyan">APPROVED</span>}
                    </div>
                  </CardContent>
                </Card>
              </Link>
            ))}
            {(!characters || characters.length === 0) && (
              <div className="col-span-full py-8 text-center border border-dashed border-border bg-card/30 text-muted-foreground font-mono text-sm">
                NO_CHARACTERS_FOUND.
              </div>
            )}
          </div>
        </div>

        <div className="space-y-6">
          <h2 className="text-2xl font-display font-bold text-foreground" data-testid="text-system-logs-title">SYSTEM_LOGS</h2>
          <Card className="rounded-none border-border bg-card/50 min-h-[300px]">
            <CardContent className="p-0">
              <div className="divide-y divide-border/50">
                {/* Fallback logs if recent activity API is not hooked up yet */}
                <div className="p-4 text-sm font-mono text-muted-foreground flex gap-3">
                  <Clock className="w-4 h-4 mt-0.5 text-nc-cyan" />
                  <div>
                    <div className="text-foreground">System initialized</div>
                    <div className="text-xs opacity-50 mt-1">Just now</div>
                  </div>
                </div>
                <div className="p-4 text-sm font-mono text-muted-foreground flex gap-3">
                  <Skull className="w-4 h-4 mt-0.5 text-nc-magenta" />
                  <div>
                    <div className="text-foreground">NCPD Scanner connected</div>
                    <div className="text-xs opacity-50 mt-1">2 mins ago</div>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

function StatCard({ icon: Icon, label, value, color }: { icon: any, label: string, value: string | number, color: 'cyan' | 'magenta' | 'yellow' | 'red' }) {
  const colorMap = {
    cyan: 'text-nc-cyan border-nc-cyan/30 bg-nc-cyan/5 shadow-[0_0_15px_rgba(0,255,255,0.05)]',
    magenta: 'text-nc-magenta border-nc-magenta/30 bg-nc-magenta/5 shadow-[0_0_15px_rgba(255,0,255,0.05)]',
    yellow: 'text-nc-yellow border-nc-yellow/30 bg-nc-yellow/5 shadow-[0_0_15px_rgba(255,255,0,0.05)]',
    red: 'text-destructive border-destructive/30 bg-destructive/5 shadow-[0_0_15px_rgba(255,0,0,0.05)]'
  };

  const iconColorMap = {
    cyan: 'text-nc-cyan',
    magenta: 'text-nc-magenta',
    yellow: 'text-nc-yellow',
    red: 'text-destructive'
  };

  return (
    <Card className={`rounded-none border ${colorMap[color]} transition-all hover:brightness-125`} data-testid={`card-stat-${label.toLowerCase().replace(/\s+/g, '-')}`}>
      <CardContent className="p-4 md:p-6 flex flex-col gap-2">
        <Icon className={`w-6 h-6 ${iconColorMap[color]}`} />
        <div className="text-3xl font-display font-bold text-foreground mt-2">{value}</div>
        <div className="text-xs font-mono text-muted-foreground uppercase tracking-widest">{label}</div>
      </CardContent>
    </Card>
  );
}
