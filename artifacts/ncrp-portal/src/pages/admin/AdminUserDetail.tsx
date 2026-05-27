import { useParams } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useAdminGetUser,
  useAdminSyncUserRoles,
  getAdminGetUserQueryKey,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { RefreshCw } from "lucide-react";

export default function AdminUserDetail() {
  const { userId } = useParams<{ userId: string }>();
  const qc = useQueryClient();
  const { data: user, isLoading } = useAdminGetUser(userId);
  const sync = useAdminSyncUserRoles({
    mutation: {
      onSuccess: () => qc.invalidateQueries({ queryKey: getAdminGetUserQueryKey(userId) }),
    },
  });

  if (isLoading) return <div className="font-display text-nc-cyan animate-pulse">LOADING_NETRUNNER...</div>;
  if (!user) return <div className="font-display text-destructive">USER NOT FOUND</div>;

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="flex items-center gap-4">
        <Avatar className="w-16 h-16 border border-nc-cyan rounded-none">
          <AvatarImage src={user.avatarUrl ?? ""} />
          <AvatarFallback className="rounded-none bg-background text-nc-cyan font-display">
            {user.username.slice(0, 2).toUpperCase()}
          </AvatarFallback>
        </Avatar>
        <div className="flex-1">
          <h1 className="text-3xl font-display text-foreground" data-testid="text-user-name">
            {user.globalName || user.username}
          </h1>
          <p className="text-xs font-mono text-muted-foreground">@{user.username} · {user.discordId}</p>
        </div>
        <Button
          onClick={() => sync.mutate({ id: userId })}
          disabled={sync.isPending}
          className="rounded-none bg-nc-cyan text-background hover:bg-nc-cyan/80 font-display"
          data-testid="button-sync-roles"
        >
          <RefreshCw className={`w-4 h-4 mr-2 ${sync.isPending ? "animate-spin" : ""}`} />
          SYNC ROLES
        </Button>
      </div>

      <Card className="rounded-none border-border bg-card/50">
        <CardHeader>
          <CardTitle className="font-display tracking-widest">DISCORD ROLES</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          {user.roles.length === 0 ? (
            <span className="text-muted-foreground font-mono text-sm">No roles synced.</span>
          ) : (
            user.roles.map((r) => (
              <Badge key={r} variant="outline" className="rounded-none border-nc-cyan/50 text-nc-cyan font-mono">
                {r}
              </Badge>
            ))
          )}
        </CardContent>
      </Card>

      <Card className="rounded-none border-border bg-card/50">
        <CardHeader>
          <CardTitle className="font-display tracking-widest">CHARACTERS ({user.characters.length})</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {user.characters.map((c) => (
            <div key={c.id} className="flex justify-between border-b border-border/50 py-2 text-sm font-mono">
              <span>{c.name}</span>
              <Badge variant="outline" className="rounded-none border-nc-yellow/50 text-nc-yellow uppercase">
                {c.kind}
              </Badge>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
