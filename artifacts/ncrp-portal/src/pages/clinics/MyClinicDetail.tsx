import { useParams } from "wouter";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetRipperdoc,
  useUpdateRipperdoc,
  useAddRipperdocEmployee,
  useRemoveRipperdocEmployee,
  useAddRipperdocStock,
  useRemoveRipperdocStock,
  getGetRipperdocQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Plus, Trash2 } from "lucide-react";

export default function MyClinicDetail() {
  const { id } = useParams<{ id: string }>();
  const rid = Number(id);
  const qc = useQueryClient();
  const { data, isLoading } = useGetRipperdoc(rid);
  const invalidate = () => qc.invalidateQueries({ queryKey: getGetRipperdocQueryKey(rid) });
  const update = useUpdateRipperdoc({ mutation: { onSuccess: invalidate } });
  const addEmp = useAddRipperdocEmployee({ mutation: { onSuccess: invalidate } });
  const removeEmp = useRemoveRipperdocEmployee({ mutation: { onSuccess: invalidate } });
  const addStock = useAddRipperdocStock({ mutation: { onSuccess: invalidate } });
  const removeStock = useRemoveRipperdocStock({ mutation: { onSuccess: invalidate } });

  const [empCharId, setEmpCharId] = useState("");
  const [empRole, setEmpRole] = useState("doc");
  const [stockName, setStockName] = useState("");
  const [stockPrice, setStockPrice] = useState(0);

  if (isLoading) return <div className="font-display text-nc-cyan animate-pulse">LOADING...</div>;
  if (!data) return <div className="font-display text-destructive">NOT FOUND</div>;

  return (
    <div className="max-w-5xl mx-auto space-y-6 pb-12">
      <h1 className="text-4xl font-display" data-testid="text-clinic-name">{data.name}</h1>

      <Card className="rounded-none border-border bg-card/50">
        <CardHeader><CardTitle className="font-display tracking-widest">EDIT</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Input defaultValue={data.name} onBlur={(e) => update.mutate({ id: rid, data: { name: e.target.value } })} data-testid="input-edit-name" />
          <Input defaultValue={data.location ?? ""} placeholder="Location" onBlur={(e) => update.mutate({ id: rid, data: { location: e.target.value } })} data-testid="input-edit-location" />
          <Textarea className="md:col-span-2" defaultValue={data.description ?? ""} placeholder="Description" onBlur={(e) => update.mutate({ id: rid, data: { description: e.target.value } })} data-testid="input-edit-description" />
        </CardContent>
      </Card>

      <Card className="rounded-none border-border bg-card/50">
        <CardHeader><CardTitle className="font-display tracking-widest">DOCS</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          {data.employees.map((e) => (
            <div key={e.id} className="flex justify-between border-b border-border/30 py-2 font-mono text-sm">
              <span>{e.name} <span className="text-nc-magenta uppercase ml-2">{e.role}</span></span>
              <Button size="icon" variant="ghost" onClick={() => removeEmp.mutate({ id: rid, employeeId: e.id })} className="text-destructive"><Trash2 className="w-4 h-4" /></Button>
            </div>
          ))}
          <div className="flex gap-2 pt-3">
            <Input placeholder="Character ID" value={empCharId} onChange={(e) => setEmpCharId(e.target.value)} data-testid="input-add-doc-id" />
            <Input placeholder="Role" value={empRole} onChange={(e) => setEmpRole(e.target.value)} data-testid="input-add-doc-role" />
            <Button onClick={() => empCharId && addEmp.mutate({ id: rid, data: { characterId: Number(empCharId), role: empRole } })} className="rounded-none bg-nc-magenta text-background font-display" data-testid="button-add-doc"><Plus className="w-4 h-4" /></Button>
          </div>
        </CardContent>
      </Card>

      <Card className="rounded-none border-border bg-card/50">
        <CardHeader><CardTitle className="font-display tracking-widest">CYBERWARE STOCK</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          {data.stock.map((s) => (
            <div key={s.id} className="flex justify-between border-b border-border/30 py-2 font-mono text-sm">
              <span>{s.name} <span className="text-nc-yellow ml-2">{s.price.toLocaleString()} €$</span> <span className="text-muted-foreground ml-2">x{s.quantity}</span></span>
              <Button size="icon" variant="ghost" onClick={() => removeStock.mutate({ id: rid, stockId: s.id })} className="text-destructive"><Trash2 className="w-4 h-4" /></Button>
            </div>
          ))}
          <div className="flex gap-2 pt-3">
            <Input className="flex-1" placeholder="Cyberware name" value={stockName} onChange={(e) => setStockName(e.target.value)} data-testid="input-add-cyber-name" />
            <Input className="w-32" type="number" placeholder="Price" value={stockPrice} onChange={(e) => setStockPrice(Number(e.target.value))} data-testid="input-add-cyber-price" />
            <Button onClick={() => stockName && addStock.mutate({ id: rid, data: { name: stockName, price: stockPrice, quantity: 1 } })} className="rounded-none bg-nc-magenta text-background font-display" data-testid="button-add-cyber"><Plus className="w-4 h-4" /></Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
