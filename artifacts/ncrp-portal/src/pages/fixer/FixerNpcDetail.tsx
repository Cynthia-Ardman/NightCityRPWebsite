import { useParams } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetFixerNpc,
  useUpdateFixerNpc,
  getGetFixerNpcQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

export default function FixerNpcDetail() {
  const { id } = useParams<{ id: string }>();
  const nid = Number(id);
  const qc = useQueryClient();
  const { data, isLoading } = useGetFixerNpc(nid);
  const update = useUpdateFixerNpc({
    mutation: { onSuccess: () => qc.invalidateQueries({ queryKey: getGetFixerNpcQueryKey(nid) }) },
  });

  if (isLoading) return <div className="font-display text-nc-cyan animate-pulse">LOADING...</div>;
  if (!data) return <div className="font-display text-destructive">NPC NOT FOUND</div>;

  return (
    <div className="max-w-3xl mx-auto space-y-6 pb-12">
      <h1 className="text-4xl font-display" data-testid="text-npc-name">{data.name}</h1>
      <Card className="rounded-none border-border bg-card/50">
        <CardHeader><CardTitle className="font-display tracking-widest">EDIT NPC</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <Input defaultValue={data.name} onBlur={(e) => update.mutate({ id: nid, data: { name: e.target.value } })} placeholder="Name" data-testid="input-npc-name" />
          <Input defaultValue={data.archetype ?? ""} onBlur={(e) => update.mutate({ id: nid, data: { archetype: e.target.value } })} placeholder="Archetype" data-testid="input-npc-archetype" />
          <Input defaultValue={data.district ?? ""} onBlur={(e) => update.mutate({ id: nid, data: { district: e.target.value } })} placeholder="District" data-testid="input-npc-district" />
          <Input defaultValue={data.contact ?? ""} onBlur={(e) => update.mutate({ id: nid, data: { contact: e.target.value } })} placeholder="Contact handle" data-testid="input-npc-contact" />
          <Textarea defaultValue={data.description ?? ""} onBlur={(e) => update.mutate({ id: nid, data: { description: e.target.value } })} rows={5} placeholder="Description" data-testid="input-npc-description" />
        </CardContent>
      </Card>
    </div>
  );
}
