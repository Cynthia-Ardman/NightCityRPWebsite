import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetVrchatSession,
  getGetVrchatSessionQueryKey,
  useConnectVrchatSession,
  useVerifyVrchatSession,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Plug, CheckCircle2, AlertTriangle, Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

// Staff-only card to (re)establish the VRChat poller session. VRChat forces an
// emailed one-time code for logins from this server's datacenter IP, so the
// handshake can't be fully automated: a staffer clicks Connect (which makes
// VRChat email a code to the account), then pastes that code here to finish.
export function VrchatConnectCard() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data: session } = useGetVrchatSession({
    query: { queryKey: getGetVrchatSessionQueryKey(), refetchInterval: 30000 },
  });
  const [code, setCode] = useState("");

  const refresh = () => qc.invalidateQueries({ queryKey: getGetVrchatSessionQueryKey() });

  const connect = useConnectVrchatSession({
    mutation: {
      onSuccess: (res) => {
        refresh();
        if (res.status === "connected") {
          toast({ title: "VRChat connected", description: res.displayName ? `Signed in as ${res.displayName}.` : "Session established." });
        } else {
          toast({ title: "Code sent", description: "VRChat emailed a 6-digit code to the account. Enter it below." });
        }
      },
      onError: (err) =>
        toast({
          title: "Connect failed",
          description: (err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? "Could not start the VRChat login.",
          variant: "destructive",
        }),
    },
  });

  const verify = useVerifyVrchatSession({
    mutation: {
      onSuccess: (res) => {
        setCode("");
        refresh();
        toast({ title: "VRChat connected", description: res.displayName ? `Signed in as ${res.displayName}.` : "Session established." });
      },
      onError: (err) =>
        toast({
          title: "Verification failed",
          description: (err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? "That code was rejected.",
          variant: "destructive",
        }),
    },
  });

  const busy = connect.isPending || verify.isPending;
  const connected = !!session?.connected;
  const pending = !!session?.pending;

  return (
    <Card className="rounded-none border-border bg-card/50" data-testid="card-vrchat-connect">
      <CardHeader>
        <CardTitle className="font-display text-lg flex items-center gap-2">
          <Plug className="w-5 h-5 text-nc-cyan" />
          VRCHAT CONNECTION
          {connected ? (
            <Badge variant="outline" className="rounded-none border-nc-green text-nc-green uppercase flex items-center gap-1">
              <CheckCircle2 className="w-3 h-3" /> Connected
            </Badge>
          ) : (
            <Badge variant="outline" className="rounded-none border-nc-magenta text-nc-magenta uppercase flex items-center gap-1">
              <AlertTriangle className="w-3 h-3" /> Offline
            </Badge>
          )}
        </CardTitle>
        <CardDescription className="font-mono text-xs">
          {connected
            ? `The poller is signed in${session?.displayName ? ` as ${session.displayName}` : ""}. Reconnect only if it drops.`
            : "Sign the poller into VRChat. Click Connect, then paste the 6-digit code VRChat emails to the account."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {!session?.configured ? (
          <p className="font-mono text-xs text-nc-magenta" data-testid="text-connect-unconfigured">
            VRChat credentials aren't configured on the server yet.
          </p>
        ) : null}
        {session?.lastError ? (
          <p className="font-mono text-xs text-nc-magenta break-words" data-testid="text-connect-error">
            Last error: {session.lastError}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            onClick={() => connect.mutate()}
            disabled={busy || !session?.configured}
            className="rounded-none bg-nc-cyan text-black hover:bg-nc-cyan/80 font-display uppercase"
            data-testid="button-vrchat-connect"
          >
            {connect.isPending ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Plug className="w-4 h-4 mr-1" />}
            {connected ? "Reconnect" : pending ? "Resend code" : "Connect"}
          </Button>
        </div>
        {pending ? (
          <div className="flex flex-wrap items-end gap-2 pt-1">
            <div className="space-y-1">
              <label className="font-mono text-xs text-muted-foreground block">Email code</label>
              <Input
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                inputMode="numeric"
                placeholder="123456"
                className="rounded-none w-32 font-mono tracking-widest"
                data-testid="input-vrchat-code"
              />
            </div>
            <Button
              onClick={() => verify.mutate({ data: { code } })}
              disabled={busy || code.length !== 6}
              className="rounded-none bg-nc-green text-black hover:bg-nc-green/80 font-display uppercase"
              data-testid="button-vrchat-verify"
            >
              {verify.isPending ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : null}
              Verify
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

export default VrchatConnectCard;
