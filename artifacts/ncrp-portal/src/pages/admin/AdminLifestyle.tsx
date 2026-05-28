import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useAdminListLifestyleTiers,
  useAdminCreateLifestyleTier,
  useAdminUpdateLifestyleTier,
  useAdminArchiveLifestyleTier,
  getAdminListLifestyleTiersQueryKey,
  getListLifestyleTiersQueryKey,
} from "@workspace/api-client-react";
import { useAuthMe } from "@/hooks/useAuthMe";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Shield, Trash2 } from "lucide-react";

export default function AdminLifestyle() {
  const { data: user, isLoading: userLoading } = useAuthMe();
  const qc = useQueryClient();
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: getAdminListLifestyleTiersQueryKey() });
    qc.invalidateQueries({ queryKey: getListLifestyleTiersQueryKey() });
  };
  const { data: tiers, isLoading } = useAdminListLifestyleTiers();
  const create = useAdminCreateLifestyleTier({ mutation: { onSuccess: invalidate } });
  const update = useAdminUpdateLifestyleTier({ mutation: { onSuccess: invalidate } });
  const archive = useAdminArchiveLifestyleTier({ mutation: { onSuccess: invalidate } });

  const [name, setName] = useState("");
  const [monthlyCost, setMonthlyCost] = useState(0);
  const [description, setDescription] = useState("");

  if (userLoading) {
    return <div className="p-8 text-nc-cyan font-display animate-pulse">AUTH_VERIFICATION...</div>;
  }
  if (!user?.isAdmin) {
    return (
      <div className="min-h-[60vh] flex flex-col items-center justify-center text-center space-y-4">
        <Shield className="w-24 h-24 text-destructive opacity-80" />
        <h1 className="text-4xl font-display font-bold text-destructive">ACCESS DENIED</h1>
        <p className="text-muted-foreground font-mono">Admins only.</p>
      </div>
    );
  }

  return (
    <div className="space-y-8 max-w-6xl mx-auto pb-12">
      <div>
        <h1 className="text-4xl font-display font-bold text-foreground flex items-center gap-3" data-testid="text-lifestyle-title">
          <Shield className="w-8 h-8 text-nc-magenta" />
          LIFESTYLE_TIERS
        </h1>
        <p className="text-muted-foreground font-mono mt-2">
          Monthly cost-of-living surcharges debited alongside rent on the 1st of each month. Archived tiers stop being billed but stay attached to existing characters for history.
        </p>
      </div>

      <Card className="rounded-none border-border bg-card/50">
        <CardHeader>
          <CardTitle className="font-display text-nc-cyan">Add Tier</CardTitle>
          <CardDescription className="font-mono">Typical tiers: Street (€$0), Standard (€$500), Affluent (€$2000), Luxury (€$10000).</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="grid grid-cols-1 md:grid-cols-12 gap-3 font-mono text-sm"
            onSubmit={(e) => {
              e.preventDefault();
              if (!name.trim()) return;
              create.mutate(
                {
                  data: {
                    name: name.trim(),
                    monthlyCost: Math.max(0, monthlyCost || 0),
                    description: description.trim() || undefined,
                  },
                },
                {
                  onSuccess: () => {
                    setName("");
                    setMonthlyCost(0);
                    setDescription("");
                  },
                },
              );
            }}
          >
            <div className="md:col-span-3">
              <Label className="text-xs">NAME</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} data-testid="input-lifestyle-name" />
            </div>
            <div className="md:col-span-2">
              <Label className="text-xs">MONTHLY COST (€$)</Label>
              <Input type="number" min={0} value={monthlyCost} onChange={(e) => setMonthlyCost(Number(e.target.value))} data-testid="input-lifestyle-cost" />
            </div>
            <div className="md:col-span-5">
              <Label className="text-xs">DESCRIPTION</Label>
              <Input value={description} onChange={(e) => setDescription(e.target.value)} data-testid="input-lifestyle-desc" />
            </div>
            <div className="md:col-span-2 flex items-end">
              <Button
                type="submit"
                disabled={!name.trim() || create.isPending}
                className="w-full rounded-none bg-nc-cyan text-background font-display"
                data-testid="button-lifestyle-create"
              >
                ADD TIER
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card className="rounded-none border-border bg-card/50">
        <CardHeader>
          <CardTitle className="font-display text-nc-cyan">Catalog</CardTitle>
          <CardDescription className="font-mono">Edit a field and tab/click away to save.</CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="text-nc-cyan font-mono animate-pulse">Loading tiers...</div>
          ) : (
            <div className="rounded-md border border-border overflow-x-auto">
              <Table>
                <TableHeader className="bg-muted/50">
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="font-display text-nc-cyan">Name</TableHead>
                    <TableHead className="font-display text-nc-cyan text-right">Monthly Cost</TableHead>
                    <TableHead className="font-display text-nc-cyan">Description</TableHead>
                    <TableHead className="font-display text-nc-cyan">Status</TableHead>
                    <TableHead className="font-display text-nc-cyan w-28">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody className="font-mono text-xs">
                  {(tiers ?? []).map((t) => (
                    <TableRow key={t.id} className="hover:bg-muted/50 border-border" data-testid={`row-lifestyle-${t.id}`}>
                      <TableCell>
                        <Input
                          defaultValue={t.name}
                          className="h-7"
                          onBlur={(e) => {
                            if (e.target.value !== t.name) update.mutate({ id: t.id, data: { name: e.target.value } });
                          }}
                          data-testid={`input-lifestyle-edit-name-${t.id}`}
                        />
                      </TableCell>
                      <TableCell className="text-right">
                        <Input
                          type="number"
                          defaultValue={t.monthlyCost}
                          className="h-7 w-28 text-right"
                          onBlur={(e) => {
                            const v = Number(e.target.value);
                            if (v !== t.monthlyCost) update.mutate({ id: t.id, data: { monthlyCost: v } });
                          }}
                          data-testid={`input-lifestyle-edit-cost-${t.id}`}
                        />
                      </TableCell>
                      <TableCell>
                        <Input
                          defaultValue={t.description ?? ""}
                          className="h-7"
                          onBlur={(e) => {
                            const v = e.target.value || null;
                            if (v !== (t.description ?? null)) update.mutate({ id: t.id, data: { description: v } });
                          }}
                          data-testid={`input-lifestyle-edit-desc-${t.id}`}
                        />
                      </TableCell>
                      <TableCell>
                        {t.archived ? (
                          <Badge variant="outline" className="border-destructive text-destructive rounded-none text-[10px] px-1 py-0">ARCHIVED</Badge>
                        ) : (
                          <Badge variant="outline" className="border-nc-cyan text-nc-cyan rounded-none text-[10px] px-1 py-0">ACTIVE</Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        {t.archived ? (
                          <Button
                            size="sm"
                            variant="outline"
                            className="rounded-none border-nc-cyan text-nc-cyan font-display text-xs h-7"
                            onClick={() => update.mutate({ id: t.id, data: { archived: false } })}
                            data-testid={`button-lifestyle-unarchive-${t.id}`}
                          >
                            UNARCHIVE
                          </Button>
                        ) : (
                          <Button
                            size="sm"
                            variant="outline"
                            className="rounded-none border-destructive text-destructive font-display text-xs h-7"
                            onClick={() => {
                              if (confirm(`Archive ${t.name}? Existing characters keep their tier but billing stops.`)) archive.mutate({ id: t.id });
                            }}
                            data-testid={`button-lifestyle-archive-${t.id}`}
                          >
                            <Trash2 className="w-3 h-3" />
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                  {!tiers?.length && (
                    <TableRow>
                      <TableCell colSpan={5} className="text-center text-muted-foreground h-24">NO TIERS</TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
