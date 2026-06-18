import { useParams, Redirect } from "wouter";
import { useState, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetRipperdoc,
  useUpdateRipperdoc,
  useAddRipperdocEmployee,
  useUpdateRipperdocEmployee,
  useRemoveRipperdocEmployee,
  useAddRipperdocStock,
  useUpdateRipperdocStock,
  useRemoveRipperdocStock,
  useCreateRipperdocStockOffer,
  useDepositToRipperdoc,
  useWithdrawFromRipperdoc,
  useGetRipperdocTransactions,
  useListRipperdocOffers,
  useRequestRipperdocStock,
  getGetRipperdocQueryKey,
  getGetRipperdocTransactionsQueryKey,
  getListRipperdocOffersQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Plus, Trash2, DollarSign, PackagePlus } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import CatalogPicker from "@/components/CatalogPicker";
import SelectOrCustom from "@/components/SelectOrCustom";
import { CYBERWARE_SLOTS } from "@/lib/cyberwareOptions";
import CyberwareActionDialog from "@/components/CyberwareActionDialog";
import RemoveCyberwareDialog from "@/components/RemoveCyberwareDialog";
import PurchaseStockDialog from "@/components/PurchaseStockDialog";
import VenueOffersPanel from "@/components/VenueOffersPanel";
import CharacterPicker, { type CharacterPickerValue } from "@/components/CharacterPicker";
import StaffVenuePanel from "@/components/StaffVenuePanel";
import SingleImageUpload from "@/components/SingleImageUpload";
import VenueWalletPanel from "@/components/VenueWalletPanel";
import { useEffectiveMe } from "@/contexts/ViewAsContext";

