import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListWholesalerItems,
  useAdminCreateWholesalerItem,
  useAdminUpdateWholesalerItem,
  useAdminArchiveWholesalerItem,
  getListWholesalerItemsQueryKey,
} from "@workspace/api-client-react";
import { useAuthMe } from "@/hooks/useAuthMe";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Shield, Trash2 } from "lucide-react";

export default function AdminWholesaler() {
  const { data: user, isLoading: userLoading } = useAuthMe();
  const qc = useQueryClient();
  const invalidate = () =>
    qc.invalidateQueries({ queryKey: getListWholesalerItemsQueryKey({ all: true }) });
  const { data: items, isLoading } = useListWholesalerItems({ all: true });
  const create = useAdminCreateWholesalerItem({ mutation: { onSuccess: invalidate } });
  const update = useAdminUpdateWholesalerItem({ mutation: { onSuccess: invalidate } });
  const archive = useAdminArchiveWholesalerItem({ mutation: { onSuccess: invalidate } });

  const [name, setName] = useState("");
  const [category, setCategory] = useState("");
  const [tier, setTier] = useState<"store" | "ripperdoc">("store");
  const [wholesale, setWholesale] = useState(0);
  const [retail, setRetail] = useState<string>("");
  const [cap, setCap] = useState<string>("");
  const [notes, setNotes] = useState("");

  if (userLoading) {
    return <div className="p-8 text-nc-cyan font-display animate-pulse">AUTH_VERIFICATION...</div>;
  }
  if (!user?.isAdmin) {
    return (
      <div className="min-h-[60vh] flex flex-col items-center justify-center text-center space-y-4">
        <Shield className="w-24 h-24 text-destructive opacity-80" />
        <h1 className="text-4xl font-display font-bold text-destructive glitch-hover">ACCESS DENIED</h1>
        <p className="text-muted-foreground font-mono">Admins only.</p>
      </div>
    );
  }

  return (
    <div className="space-y-8 max-w-7xl mx-auto pb-12">
      <div>
        <h1 className="text-4xl font-display font-bold text-foreground flex items-center gap-3" data-testid="text-wholesaler-title">
          <Shield className="w-8 h-8 text-nc-magenta" />
          WHOLESALER_CATALOG
        </h1>
        <p className="text-muted-foreground font-mono mt-2">
          Upstream supply for fixers. Price changes don't retroactively affect stock already placed in venues.
        </p>
      </div>

      <Card className="rounded-none border-border bg-card/50">
        <CardHeader>
          <CardTitle className="font-display text-nc-cyan">Add Item</CardTitle>
          <CardDescription className="font-mono">Wholesale price is what fixers pay per unit. Cap is optional — leave blank for unlimited supply.</CardDescription>
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
                    category: category.trim() || undefined,
                    tier,
                    wholesalePrice: Math.max(0, wholesale || 0),
                    suggestedRetailPrice: retail === "" ? undefined : Math.max(0, Number(retail) || 0),
                    cap: cap === "" ? undefined : Math.max(0, Number(cap) || 0),
                    notes: notes.trim() || undefined,
                  },
                },
                {
                  onSuccess: () => {
                    setName("");
                    setCategory("");
                    setWholesale(0);
                    setRetail("");
                    setCap("");
                    setNotes("");
                  },
                },
              );
            }}
          >
            <div className="md:col-span-3">
              <Label className="text-xs">NAME</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} data-testid="input-whl-name" />
            </div>
            <div className="md:col-span-2">
              <Label className="text-xs">CATEGORY</Label>
              <Input value={category} onChange={(e) => setCategory(e.target.value)} data-testid="input-whl-category" />
            </div>
            <div className="md:col-span-2">
              <Label className="text-xs">TIER</Label>
              <Select value={tier} onValueChange={(v) => setTier(v as "store" | "ripperdoc")}>
                <SelectTrigger data-testid="select-whl-tier"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="store">Store</SelectItem>
                  <SelectItem value="ripperdoc">Ripperdoc</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="md:col-span-1">
              <Label className="text-xs">WHOLESALE</Label>
              <Input type="number" value={wholesale} onChange={(e) => setWholesale(Number(e.target.value))} data-testid="input-whl-price" />
            </div>
            <div className="md:col-span-1">
              <Label className="text-xs">MSRP</Label>
              <Input type="number" value={retail} onChange={(e) => setRetail(e.target.value)} placeholder="opt." data-testid="input-whl-retail" />
            </div>
            <div className="md:col-span-1">
              <Label className="text-xs">CAP</Label>
              <Input type="number" value={cap} onChange={(e) => setCap(e.target.value)} placeholder="∞" data-testid="input-whl-cap" />
            </div>
            <div className="md:col-span-2">
              <Label className="text-xs">NOTES</Label>
              <Input value={notes} onChange={(e) => setNotes(e.target.value)} data-testid="input-whl-notes" />
            </div>
            <div className="md:col-span-12">
              <Button
                type="submit"
                disabled={!name.trim() || create.isPending}
                className="rounded-none bg-nc-cyan text-background font-display"
                data-testid="button-whl-create"
              >
                ADD ITEM
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card className="rounded-none border-border bg-card/50">
        <CardHeader>
          <CardTitle className="font-display text-nc-cyan">Catalog</CardTitle>
          <CardDescription className="font-mono">Click any field to edit. Archived items are hidden from fixers.</CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="text-nc-cyan font-mono animate-pulse">Loading items...</div>
          ) : (
            <div className="rounded-md border border-border overflow-x-auto">
              <Table>
                <TableHeader className="bg-muted/50">
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="font-display text-nc-cyan">Name</TableHead>
                    <TableHead className="font-display text-nc-cyan">Cat.</TableHead>
                    <TableHead className="font-display text-nc-cyan">Tier</TableHead>
                    <TableHead className="font-display text-nc-cyan text-right">Wholesale</TableHead>
                    <TableHead className="font-display text-nc-cyan text-right">MSRP</TableHead>
                    <TableHead className="font-display text-nc-cyan text-right">Cap</TableHead>
                    <TableHead className="font-display text-nc-cyan text-right">Sold</TableHead>
                    <TableHead className="font-display text-nc-cyan">Status</TableHead>
                    <TableHead className="font-display text-nc-cyan w-24">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody className="font-mono text-xs">
                  {(items ?? []).map((it) => (
                    <TableRow key={it.id} className="hover:bg-muted/50 border-border" data-testid={`row-whl-${it.id}`}>
                      <TableCell>
                        <Input
                          defaultValue={it.name}
                          className="h-7"
                          onBlur={(e) => {
                            if (e.target.value !== it.name) update.mutate({ id: it.id, data: { name: e.target.value } });
                          }}
                          data-testid={`input-whl-edit-name-${it.id}`}
                        />
                      </TableCell>
                      <TableCell>
                        <Input
                          defaultValue={it.category ?? ""}
                          className="h-7 w-28"
                          onBlur={(e) => {
                            if ((e.target.value || null) !== (it.category ?? null))
                              update.mutate({ id: it.id, data: { category: e.target.value || null } });
                          }}
                        />
                      </TableCell>
                      <TableCell>
                        <Select
                          defaultValue={it.tier}
                          onValueChange={(v) => update.mutate({ id: it.id, data: { tier: v as "store" | "ripperdoc" } })}
                        >
                          <SelectTrigger className="h-7 w-28"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="store">Store</SelectItem>
                            <SelectItem value="ripperdoc">Ripperdoc</SelectItem>
                          </SelectContent>
                        </Select>
                      </TableCell>
                      <TableCell className="text-right">
                        <Input
                          type="number"
                          defaultValue={it.wholesalePrice}
                          className="h-7 w-24 text-right"
                          onBlur={(e) => {
                            const v = Number(e.target.value);
                            if (v !== it.wholesalePrice) update.mutate({ id: it.id, data: { wholesalePrice: v } });
                          }}
                        />
                      </TableCell>
                      <TableCell className="text-right">
                        <Input
                          type="number"
                          defaultValue={it.suggestedRetailPrice ?? ""}
                          className="h-7 w-24 text-right"
                          onBlur={(e) => {
                            const v = e.target.value === "" ? null : Number(e.target.value);
                            if (v !== (it.suggestedRetailPrice ?? null))
                              update.mutate({ id: it.id, data: { suggestedRetailPrice: v } });
                          }}
                        />
                      </TableCell>
                      <TableCell className="text-right">
                        <Input
                          type="number"
                          defaultValue={it.cap ?? ""}
                          placeholder="∞"
                          className="h-7 w-20 text-right"
                          onBlur={(e) => {
                            const v = e.target.value === "" ? null : Number(e.target.value);
                            if (v !== (it.cap ?? null)) update.mutate({ id: it.id, data: { cap: v } });
                          }}
                        />
                      </TableCell>
                      <TableCell className="text-right text-muted-foreground">{it.unitsOrdered}</TableCell>
                      <TableCell>
                        {it.archived ? (
                          <Badge variant="outline" className="border-destructive text-destructive rounded-none text-[10px] px-1 py-0">ARCHIVED</Badge>
                        ) : (
                          <Badge variant="outline" className="border-nc-cyan text-nc-cyan rounded-none text-[10px] px-1 py-0">ACTIVE</Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        {it.archived ? (
                          <Button
                            size="sm"
                            variant="outline"
                            className="rounded-none border-nc-cyan text-nc-cyan font-display text-xs h-7"
                            onClick={() => update.mutate({ id: it.id, data: { archived: false } })}
                            data-testid={`button-whl-unarchive-${it.id}`}
                          >
                            UNARCHIVE
                          </Button>
                        ) : (
                          <Button
                            size="sm"
                            variant="outline"
                            className="rounded-none border-destructive text-destructive font-display text-xs h-7"
                            onClick={() => {
                              if (confirm(`Archive ${it.name}?`)) archive.mutate({ id: it.id });
                            }}
                            data-testid={`button-whl-archive-${it.id}`}
                          >
                            <Trash2 className="w-3 h-3" />
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                  {!items?.length && (
                    <TableRow>
                      <TableCell colSpan={9} className="text-center text-muted-foreground h-24">NO ITEMS</TableCell>
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
