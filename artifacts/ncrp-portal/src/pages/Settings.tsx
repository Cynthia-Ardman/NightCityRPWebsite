import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { useToast } from "@/hooks/use-toast";
import { useAuthMe } from "@/hooks/useAuthMe";
import {
  useNotificationRoles,
  NOTIFICATION_ROLE_META,
  NOTIFICATION_ROLES_KEY,
  type NotificationRoleKey,
  type NotificationRolesStatus,
} from "@/hooks/useNotificationRoles";
import { Bell, BellOff, LogOut, User } from "lucide-react";

export default function Settings() {
  const { data: me } = useAuthMe();

  if (!me) {
    return (
      <div className="max-w-3xl mx-auto py-12 text-center font-mono text-sm text-muted-foreground">
        You need to be signed in to manage your settings.
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto space-y-8 pb-12">
      <div>
        <h1 className="text-4xl font-display font-bold text-foreground" data-testid="text-settings-title">
          SETTINGS
        </h1>
        <p className="font-mono text-xs text-muted-foreground mt-2">
          Manage your notification pings and account.
        </p>
      </div>

      <NotificationsSection />
      <AccountSection />
    </div>
  );
}

function NotificationsSection() {
  const { data, isLoading } = useNotificationRoles();
  const { toast } = useToast();
  const qc = useQueryClient();

  const toggle = useMutation({
    mutationFn: async (vars: { role: NotificationRoleKey; enabled: boolean }): Promise<NotificationRolesStatus> => {
      const r = await fetch("/api/auth/notification-roles", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(vars),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) {
        throw new Error(
          (body as { error?: string })?.error || `Could not update that role (HTTP ${r.status}).`,
        );
      }
      return body as NotificationRolesStatus;
    },
    onSuccess: (result, vars) => {
      // Write the fresh snapshot straight into the cache so the toggle settles
      // on Discord's real resulting state, then invalidate the NPC-role query
      // the dashboard/guidebook CTA reads so they stay in sync.
      qc.setQueryData(NOTIFICATION_ROLES_KEY, result);
      qc.invalidateQueries({ queryKey: NOTIFICATION_ROLES_KEY });
      qc.invalidateQueries({ queryKey: ["npc-role"] });
      const meta = NOTIFICATION_ROLE_META.find((m) => m.key === vars.role);
      toast({
        title: vars.enabled ? `${meta?.label} pings on` : `${meta?.label} pings off`,
        description: vars.enabled
          ? `The ${meta?.label} role was added to your Discord account.`
          : `The ${meta?.label} role was removed from your Discord account.`,
      });
    },
    onError: (err) => {
      // Re-sync from the server so a failed write doesn't leave a stale toggle.
      qc.invalidateQueries({ queryKey: NOTIFICATION_ROLES_KEY });
      toast({
        title: "Couldn't update notifications",
        description: err instanceof Error ? err.message : "Please try again later.",
        variant: "destructive",
      });
    },
  });

  const pendingRole = toggle.isPending
    ? (toggle.variables as { role: NotificationRoleKey } | undefined)?.role
    : undefined;
  const undetermined = !isLoading && data?.determined === false;

  return (
    <Card className="rounded-none border-border bg-card/50" data-testid="card-notifications">
      <CardHeader>
        <CardTitle className="font-display text-xl flex items-center gap-2">
          <Bell className="w-5 h-5 text-nc-cyan" /> NOTIFICATIONS
        </CardTitle>
        <CardDescription className="font-mono text-xs">
          Turn Discord ping roles on or off. Changes apply directly to your Discord account.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-1">
        {undetermined && (
          <div
            className="mb-3 border border-nc-yellow/40 bg-nc-yellow/5 p-3 font-mono text-xs text-nc-yellow"
            data-testid="text-notifications-undetermined"
          >
            Couldn't read your current Discord roles right now. Toggles show your last known
            state — try again shortly.
          </div>
        )}
        {NOTIFICATION_ROLE_META.map((meta) => {
          const on = data?.roles?.[meta.key] ?? false;
          const isRowPending = pendingRole === meta.key;
          return (
            <div
              key={meta.key}
              className="flex items-center gap-4 py-3 border-b border-border/50 last:border-b-0"
              data-testid={`row-notification-${meta.key}`}
            >
              {on ? (
                <Bell className="w-5 h-5 text-nc-cyan shrink-0" />
              ) : (
                <BellOff className="w-5 h-5 text-muted-foreground shrink-0" />
              )}
              <div className="min-w-0 flex-1">
                <div className="font-display text-sm text-foreground">{meta.label}</div>
                <div className="font-mono text-xs text-muted-foreground">{meta.description}</div>
              </div>
              <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground w-12 text-right">
                {isRowPending ? "..." : on ? "On" : "Off"}
              </span>
              <Switch
                checked={on}
                disabled={isLoading || toggle.isPending}
                onCheckedChange={(next) => toggle.mutate({ role: meta.key, enabled: next })}
                data-testid={`switch-notification-${meta.key}`}
                aria-label={`Toggle ${meta.label} notifications`}
              />
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

function AccountSection() {
  const { data: me } = useAuthMe();
  if (!me) return null;

  return (
    <Card className="rounded-none border-border bg-card/50" data-testid="card-account">
      <CardHeader>
        <CardTitle className="font-display text-xl flex items-center gap-2">
          <User className="w-5 h-5 text-nc-magenta" /> ACCOUNT
        </CardTitle>
        <CardDescription className="font-mono text-xs">
          Your linked Discord identity.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="flex items-center gap-4">
          <Avatar className="h-14 w-14 border border-nc-magenta/30 rounded-none">
            <AvatarImage src={me.avatarUrl || ""} className="object-cover" />
            <AvatarFallback className="bg-background text-nc-magenta rounded-none font-display">
              {me.username.substring(0, 2).toUpperCase()}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0">
            <div className="font-display text-lg text-foreground truncate" data-testid="text-account-name">
              {me.globalName || me.username}
            </div>
            <div className="font-mono text-xs text-muted-foreground truncate" data-testid="text-account-username">
              @{me.username}
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-px bg-border/50">
          <div className="bg-card p-3">
            <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              Discord Name
            </div>
            <div className="font-mono text-sm text-foreground mt-1">
              {me.globalName || me.username}
            </div>
          </div>
          <div className="bg-card p-3">
            <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              Legacy Username
            </div>
            <div className="font-mono text-sm text-foreground mt-1" data-testid="text-account-legacy">
              {me.username}
            </div>
          </div>
        </div>

        <form action="/api/auth/logout" method="POST">
          <Button
            type="submit"
            variant="ghost"
            className="text-muted-foreground hover:text-destructive hover:bg-destructive/10 border border-border rounded-none font-display"
            data-testid="button-settings-logout"
          >
            <LogOut className="h-4 w-4 mr-2" />
            SIGN OUT
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