export default function MyClinicDetail() {
  const { id } = useParams<{ id: string }>();
  const rid = Number(id);
  const qc = useQueryClient();
  const { data, isLoading } = useGetRipperdoc(rid);
  const { toast } = useToast();
  const invalidate = () => qc.invalidateQueries({ queryKey: getGetRipperdocQueryKey(rid) });
  const update = useUpdateRipperdoc({ mutation: { onSuccess: invalidate } });
  const addEmp = useAddRipperdocEmployee({
    mutation: {
      onSuccess: () => {
        invalidate();
        toast({
          title: "Invitation sent",
          description: "The employee will see it in My Requests and must accept before they're hired.",
        });
      },
      onError: (err) => {
        toast({
          title: "Could not invite",
          description: err instanceof Error ? err.message : "Please try again.",
          variant: "destructive",
        });
      },
    },
  });
  const requestStock = useRequestRipperdocStock({
    mutation: {
      onSuccess: () => {
        toast({ title: "Stock request submitted", description: "A fixer will set its cost for you to approve." });
        setStockReqOpen(false);
        setStockReqName("");
        setStockReqCategory("");
        setStockReqDescription("");
      },
      onError: (err) => {
        toast({
          title: "Could not submit request",
          description: err instanceof Error ? err.message : "Please try again.",
          variant: "destructive",
        });
      },
    },
  });
  const updateEmp = useUpdateRipperdocEmployee({ mutation: { onSuccess: invalidate } });
  const removeEmp = useRemoveRipperdocEmployee({ mutation: { onSuccess: invalidate } });
  const addStock = useAddRipperdocStock({ mutation: { onSuccess: invalidate } });
  const updateStock = useUpdateRipperdocStock({ mutation: { onSuccess: invalidate } });
  const removeStock = useRemoveRipperdocStock({ mutation: { onSuccess: invalidate } });
  const { data: txns } = useGetRipperdocTransactions(rid);
  const { data: offers } = useListRipperdocOffers(rid);
  const invalidateWallet = () => {
    invalidate();
    qc.invalidateQueries({ queryKey: getGetRipperdocTransactionsQueryKey(rid) });
  };
  const deposit = useDepositToRipperdoc({ mutation: { onSuccess: invalidateWallet } });
  const withdraw = useWithdrawFromRipperdoc({ mutation: { onSuccess: invalidateWallet } });
  const stockOffer = useCreateRipperdocStockOffer({
    mutation: {
      onSuccess: () => {
        setOfferName("");
        setOfferPrice(0);
        setOfferCwp(0);
        setOfferQty(1);
      },
    },
  });

  const [empChar, setEmpChar] = useState<CharacterPickerValue>(null);
  const [empRole, setEmpRole] = useState("");
  const [empCommission, setEmpCommission] = useState(0);
  const [stockName, setStockName] = useState("");
  const [stockSlot, setStockSlot] = useState("");
  const [stockCwp, setStockCwp] = useState(0);
  const [stockDescription, setStockDescription] = useState("");
  const [stockPrice, setStockPrice] = useState(0);
  const [stockCost, setStockCost] = useState(0);
  const [sellTarget, setSellTarget] = useState<{ id: number; name: string; price: number; quantity: number; cost?: number } | null>(null);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [purchaseOpen, setPurchaseOpen] = useState(false);
  const [stockReqOpen, setStockReqOpen] = useState(false);
  const [stockReqName, setStockReqName] = useState("");
  const [stockReqCategory, setStockReqCategory] = useState("");
  const [stockReqDescription, setStockReqDescription] = useState("");
  const [offerName, setOfferName] = useState("");
  const [offerPrice, setOfferPrice] = useState(0);
  const [offerCwp, setOfferCwp] = useState(0);
  const [offerQty, setOfferQty] = useState(1);
  // Editable clinic profile fields are buffered locally and persisted via an
  // explicit SAVE button (no silent autosave-on-blur), so the owner gets a
  // clear save affordance and confirmation.
  const [edit, setEdit] = useState({ name: "", location: "", purpose: "", description: "" });
  useEffect(() => {
    if (data) {
      setEdit({
        name: data.name ?? "",
        location: data.location ?? "",
        purpose: data.purpose ?? "",
        description: data.description ?? "",
      });
    }
    // Re-seed only when switching to a different clinic; local edits must not be
    // clobbered by background refetches of the same clinic.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.id]);
  const { data: me, viewAs } = useEffectiveMe();
  const canManageCatalog = !!me && (me.isFixer || me.isAdmin);
  // "Add from catalog" is an admin-only convenience for seeding stock from the
  // master catalog; fixers/owners use the custom-stock + buy-stock flows instead.
  const isAdmin = !!me && me.isAdmin;

  // When an admin previews the app as a lower-privilege role, the management
  // view must hide just like it would for that role. Send them to the public
  // clinic page instead of leaking the manage UI.
  if (viewAs && !(me?.isAdmin || me?.isFixer)) {
    return <Redirect to={`/directory/ripperdocs/${rid}`} />;
  }

  if (isLoading) return <div className="font-display text-nc-cyan animate-pulse">LOADING...</div>;
  if (!data) return <div className="font-display text-destructive">NOT FOUND</div>;

  return (
    <div className="max-w-7xl mx-auto space-y-6 pb-12">
      <h1 className="text-4xl font-display" data-testid="text-clinic-name">{data.name}</h1>

      <Card className="rounded-none border-border bg-card/50">
        <CardHeader className="flex flex-row items-center justify-between gap-2">
          <CardTitle className="font-display tracking-widest">EDIT</CardTitle>
          <Button
            size="sm"
            className="rounded-none bg-nc-cyan text-background font-display"
            disabled={update.isPending}
            onClick={() =>
              update.mutate(
                {
                  id: rid,
                  data: {
                    name: edit.name,
                    location: edit.location,
                    purpose: edit.purpose,
                    description: edit.description,
                  },
                },
                { onSuccess: () => toast({ title: "Saved", description: "Clinic details updated." }) },
              )
            }
            data-testid="button-save-clinic"
          >
            {update.isPending ? "SAVING..." : "SAVE"}
          </Button>
        </CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Input value={edit.name} onChange={(e) => setEdit((p) => ({ ...p, name: e.target.value }))} data-testid="input-edit-name" />
          <Input value={edit.location} placeholder="Location" onChange={(e) => setEdit((p) => ({ ...p, location: e.target.value }))} data-testid="input-edit-location" />
          <Input className="md:col-span-2" value={edit.purpose} placeholder="Purpose (what this clinic is for)" onChange={(e) => setEdit((p) => ({ ...p, purpose: e.target.value }))} data-testid="input-edit-purpose" />
          <Textarea className="md:col-span-2" value={edit.description} placeholder="Description" onChange={(e) => setEdit((p) => ({ ...p, description: e.target.value }))} data-testid="input-edit-description" />
          <div className="md:col-span-2 space-y-1">
            <p className="font-mono text-xs text-muted-foreground uppercase">Banner</p>
            <SingleImageUpload
              value={data.bannerUrl ?? ""}
              onChange={(url) => update.mutate({ id: rid, data: { bannerUrl: url || null } })}
              testIdPrefix="clinic-banner"
              alt="Clinic banner"
            />
          </div>
        </CardContent>
      </Card>

      <VenueWalletPanel
        balance={data.balance ?? 0}
        transactions={txns ?? []}
        busy={deposit.isPending || withdraw.isPending}
        onDeposit={(amount) => deposit.mutateAsync({ id: rid, data: { amount, idempotencyKey: crypto.randomUUID() } })}
        onWithdraw={(amount) => withdraw.mutateAsync({ id: rid, data: { amount, idempotencyKey: crypto.randomUUID() } })}
        accent="magenta"
        testIdPrefix="clinic"
      />

      <Card className="rounded-none border-border bg-card/50">
        <CardHeader><CardTitle className="font-display tracking-widest">EMPLOYEES</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          {data.employees.map((e) => (
            <div key={e.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-border/30 py-2 font-mono text-sm" data-testid={`row-employee-${e.id}`}>
              <span>{e.name} <span className="text-nc-magenta uppercase ml-2">{e.role}</span></span>
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground text-xs uppercase">Commission</span>
                <Input
                  type="number"
                  min={0}
                  max={100}
                  defaultValue={e.commissionPct}
                  onBlur={(ev) => {
                    const pct = Math.max(0, Math.min(100, Number(ev.target.value)));
                    if (pct !== e.commissionPct) updateEmp.mutate({ id: rid, employeeId: e.id, data: { commissionPct: pct } });
                  }}
                  className="w-20 h-8"
                  data-testid={`input-employee-commission-${e.id}`}
                />
                <span className="text-muted-foreground text-xs">%</span>
                <Button size="icon" variant="ghost" onClick={() => removeEmp.mutate({ id: rid, employeeId: e.id })} className="text-destructive"><Trash2 className="w-4 h-4" /></Button>
              </div>
            </div>
          ))}
          <div className="grid grid-cols-1 md:grid-cols-12 gap-2 pt-3">
            <div className="md:col-span-5"><CharacterPicker value={empChar} onChange={setEmpChar} testId="input-add-employee-id" /></div>
            <Input className="md:col-span-3" placeholder="Role" value={empRole} onChange={(e) => setEmpRole(e.target.value)} data-testid="input-add-employee-role" />
            <Input
              className="md:col-span-2"
              type="number"
              min={0}
              max={100}
              placeholder="Comm %"
              value={empCommission || ""}
              onChange={(e) => setEmpCommission(Number(e.target.value))}
              data-testid="input-add-employee-commission"
            />
            <Button
              disabled={!empChar?.id}
              onClick={() => {
                if (!empChar?.id) return;
                addEmp.mutate({ id: rid, data: { characterId: empChar.id, role: empRole, commissionPct: Math.max(0, Math.min(100, empCommission)) } });
                setEmpChar(null);
                setEmpCommission(0);
              }}
              className="md:col-span-2 rounded-none bg-nc-magenta text-background font-display"
              data-testid="button-add-employee"
            >
              <Plus className="w-4 h-4" />
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card className="rounded-none border-border bg-card/50">
        <CardHeader className="flex flex-row items-center justify-between flex-wrap gap-2">
          <CardTitle className="font-display tracking-widest">CYBERWARE STOCK</CardTitle>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => setStockReqOpen(true)}
              className="rounded-none font-display"
              data-testid="button-open-stock-request"
            >
              <PackagePlus className="w-3 h-3 mr-1" /> REQUEST CUSTOM STOCK
            </Button>
            <Button
              size="sm"
              onClick={() => setRemoveOpen(true)}
              variant="outline"
              className="rounded-none border-destructive/60 text-destructive hover:bg-destructive hover:text-destructive-foreground font-display"
              data-testid="button-open-remove"
            >
              <Trash2 className="w-3 h-3 mr-1" /> REMOVE CYBERWARE
            </Button>
            <Button
              size="sm"
              onClick={() => setPurchaseOpen(true)}
              className="rounded-none bg-nc-cyan text-background font-display"
              data-testid="button-open-purchase"
            >
              <Plus className="w-3 h-3 mr-1" /> BUY STOCK (CLINIC-FUNDED)
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          {data.stock.map((s) => (
            <div key={s.id} className="flex justify-between items-start border-b border-border/30 py-2 font-mono text-sm gap-2">
              <div className="min-w-0">
                <div>{s.name} <span className="text-nc-yellow ml-2">{s.price.toLocaleString()} €$</span> <span className="text-muted-foreground ml-2">x{s.quantity}</span></div>
                {(s.category || s.notes) && (
                  <div className="text-muted-foreground text-xs mt-0.5">
                    {s.category ? <span className="text-nc-magenta">{s.category}</span> : null}
                    {s.category && s.notes ? " · " : null}
                    {s.notes ?? null}
                  </div>
                )}
                {s.description && <div className="text-muted-foreground text-xs mt-0.5 whitespace-pre-wrap">{s.description}</div>}
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <div className="flex flex-col items-end">
                  <Input
                    className="w-24 h-8 text-xs"
                    type="number"
                    min={0}
                    title="Shop cost (commission comes out of price − cost)"
                    placeholder="Cost"
                    defaultValue={s.cost ?? 0}
                    onBlur={(e) => updateStock.mutate({ id: rid, stockId: s.id, data: { cost: Number(e.target.value) } })}
                    data-testid={`input-stock-cost-${s.id}`}
                  />
                </div>
                <Button
                  size="sm"
                  onClick={() => setSellTarget({ id: s.id, name: s.name, price: s.price, quantity: s.quantity, cost: s.cost ?? 0 })}
                  disabled={s.quantity <= 0}
                  className="rounded-none bg-nc-magenta text-background font-display text-xs"
                  data-testid={`button-install-${s.id}`}
                >
                  <DollarSign className="w-3 h-3 mr-1" /> OFFER
                </Button>
                <Button size="icon" variant="ghost" onClick={() => removeStock.mutate({ id: rid, stockId: s.id })} className="text-destructive"><Trash2 className="w-4 h-4" /></Button>
              </div>
            </div>
          ))}
          <div className="pt-3 space-y-2">
            {isAdmin && (
              <div className="flex justify-end">
                <CatalogPicker
                  kind="cyberware"
                  triggerLabel="ADD FROM CATALOG (ADMIN)"
                  triggerClassName="rounded-none font-display border-nc-magenta text-nc-magenta hover:bg-nc-magenta hover:text-background"
                  onPick={(item) => {
                    setStockName(item.name);
                    setStockSlot(item.category ?? "");
                    setStockPrice(item.price);
                  }}
                />
              </div>
            )}
            <p className="font-mono text-xs text-muted-foreground uppercase tracking-widest">Add custom cyberware</p>
            <div className="grid grid-cols-12 gap-2">
              <Input className="col-span-6" placeholder="Cyberware name" value={stockName} onChange={(e) => setStockName(e.target.value)} data-testid="input-add-cyber-name" />
              <SelectOrCustom
                className="col-span-6"
                value={stockSlot}
                onChange={setStockSlot}
                options={CYBERWARE_SLOTS}
                allowEmpty={false}
                placeholder="Slot *"
                customPlaceholder="Custom slot"
                testId="input-add-cyber-slot"
              />
              <Input className="col-span-4" type="number" min={0} placeholder="CWP" value={stockCwp || ""} onChange={(e) => setStockCwp(Number(e.target.value))} data-testid="input-add-cyber-cwp" />
              <Input className="col-span-4" type="number" min={0} title="Sale price" placeholder="Price" value={stockPrice || ""} onChange={(e) => setStockPrice(Number(e.target.value))} data-testid="input-add-cyber-price" />
              <Input className="col-span-4" type="number" min={0} title="Shop cost (commission comes out of price − cost)" placeholder="Cost" value={stockCost || ""} onChange={(e) => setStockCost(Number(e.target.value))} data-testid="input-add-cyber-cost" />
              <Input className="col-span-6" placeholder="Description (optional)" value={stockDescription} onChange={(e) => setStockDescription(e.target.value)} data-testid="input-add-cyber-description" />
              <Button
                disabled={!stockName.trim() || !stockSlot.trim() || stockPrice < 0 || addStock.isPending}
                onClick={() => {
                  if (!stockName.trim() || !stockSlot.trim()) return;
                  addStock.mutate({
                    id: rid,
                    data: {
                      name: stockName.trim(),
                      slot: stockSlot.trim() || undefined,
                      cwp: stockCwp > 0 ? Math.floor(stockCwp) : undefined,
                      description: stockDescription.trim() || undefined,
                      price: stockPrice,
                      cost: stockCost,
                      quantity: 1,
                    },
                  });
                  setStockName("");
                  setStockSlot("");
                  setStockCwp(0);
                  setStockDescription("");
                  setStockPrice(0);
                  setStockCost(0);
                }}
                className="col-span-12 rounded-none bg-nc-magenta text-background font-display"
                data-testid="button-add-cyber"
              >
                <Plus className="w-4 h-4 mr-1" /> ADD CYBERWARE
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
      {!!me && me.isAdmin && data.ownerId !== me.id && (
        <Card className="rounded-none border-nc-yellow/50 bg-card/50" data-testid="card-admin-stock-offer">
          <CardHeader>
            <CardTitle className="font-display tracking-widest text-nc-yellow">ADMIN · OFFER CYBERWARE TO OWNER</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="font-mono text-xs text-muted-foreground">
              Propose adding a cyberware piece to this clinic's stock. The owner is notified and must approve.
              On approval, the clinic account is charged and the item is added to stock.
              {!data.ownerCharacterId && (
                <span className="block text-destructive mt-1">
                  This clinic's owner has no linked character, so they can't approve an offer.
                </span>
              )}
            </p>
            <div className="grid grid-cols-1 md:grid-cols-12 gap-2">
              <Input
                className="md:col-span-5"
                placeholder="Cyberware name"
                value={offerName}
                onChange={(e) => setOfferName(e.target.value)}
                data-testid="input-offer-name"
              />
              <Input
                className="md:col-span-2"
                type="number"
                min={0}
                placeholder="Price"
                value={offerPrice || ""}
                onChange={(e) => setOfferPrice(Number(e.target.value))}
                data-testid="input-offer-price"
              />
              <Input
                className="md:col-span-2"
                type="number"
                min={0}
                placeholder="CWP"
                value={offerCwp || ""}
                onChange={(e) => setOfferCwp(Number(e.target.value))}
                data-testid="input-offer-cwp"
              />
              <Input
                className="md:col-span-1"
                type="number"
                min={1}
                placeholder="Qty"
                value={offerQty || ""}
                onChange={(e) => setOfferQty(Math.max(1, Number(e.target.value)))}
                data-testid="input-offer-qty"
              />
              <Button
                disabled={!offerName.trim() || !data.ownerCharacterId || stockOffer.isPending}
                onClick={() =>
                  stockOffer.mutate({
                    id: rid,
                    data: {
                      itemName: offerName.trim(),
                      unitPrice: Math.max(0, Math.floor(offerPrice)),
                      quantity: Math.max(1, Math.floor(offerQty)),
                      cwp: offerCwp > 0 ? Math.floor(offerCwp) : null,
                    },
                  })
                }
                className="md:col-span-2 rounded-none bg-nc-yellow text-background font-display"
                data-testid="button-send-offer"
              >
                {stockOffer.isPending ? "SENDING..." : "SEND OFFER"}
              </Button>
            </div>
            {stockOffer.isSuccess && (
              <div className="font-mono text-xs text-nc-green" data-testid="text-offer-sent">
                Offer sent — waiting on the owner's approval.
              </div>
            )}
            {stockOffer.isError && (
              <div className="font-mono text-xs text-destructive" data-testid="text-offer-error">
                {(stockOffer.error as { response?: { data?: { error?: string } } } | null)?.response?.data?.error ??
                  "Could not send offer."}
              </div>
            )}
          </CardContent>
        </Card>
      )}
      <VenueOffersPanel offers={offers ?? []} />
      {!!me && (me.isAdmin || me.isFixer) && (
        <StaffVenuePanel
          kind="ripperdoc"
          venueId={rid}
          currentHousingId={data?.housingId ?? null}
          currentLeaseLabel={data?.lease ? data.lease.address : null}
          onChanged={invalidate}
        />
      )}
      {sellTarget && (
        <CyberwareActionDialog
          venueId={rid}
          stock={sellTarget}
          onClose={() => setSellTarget(null)}
          onDone={() => {
            invalidate();
            qc.invalidateQueries({ queryKey: getListRipperdocOffersQueryKey(rid) });
            setSellTarget(null);
          }}
        />
      )}
      {removeOpen && (
        <RemoveCyberwareDialog
          venueId={rid}
          onClose={() => setRemoveOpen(false)}
          onDone={() => {
            invalidate();
            qc.invalidateQueries({ queryKey: getListRipperdocOffersQueryKey(rid) });
            setRemoveOpen(false);
          }}
        />
      )}
      {purchaseOpen && (
        <PurchaseStockDialog
          kind="ripperdoc"
          venueId={rid}
          balance={data.balance ?? 0}
          canSetCost={canManageCatalog}
          onClose={() => setPurchaseOpen(false)}
          onDone={() => {
            invalidate();
            setPurchaseOpen(false);
          }}
        />
      )}
      <Dialog open={stockReqOpen} onOpenChange={setStockReqOpen}>
        <DialogContent className="rounded-none border-border bg-card sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="font-display tracking-widest text-nc-cyan">Request Custom Stock</DialogTitle>
            <DialogDescription className="font-mono text-xs">
              Ask a fixer to price custom cyberware for this clinic. Once they set a cost, you approve it from My Requests and pay to stock it.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label className="text-[10px] uppercase tracking-widest font-display text-nc-cyan">Cyberware</Label>
              <Input
                value={stockReqName}
                onChange={(e) => setStockReqName(e.target.value)}
                placeholder="e.g. Custom Sandevistan MK.5"
                className="rounded-none font-mono"
                data-testid="input-stock-request-name"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-[10px] uppercase tracking-widest font-display text-nc-cyan">Category (optional)</Label>
              <Input
                value={stockReqCategory}
                onChange={(e) => setStockReqCategory(e.target.value)}
                placeholder="e.g. cyberware"
                className="rounded-none font-mono"
                data-testid="input-stock-request-category"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-[10px] uppercase tracking-widest font-display text-nc-cyan">Description</Label>
              <Textarea
                value={stockReqDescription}
                onChange={(e) => setStockReqDescription(e.target.value)}
                placeholder="Tell the fixer what you want and any details."
                className="rounded-none font-mono min-h-[100px]"
                data-testid="input-stock-request-description"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" className="rounded-none font-display" onClick={() => setStockReqOpen(false)}>
              CANCEL
            </Button>
            <Button
              className="rounded-none font-display tracking-widest bg-nc-cyan text-background hover:bg-nc-cyan/80"
              disabled={!stockReqName.trim() || requestStock.isPending}
              onClick={() =>
                requestStock.mutate({
                  id: rid,
                  data: {
                    name: stockReqName.trim(),
                    category: stockReqCategory.trim() || undefined,
                    description: stockReqDescription.trim() || undefined,
                  },
                })
              }
              data-testid="button-submit-stock-request"
            >
              {requestStock.isPending ? "SUBMITTING..." : "SUBMIT"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
