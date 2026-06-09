import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetCharacterInventory,
  useAddInventoryItem,
  useUpdateInventoryItem,
  useRemoveInventoryItem,
  getGetCharacterInventoryQueryKey,
  getGetCharacterQueryKey,
} from "@workspace/api-client-react";
import CyberwareEditor, {
  type CyberRow,
  parseCyberNotes,
  reconcileCyberware,
} from "@/components/CyberwareEditor";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Cpu, Save } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

// Staff-only direct cyberware editor surfaced on the character-detail Cyberware
// tab. Lets fixers/admins add, edit and remove chrome on ANY character without
// opening the edit dialog. Cyberware is stored as inventory_items (category
// "cyberware"); changes apply immediately via the shared reconcile and never go
// through the review queue.
export default function StaffCyberwareCard({
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
  const addInventory = useAddInventoryItem();
  const updateInventory = useUpdateInventoryItem();
  const removeInventory = useRemoveInventoryItem();

  const [cyberRows, setCyberRows] = useState<CyberRow[]>([]);
  // Snapshot of what's actually on the server so the reconcile can diff against
  // it (which rows were removed, which changed) instead of re-writing everything.
  const [cyberOriginal, setCyberOriginal] = useState<CyberRow[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const rows: CyberRow[] = (inventory ?? [])
      .filter((it) => (it.category ?? "").toLowerCase() === "cyberware")
      .map((it) => {
        const parsed = parseCyberNotes(it.notes);
        return { id: it.id, slot: parsed.slot, name: it.name, points: parsed.points, notes: parsed.notes };
      });
    setCyberRows(rows);
    setCyberOriginal(rows);
  }, [inventory]);

  async function save() {
    if (saving) return;
    setSaving(true);
    const working: CyberRow[] = cyberRows.map((r) => ({ ...r }));
    const survivingOriginal = new Map<number, CyberRow>();
    for (const o of cyberOriginal) if (o.id != null) survivingOriginal.set(o.id, o);
    try {
      await reconcileCyberware({
        characterId,
        working,
        survivingOriginal,
        mutations: {
          add: (a) => addInventory.mutateAsync(a),
          update: (a) => updateInventory.mutateAsync(a),
          remove: (a) => removeInventory.mutateAsync(a),
        },
      });
      await qc.invalidateQueries({ queryKey: getGetCharacterInventoryQueryKey(characterId) });
      await qc.invalidateQueries({ queryKey: getGetCharacterQueryKey(characterId) });
      toast({ title: "Cyberware saved", description: `${characterName}'s chrome is updated.` });
    } catch (err) {
      const data = (err as { response?: { data?: { error?: string } } } | null)?.response?.data;
      toast({
        title: "Cyberware save failed",
        description: data?.error ?? "Could not update cyberware. Re-saving is safe.",
        variant: "destructive",
      });
    } finally {
      // Commit whatever actually happened back to local state so a retry only
      // applies what's still outstanding.
      setCyberRows(working);
      setCyberOriginal(Array.from(survivingOriginal.values()));
      setSaving(false);
    }
  }

  return (
    <Card className="rounded-none border-nc-magenta/40 bg-card/50" data-testid="card-staff-cyberware">
      <CardHeader>
        <CardTitle className="font-display tracking-widest text-nc-magenta flex items-center gap-2">
          <Cpu className="w-4 h-4" /> STAFF: MANAGE CYBERWARE
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <CyberwareEditor rows={cyberRows} onChange={setCyberRows} testIdPrefix="staff" />
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <p className="text-[10px] text-muted-foreground">
            Applies immediately and does not go through review. CWP is uncapped for staff.
          </p>
          <Button
            type="button"
            size="sm"
            className="rounded-none font-display text-xs bg-nc-cyan text-background"
            disabled={saving}
            onClick={save}
            data-testid="button-save-staff-cyberware"
          >
            <Save className="w-3 h-3 mr-1" /> {saving ? "SAVING..." : "SAVE CYBERWARE"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
