import { useGetCharacter, useGetWallet, useGetCharacterInventory, useGetCharacterStatus } from "@workspace/api-client-react";
import { useParams, Link } from "wouter";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Shield, ShieldAlert, Wallet, Package, Activity, Terminal } from "lucide-react";
import { Badge } from "@/components/ui/badge";

export default function CharacterDetail() {
  const { id } = useParams();
  const charId = Number(id);
  
  const { data: char, isLoading: charLoading } = useGetCharacter(charId);

  if (charLoading) return <div className="p-8 text-nc-cyan font-display text-xl animate-pulse">DECRYPTING_IDENTITY...</div>;
  if (!char) return <div className="p-8 text-destructive font-display text-xl">ERROR: IDENTITY_NOT_FOUND</div>;

  return (
    <div className="space-y-8 max-w-6xl mx-auto pb-12">
      <div className="flex flex-col md:flex-row gap-6 items-start md:items-end border-b border-border pb-6">
        <Avatar className="h-32 w-32 border-2 border-nc-cyan rounded-none shadow-[0_0_20px_rgba(0,255,255,0.2)] bg-card p-1">
          <AvatarImage src={char.portraitUrl || ''} className="object-cover rounded-none" />
          <AvatarFallback className="bg-background text-nc-cyan rounded-none font-display text-4xl">
            {char.name.substring(0, 2).toUpperCase()}
          </AvatarFallback>
        </Avatar>
        
        <div className="flex-1 space-y-2">
          <div className="flex items-center gap-3">
            <h1 className="text-4xl md:text-5xl font-display font-bold text-foreground" data-testid="text-char-name">{char.name}</h1>
            {char.approved ? (
              <Badge variant="outline" className="border-nc-cyan text-nc-cyan rounded-none px-2 py-1 flex items-center gap-1 font-mono text-xs">
                <Shield className="w-3 h-3" /> VERIFIED
              </Badge>
            ) : (
              <Badge variant="outline" className="border-nc-yellow text-nc-yellow rounded-none px-2 py-1 flex items-center gap-1 font-mono text-xs animate-pulse">
                <ShieldAlert className="w-3 h-3" /> PENDING_APPROVAL
              </Badge>
            )}
          </div>
          
          <div className="flex flex-wrap items-center gap-4 text-sm font-mono uppercase tracking-widest text-muted-foreground">
            <div className="flex items-center gap-2">
              <span className="text-foreground">TYPE:</span>
              <span className={char.kind === 'pc' ? 'text-nc-magenta' : 'text-nc-yellow'}>{char.kind}</span>
            </div>
            {char.archetype && (
              <div className="flex items-center gap-2">
                <span className="text-foreground">ARCHETYPE:</span>
                <span className="text-nc-cyan">{char.archetype}</span>
              </div>
            )}
            <div className="flex items-center gap-2">
              <span className="text-foreground">STATUS:</span>
              <span className="flex items-center gap-1">
                <span className={`w-2 h-2 rounded-full ${char.isActive ? 'bg-nc-cyan shadow-[0_0_5px_currentColor]' : 'bg-muted'}`} />
                {char.isActive ? 'ACTIVE' : 'STANDBY'}
              </span>
            </div>
          </div>
        </div>
      </div>

      <Tabs defaultValue="profile" className="w-full">
        <TabsList className="bg-card border border-border rounded-none p-0 h-auto flex overflow-x-auto w-full max-w-full no-scrollbar">
          <TabsTrigger value="profile" className="flex-1 rounded-none font-display uppercase tracking-widest data-[state=active]:bg-nc-cyan/10 data-[state=active]:text-nc-cyan data-[state=active]:border-b-2 data-[state=active]:border-nc-cyan py-3 min-w-[100px]" data-testid="tab-profile">
            <Terminal className="w-4 h-4 mr-2 hidden sm:inline" /> Profile
          </TabsTrigger>
          <TabsTrigger value="wallet" className="flex-1 rounded-none font-display uppercase tracking-widest data-[state=active]:bg-nc-cyan/10 data-[state=active]:text-nc-cyan data-[state=active]:border-b-2 data-[state=active]:border-nc-cyan py-3 min-w-[100px]" data-testid="tab-wallet">
            <Wallet className="w-4 h-4 mr-2 hidden sm:inline" /> Wallet
          </TabsTrigger>
          <TabsTrigger value="inventory" className="flex-1 rounded-none font-display uppercase tracking-widest data-[state=active]:bg-nc-cyan/10 data-[state=active]:text-nc-cyan data-[state=active]:border-b-2 data-[state=active]:border-nc-cyan py-3 min-w-[100px]" data-testid="tab-inv">
            <Package className="w-4 h-4 mr-2 hidden sm:inline" /> Inventory
          </TabsTrigger>
          <TabsTrigger value="status" className="flex-1 rounded-none font-display uppercase tracking-widest data-[state=active]:bg-nc-cyan/10 data-[state=active]:text-nc-cyan data-[state=active]:border-b-2 data-[state=active]:border-nc-cyan py-3 min-w-[100px]" data-testid="tab-status">
            <Activity className="w-4 h-4 mr-2 hidden sm:inline" /> Status
          </TabsTrigger>
        </TabsList>

        <div className="mt-8">
          <TabsContent value="profile" className="space-y-6 outline-none focus:ring-0">
            <Card className="rounded-none border-border bg-card/50">
              <CardHeader>
                <CardTitle className="font-display text-nc-cyan">DOSSIER</CardTitle>
              </CardHeader>
              <CardContent>
                {char.background ? (
                  <div className="prose prose-invert prose-p:font-mono max-w-none prose-headings:font-display">
                    {char.background}
                  </div>
                ) : (
                  <div className="text-muted-foreground font-mono italic">No background data recorded.</div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="wallet" className="outline-none focus:ring-0">
            <WalletTab characterId={char.id} />
          </TabsContent>

          <TabsContent value="inventory" className="outline-none focus:ring-0">
            <InventoryTab characterId={char.id} />
          </TabsContent>

          <TabsContent value="status" className="outline-none focus:ring-0">
            <StatusTab characterId={char.id} />
          </TabsContent>
        </div>
      </Tabs>
    </div>
  );
}

function WalletTab({ characterId }: { characterId: number }) {
  // We'll just show placeholders here, we'll build the real components later
  return <div className="text-nc-cyan font-mono animate-pulse">Fetching UB ledger...</div>;
}

function InventoryTab({ characterId }: { characterId: number }) {
  return <div className="text-nc-cyan font-mono animate-pulse">Scanning personal stash...</div>;
}

function StatusTab({ characterId }: { characterId: number }) {
  return <div className="text-nc-cyan font-mono animate-pulse">Pinging biometric sensors...</div>;
}
