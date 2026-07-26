import { useState } from "react";
import { formatEddies } from "@/lib/format";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetCharacterInventory,
  useAddInventoryItem,
  useRemoveInventoryItem,
  useListGuns,
  useListRentListings,
  useLeaseHousing,
  getGetCharacterInventoryQueryKey,
  getGetCharacterQueryKey,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Plus, Trash2, Crosshair, Home } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

// Staff-only "one-stop-shop" grant sections rendered inside the character edit
// dialog. Lets fixers/admins add general gear, catalog guns, and lease property
// onto ANY character without leaving the dialog. All actions apply immediately
// via the inventory / lease endpoints (which now authorize staff-or-owner).
const ITEM_CATEGORIES = ["gear", "weapon", "consumable", "cyberdeck", "vehicle", "misc"];

export default function StaffGrantSections({
  characterId,
  characterName,
}: {
  characterId: number;
  characterName: string;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();

  const { data: inventory } = useGetCharacterInventory(characterId, {
    query: { queryKey: getGetCharacterInventoryQueryKey(characterId) },
  });
  const { data: guns } = useListGuns();
  const { data: listings } = useListRentListings();
  const addInventory = useAddInventoryItem();
  const removeInventory = useRemoveInventoryItem();
  const lease = useLeaseHousing();

  // Gear is everything that is not chrome — cyberware has its own dedicated
  // editor above this section.
  const gear = (inventory ?? []).filter((it) => it.category !== "cyberware");

  const [itemName, setItemName] = useState("");
  const [itemCategory, setItemCategory] = useState("gear");
  const [itemQty, setItemQty] = useState(1);
  const [gunId, setGunId] = useState("");
  const [listingId, setListingId] = useState("");

  async function invalidate() {
    await qc.invalidateQueries({ queryKey: getGetCharacterInventoryQueryKey(characterId) });
    await qc.invalidateQueries({ queryKey: getGetCharacterQueryKey(characterId) });
  }

  async function addItem(name: string, category: string, quantity: number, notes?: string) {
    const trimmed = name.trim();
    if (!trimmed) {
      toast({ title: "Name required", variant: "destructive" });
      return;
    }
    try {
      await addInventory.mutateAsync({
        id: characterId,
        data: { name: trimmed, category, quantity: Math.max(1, quantity), notes: notes ?? undefined },
      });
      await invalidate();
      toast({ title: "Added", description: `${trimmed} added to ${characterName}.` });
    } catch (err) {
      const data = (err as { response?: { data?: { error?: string } } } | null)?.response?.data;
      toast({ title: "Add failed", description: data?.error ?? "Could not add item.", variant: "destructive" });
    }
  }

  async function removeItem(itemId: number, name: string) {
    try {
      await removeInventory.mutateAsync({ id: characterId, itemId });
      await invalidate();
      toast({ title: "Removed", description: `${name} removed.` });
    } catch (err) {
      const data = (err as { response?: { data?: { error?: string } } } | null)?.response?.data;
      toast({ title: "Remove failed", description: data?.error ?? "Could not remove item.", variant: "destructive" });
    }
  }

  async function addGun() {
    const g = (guns ?? []).find((x) => String(x.id) === gunId);
    if (!g) {
      toast({ title: "Pick a gun", variant: "destructive" });
      return;
    }
    await addItem(g.name, "weapon", 1, "Granted from gun catalog");
    setGunId("");
  }

  async function assignProperty() {
    const l = (listings ?? []).find((x) => String(x.id) === listingId);
    if (!l) {
      toast({ title: "Pick a property", variant: "destructive" });
      return;
    }
    try {
      await lease.mutateAsync({ data: { catalogRentId: l.id, characterId } });
      await invalidate();
      await qc.invalidateQueries({ queryKey: getGetCharacterQueryKey(characterId) });
      toast({ title: "Property leased", description: `${l.name} leased to ${characterName}.` });
      setListingId("");
    } catch (err) {
      const data = (err as { response?: { data?: { error?: string } } } | null)?.response?.data;
      toast({ title: "Lease failed", description: data?.error ?? "Could not lease property.", variant: "destructive" });
    }
  }

  const selectClass =
    "flex h-10 w-full rounded-none border border-input bg-background px-3 py-2 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-nc-cyan";

  return (
    <div className="border border-nc-magenta/30 p-4 space-y-5 bg-card/20" data-testid="section-staff-grant">
      <div className="font-display tracking-widest text-nc-magenta text-sm">STAFF: GRANT ITEMS / GUNS / PROPERTY</div>

      {/* Gear & items */}
      <div className="space-y-2">
        <Label className="text-xs tracking-widest text-nc-cyan">GEAR &amp; ITEMS</Label>
        {gear.length === 0 && <div className="text-muted-foreground italic text-xs">No gear yet.</div>}
        {gear.map((it) => (
          <div
            key={it.id}
            className="flex items-center justify-between gap-2 border border-border/40 px-3 py-2 bg-card/30"
            data-testid={`staff-item-${it.id}`}
          >
            <span className="truncate">
              <span className="font-bold">{it.name}</span>
              {it.quantity > 1 && <span className="text-muted-foreground"> ×{it.quantity}</span>}
              {it.category && <span className="text-[10px] text-nc-cyan ml-2 uppercase">[{it.category}]</span>}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="text-destructive h-8 w-8 shrink-0"
              onClick={() => removeItem(it.id, it.name)}
              data-testid={`button-remove-item-${it.id}`}
            >
              <Trash2 className="w-4 h-4" />
            </Button>
          </div>
        ))}
        <div className="grid grid-cols-1 sm:grid-cols-[1fr_140px_90px_auto] gap-2 items-end">
          <div>
            <Label className="text-[10px] text-muted-foreground">NAME</Label>
            <Input value={itemName} onChange={(e) => setItemName(e.target.value)} placeholder="e.g. Med kit" data-testid="input-staff-item-name" />
          </div>
          <div>
            <Label className="text-[10px] text-muted-foreground">CATEGORY</Label>
            <select value={itemCategory} onChange={(e) => setItemCategory(e.target.value)} className={selectClass} data-testid="select-staff-item-category">
              {ITEM_CATEGORIES.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </div>
          <div>
            <Label className="text-[10px] text-muted-foreground">QTY</Label>
            <Input type="number" min={1} value={itemQty} onChange={(e) => setItemQty(parseInt(e.target.value, 10) || 1)} data-testid="input-staff-item-qty" />
          </div>
          <Button
            type="button"
            size="sm"
            className="rounded-none font-display text-xs bg-nc-cyan text-background"
            disabled={addInventory.isPending}
            onClick={async () => {
              await addItem(itemName, itemCategory, itemQty);
              setItemName("");
              setItemQty(1);
            }}
            data-testid="button-add-staff-item"
          >
            <Plus className="w-3 h-3 mr-1" /> ADD
          </Button>
        </div>
      </div>

      {/* Gun from catalog */}
      <div className="space-y-2">
        <Label className="text-xs tracking-widest text-nc-cyan">ADD GUN FROM CATALOG</Label>
        <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-2 items-end">
          <select value={gunId} onChange={(e) => setGunId(e.target.value)} className={selectClass} data-testid="select-staff-gun">
            <option value="">Select a weapon…</option>
            {(guns ?? []).map((g) => (
              <option key={g.id} value={String(g.id)}>{g.name}</option>
            ))}
          </select>
          <Button
            type="button"
            size="sm"
            className="rounded-none font-display text-xs bg-nc-cyan text-background"
            disabled={addInventory.isPending || !gunId}
            onClick={addGun}
            data-testid="button-add-staff-gun"
          >
            <Crosshair className="w-3 h-3 mr-1" /> GRANT GUN
          </Button>
        </div>
      </div>

      {/* Property lease */}
      <div className="space-y-2">
        <Label className="text-xs tracking-widest text-nc-cyan">LEASE PROPERTY</Label>
        <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-2 items-end">
          <select value={listingId} onChange={(e) => setListingId(e.target.value)} className={selectClass} data-testid="select-staff-property">
            <option value="">Select a property…</option>
            {(listings ?? []).map((l) => (
              <option key={l.id} value={String(l.id)}>
                {l.name}{l.district ? ` — ${l.district}` : ""} ({formatEddies(l.monthlyRent)}/mo)
              </option>
            ))}
          </select>
          <Button
            type="button"
            size="sm"
            className="rounded-none font-display text-xs bg-nc-cyan text-background"
            disabled={lease.isPending || !listingId}
            onClick={assignProperty}
            data-testid="button-add-staff-property"
          >
            <Home className="w-3 h-3 mr-1" /> LEASE
          </Button>
        </div>
        <p className="text-[10px] text-muted-foreground">
          Leases the listing to this character immediately. Already-occupied listings are rejected.
        </p>
      </div>
    </div>
  );
}
