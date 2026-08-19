import { useEffectiveMe } from "@/contexts/ViewAsContext";
import { Shield, Users } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import ErrorBoundary from "@/components/ErrorBoundary";
import { VrchatConnectCard } from "@/components/VrchatConnectCard";
import { AuditLogTab } from "./admin/AuditLogTab";
import { FlagsTab } from "./admin/FlagsTab";
import { NpcRoleScanCard } from "./admin/NpcRoleScanCard";
import { UsersTab } from "./admin/UsersTab";
import { CharactersTab } from "./admin/CharactersTab";
import { EconomyTab } from "./admin/EconomyTab";
import { WalletTab } from "./admin/WalletTab";
import { JobsTab } from "./admin/JobsTab";
import { MaintenanceTab } from "./admin/MaintenanceTab";

// Re-export the tab + card components so existing importers (and the
// AdminTabs / WalletTab test suites) keep resolving them from this module.
export { AuditLogTab } from "./admin/AuditLogTab";
export { FlagsTab } from "./admin/FlagsTab";
export { UsersTab } from "./admin/UsersTab";
export { CharactersTab } from "./admin/CharactersTab";
export { EconomyTab } from "./admin/EconomyTab";
export { WalletTab } from "./admin/WalletTab";
export { CharacterSubmissionsCard, JobsTab, LiveModeSwitchboard, LoginRestrictionCard, VrchatCalendarSyncCard } from "./admin/JobsTab";
export { MaintenanceTab } from "./admin/MaintenanceTab";

export default function AdminDashboard() {
  const { data: user, isLoading: userLoading } = useEffectiveMe();

  if (userLoading) {
    return <div className="p-8 text-nc-cyan font-display animate-pulse">AUTH_VERIFICATION...</div>;
  }

  // /admin is ADMIN-only. Fixers have their own /fixer hub.
  if (!user?.isAdmin) {
    return (
      <div className="min-h-[60vh] flex flex-col items-center justify-center text-center space-y-4">
        <Shield className="w-24 h-24 text-destructive opacity-80" />
        <h1 className="text-4xl font-display font-bold text-destructive glitch-hover">ACCESS DENIED</h1>
        <p className="text-muted-foreground font-mono">You lack the necessary clearance level to view this sector.</p>
      </div>
    );
  }

  return (
    <div className="space-y-8 max-w-[1600px] mx-auto pb-12">
      <div>
        <h1 className="text-4xl font-display font-bold text-foreground flex items-center gap-3" data-testid="text-admin-title">
          <Shield className="w-8 h-8 text-destructive" />
          SYSTEM_ADMIN
        </h1>
        <p className="text-muted-foreground font-mono mt-2">God mode enabled. Proceed with caution.</p>
      </div>

      <Tabs defaultValue="users" className="w-full">
        <TabsList className="bg-card border border-border rounded-none p-0 h-auto grid grid-cols-2 md:grid-cols-9 max-w-6xl w-full">
          <TabsTrigger value="users" className="rounded-none font-display uppercase tracking-widest data-[state=active]:bg-nc-cyan/10 data-[state=active]:text-nc-cyan data-[state=active]:border-b-2 data-[state=active]:border-nc-cyan py-3" data-testid="tab-users">Users</TabsTrigger>
          <TabsTrigger value="characters" className="rounded-none font-display uppercase tracking-widest data-[state=active]:bg-nc-cyan/10 data-[state=active]:text-nc-cyan data-[state=active]:border-b-2 data-[state=active]:border-nc-cyan py-3" data-testid="tab-chars">Characters</TabsTrigger>
          <TabsTrigger value="wallet" className="rounded-none font-display uppercase tracking-widest data-[state=active]:bg-nc-cyan/10 data-[state=active]:text-nc-cyan data-[state=active]:border-b-2 data-[state=active]:border-nc-cyan py-3" data-testid="tab-wallet">Wallets</TabsTrigger>
          <TabsTrigger value="economy" className="rounded-none font-display uppercase tracking-widest data-[state=active]:bg-nc-cyan/10 data-[state=active]:text-nc-cyan data-[state=active]:border-b-2 data-[state=active]:border-nc-cyan py-3" data-testid="tab-economy">Economy</TabsTrigger>
          <TabsTrigger value="jobs" className="rounded-none font-display uppercase tracking-widest data-[state=active]:bg-nc-cyan/10 data-[state=active]:text-nc-cyan data-[state=active]:border-b-2 data-[state=active]:border-nc-cyan py-3" data-testid="tab-jobs">Cron Jobs</TabsTrigger>
          <TabsTrigger value="audit" className="rounded-none font-display uppercase tracking-widest data-[state=active]:bg-nc-cyan/10 data-[state=active]:text-nc-cyan data-[state=active]:border-b-2 data-[state=active]:border-nc-cyan py-3" data-testid="tab-audit">Audit Log</TabsTrigger>
          <TabsTrigger value="flags" className="rounded-none font-display uppercase tracking-widest data-[state=active]:bg-nc-cyan/10 data-[state=active]:text-nc-cyan data-[state=active]:border-b-2 data-[state=active]:border-nc-cyan py-3" data-testid="tab-flags">System Flags</TabsTrigger>
          <TabsTrigger value="maintenance" className="rounded-none font-display uppercase tracking-widest data-[state=active]:bg-nc-cyan/10 data-[state=active]:text-nc-cyan data-[state=active]:border-b-2 data-[state=active]:border-nc-cyan py-3" data-testid="tab-maintenance">Maintenance</TabsTrigger>
          <TabsTrigger value="vrchat" className="rounded-none font-display uppercase tracking-widest data-[state=active]:bg-nc-cyan/10 data-[state=active]:text-nc-cyan data-[state=active]:border-b-2 data-[state=active]:border-nc-cyan py-3" data-testid="tab-vrchat">VRChat</TabsTrigger>
        </TabsList>

        <div className="mt-8">
          <TabsContent value="users">
            <ErrorBoundary>
              <div className="space-y-6">
                <NpcRoleScanCard />
                <UsersTab />
              </div>
            </ErrorBoundary>
          </TabsContent>
          <TabsContent value="characters">
            <ErrorBoundary><CharactersTab /></ErrorBoundary>
          </TabsContent>
          <TabsContent value="wallet">
            <ErrorBoundary><WalletTab /></ErrorBoundary>
          </TabsContent>
          <TabsContent value="economy">
            <ErrorBoundary><EconomyTab /></ErrorBoundary>
          </TabsContent>
          <TabsContent value="jobs">
            <ErrorBoundary><JobsTab /></ErrorBoundary>
          </TabsContent>
          <TabsContent value="audit">
            <ErrorBoundary><AuditLogTab /></ErrorBoundary>
          </TabsContent>
          <TabsContent value="flags">
            <ErrorBoundary><FlagsTab /></ErrorBoundary>
          </TabsContent>
          <TabsContent value="maintenance">
            <ErrorBoundary><MaintenanceTab /></ErrorBoundary>
          </TabsContent>
          <TabsContent value="vrchat">
            <ErrorBoundary>
              <div className="space-y-6 max-w-2xl">
                <div>
                  <h2 className="text-xl font-display font-bold text-foreground">VRCHAT POLLER</h2>
                  <p className="text-muted-foreground font-mono text-sm mt-1">
                    Reconnect the live-instance poller's VRChat session. It signs in once and stays connected for weeks; only reconnect if it drops.
                  </p>
                </div>
                <VrchatConnectCard />
              </div>
            </ErrorBoundary>
          </TabsContent>
        </div>
      </Tabs>
    </div>
  );
}
