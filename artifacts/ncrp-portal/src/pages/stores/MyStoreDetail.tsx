import { useParams } from "wouter";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetStore,
  useUpdateStore,
  useAddStoreEmployee,
  useRemoveStoreEmployee,
  useAddStoreStock,
  useUpdateStoreStock,
  useRemoveStoreStock,
  getGetStoreQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Plus, Trash2 } from "lucide-react";

export default function MyStoreDetail() {
  const { id } = useParams<{ id: string }>();
  const storeId = Number(id);
  const qc = useQueryClient();
  const { data: store, isLoading } = useGetStore(storeId);
  const invalidate = () => qc.invalidateQueries({ queryKey: getGetStoreQueryKey(storeId) });
  const update = useUpdateStore({ mutation: { onSuccess: invalidate } });
  const addEmp = useAddStoreEmployee({ mutation: { onSuccess: invalidate } });
  const removeEmp = useRemoveStoreEmployee({ mutation: { onSuccess: invalidate } });
  const addStock = useAddStoreStock({ mutation: { onSuccess: invalidate } });
  const updateStock = useUpdateStoreStock({ mutation: { onSuccess: invalidate } });
  const removeStock = useRemoveStoreStock({ mutation: { onSuccess: invalidate } });

  const [empCharId, setEmpCharId] = useState("");
  const [empRole, setEmpRole] = useState("clerk");
  const [stockName, setStockName] = useState("");
  const [stockPrice, setStockPrice] = useState(0);
  const [stockQty, setStockQty] = useState(1);

  if (isLoading) return <div className="font-display text-nc-cyan animate-pulse">LOADING...</div>;
  if (!store) return <div className="font-display text-destructive">NOT FOUND</div>;

  return (
    <div className="max-w-5xl mx-auto space-y-6 pb-12">
      <h1 className="text-4xl font-display" data-testid="text-store-name">{store.name}</h1>

      <Card className="rounded-none border-border bg-card/50">
        <CardHeader><CardTitle className="font-display tracking-widest">EDIT</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Input defaultValue={store.name} onBlur={(e) => update.mutate({ id: storeId, data: { name: e.target.value } })} data-testid="input-edit-name" />
          <Input defaultValue={store.location ?? ""} onBlur={(e) => update.mutate({ id: storeId, data: { location: e.target.value } })} placeholder="Location" data-testid="input-edit-location" />
          <Textarea className="md:col-span-2" defaultValue={store.description ?? ""} onBlur={(e) => update.mutate({ id: storeId, data: { description: e.target.value } })} placeholder="Description" data-testid="input-edit-description" />
        </CardContent>
      </Card>

      <Card className="rounded-none border-border bg-card/50">
        <CardHeader><CardTitle className="font-display tracking-widest">EMPLOYEES</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          {store.employees.map((e) => (
            <div key={e.id} className="flex justify-between border-b border-border/30 py-2 font-mono text-sm" data-testid={`row-employee-${e.id}`}>
              <span>{e.name} <span className="text-nc-cyan uppercase ml-2">{e.role}</span></span>
              <Button size="icon" variant="ghost" onClick={() => removeEmp.mutate({ id: storeId, empId: e.id })} className="text-destructive"><Trash2 className="w-4 h-4" /></Button>
            </div>
          ))}
          <div className="flex gap-2 pt-3">
            <Input placeholder="Character ID" value={empCharId} onChange={(e) => setEmpCharId(e.target.value)} data-testid="input-add-employee-id" />
            <Input placeholder="Role" value={empRole} onChange={(e) => setEmpRole(e.target.value)} data-testid="input-add-employee-role" />
            <Button onClick={() => empCharId && addEmp.mutate({ id: storeId, data: { characterId: Number(empCharId), role: empRole } })} className="rounded-none bg-nc-cyan text-background font-display" data-testid="button-add-employee"><Plus className="w-4 h-4" /></Button>
          </div>
        </CardContent>
      </Card>

      <Card className="rounded-none border-border bg-card/50">
        <CardHeader><CardTitle className="font-display tracking-widest">STOCK</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          {store.stock.map((s) => (
            <div key={s.id} className="grid grid-cols-12 gap-2 items-center border-b border-border/30 py-2" data-testid={`row-stock-${s.id}`}>
              <Input className="col-span-4" defaultValue={s.name} onBlur={(e) => updateStock.mutate({ id: storeId, stockId: s.id, data: { name: e.target.value } })} />
              <Input className="col-span-2" type="number" defaultValue={s.price} onBlur={(e) => updateStock.mutate({ id: storeId, stockId: s.id, data: { price: Number(e.target.value) } })} />
              <Input className="col-span-2" type="number" defaultValue={s.quantity} onBlur={(e) => updateStock.mutate({ id: storeId, stockId: s.id, data: { quantity: Number(e.target.value) } })} />
              <Input className="col-span-3" defaultValue={s.category ?? ""} placeholder="Category" onBlur={(e) => updateStock.mutate({ id: storeId, stockId: s.id, data: { category: e.target.value } })} />
              <Button size="icon" variant="ghost" onClick={() => removeStock.mutate({ id: storeId, stockId: s.id })} className="text-destructive"><Trash2 className="w-4 h-4" /></Button>
            </div>
          ))}
          <div className="grid grid-cols-12 gap-2 pt-3">
            <Input className="col-span-5" placeholder="Item name" value={stockName} onChange={(e) => setStockName(e.target.value)} data-testid="input-add-stock-name" />
            <Input className="col-span-3" type="number" placeholder="Price" value={stockPrice} onChange={(e) => setStockPrice(Number(e.target.value))} data-testid="input-add-stock-price" />
            <Input className="col-span-2" type="number" placeholder="Qty" value={stockQty} onChange={(e) => setStockQty(Number(e.target.value))} data-testid="input-add-stock-qty" />
            <Button className="col-span-2 rounded-none bg-nc-cyan text-background font-display" onClick={() => stockName && addStock.mutate({ id: storeId, data: { name: stockName, price: stockPrice, quantity: stockQty } })} data-testid="button-add-stock"><Plus className="w-4 h-4 mr-1" /> ADD</Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
