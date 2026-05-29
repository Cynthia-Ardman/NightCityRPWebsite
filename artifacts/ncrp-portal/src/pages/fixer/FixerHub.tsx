import { useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListMyFixerNpcs,
  useListAllFixerNpcs,
  useCreateFixerNpc,
  getListMyFixerNpcsQueryKey,
  getListAllFixerNpcsQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Plus, Users, FileText, Search, Briefcase, BarChart3 } from "lucide-react";

export default function FixerHub() {
  const qc = useQueryClient();
  const { data: mine } = useListMyFixerNpcs();
  const { data: all } = useListAllFixerNpcs();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [archetype, setArchetype] = useState("");
  const [district, setDistrict] = useState("");
  const [description, setDescription] = useState("");
  const create = useCreateFixerNpc({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getListMyFixerNpcsQueryKey() });
        qc.invalidateQueries({ queryKey: getListAllFixerNpcsQueryKey() });
        setOpen(false);
        setName(""); setArchetype(""); setDistrict(""); setDescription("");
      },
    },
  });

  return (
    <div className="max-w-6xl mx-auto space-y-6 pb-12">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h1 className="text-4xl font-display" data-testid="text-fixer-title">FIXER HUB</h1>
        <div className="flex flex-wrap gap-2">
          <Link href="/directory/characters" className="px-3 py-2 border border-nc-cyan text-nc-cyan hover:bg-nc-cyan hover:text-background font-display text-xs tracking-widest inline-flex items-center gap-2" data-testid="link-fixer-archive"><FileText className="w-3 h-3" /> CHARACTER ARCHIVE</Link>
          <Link href="/fixer/missions" className="px-3 py-2 border border-nc-magenta text-nc-magenta hover:bg-nc-magenta hover:text-background font-display text-xs tracking-widest inline-flex items-center gap-2" data-testid="link-fixer-missions"><Briefcase className="w-3 h-3" /> MISSION LOG</Link>
          <Link href="/fixer/reports" className="px-3 py-2 border border-nc-cyan text-nc-cyan hover:bg-nc-cyan hover:text-background font-display text-xs tracking-widest inline-flex items-center gap-2" data-testid="link-fixer-reports"><BarChart3 className="w-3 h-3" /> MISSION REPORTS</Link>
          <Link href="/fixer/items" className="px-3 py-2 border border-nc-yellow text-nc-yellow hover:bg-nc-yellow hover:text-background font-display text-xs tracking-widest inline-flex items-center gap-2" data-testid="link-fixer-items"><Search className="w-3 h-3" /> INVENTORY SEARCH</Link>
        </div>
      </div>
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-display text-muted-foreground tracking-widest">FIXER NPCS</h2>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button className="rounded-none bg-nc-cyan text-background hover:bg-nc-cyan/80 font-display" data-testid="button-new-npc"><Plus className="w-4 h-4 mr-2" /> NEW NPC</Button>
          </DialogTrigger>
          <DialogContent className="rounded-none border-nc-cyan bg-card">
            <DialogHeader><DialogTitle className="font-display tracking-widest">CREATE NPC</DialogTitle></DialogHeader>
            <div className="space-y-3">
              <Input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} data-testid="input-npc-name" />
              <Input placeholder="Archetype (e.g. Mercenary)" value={archetype} onChange={(e) => setArchetype(e.target.value)} data-testid="input-npc-archetype" />
              <Input placeholder="District" value={district} onChange={(e) => setDistrict(e.target.value)} data-testid="input-npc-district" />
              <Textarea placeholder="Description" value={description} onChange={(e) => setDescription(e.target.value)} data-testid="input-npc-description" />
              <Button disabled={!name || create.isPending} onClick={() => create.mutate({ data: { name, archetype, district, description } })} className="w-full rounded-none bg-nc-cyan text-background font-display" data-testid="button-create-npc">CREATE</Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      <Tabs defaultValue="mine">
        <TabsList className="rounded-none border border-border bg-transparent">
          <TabsTrigger value="mine" className="rounded-none font-display" data-testid="tab-mine">MY NPCS</TabsTrigger>
          <TabsTrigger value="all" className="rounded-none font-display" data-testid="tab-all">ALL NPCS</TabsTrigger>
        </TabsList>
        <TabsContent value="mine"><NpcGrid items={mine ?? []} kind="mine" /></TabsContent>
        <TabsContent value="all"><NpcGrid items={all ?? []} kind="all" /></TabsContent>
      </Tabs>
    </div>
  );
}

function NpcGrid({ items, kind }: { items: Array<{ id: number; name: string; archetype?: string | null; district?: string | null; fixerName?: string | null }>; kind: string }) {
  if (!items.length) return (
    <div className="py-20 text-center border border-dashed border-border bg-card/30 mt-4">
      <Users className="w-12 h-12 text-muted-foreground mx-auto mb-4 opacity-50" />
      <h3 className="font-display text-xl">NO NPCS</h3>
    </div>
  );
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mt-4">
      {items.map((n) => (
        <Link key={n.id} href={`/fixer/npcs/${n.id}`}>
          <Card className="rounded-none border-border bg-card/50 hover:border-nc-cyan cursor-pointer h-full" data-testid={`card-npc-${kind}-${n.id}`}>
            <CardHeader>
              <CardTitle className="font-display">{n.name}</CardTitle>
              <CardDescription className="font-mono text-xs">{n.archetype ?? "—"} · {n.district ?? "—"}</CardDescription>
            </CardHeader>
            {n.fixerName && <CardContent className="text-xs font-mono text-muted-foreground">handler: {n.fixerName}</CardContent>}
          </Card>
        </Link>
      ))}
    </div>
  );
}
