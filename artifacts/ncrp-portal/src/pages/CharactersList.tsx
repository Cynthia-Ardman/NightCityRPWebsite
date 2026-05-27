import { useState } from "react";
import { Link } from "wouter";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { useListMyCharacters, useCreateCharacter, getListMyCharactersQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Users, Plus, Shield, ShieldAlert, MoreVertical } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { useToast } from "@/hooks/use-toast";

const charSchema = z.object({
  name: z.string().min(1, "Name is required").max(64),
  kind: z.enum(["pc", "npc"]),
  archetype: z.string().optional(),
});

export default function CharactersList() {
  const { data: characters, isLoading } = useListMyCharacters();
  const createChar = useCreateCharacter();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [isDialogOpen, setIsDialogOpen] = useState(false);

  const form = useForm<z.infer<typeof charSchema>>({
    resolver: zodResolver(charSchema),
    defaultValues: {
      name: "",
      kind: "pc",
      archetype: "",
    },
  });

  const onSubmit = (values: z.infer<typeof charSchema>) => {
    createChar.mutate({ data: values }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListMyCharactersQueryKey() });
        toast({ title: "Character Created", description: "Identity registered in subnet." });
        setIsDialogOpen(false);
        form.reset();
      },
      onError: (err: any) => {
        toast({ title: "Error", description: err.message || "Failed to register identity.", variant: "destructive" });
      }
    });
  };

  return (
    <div className="space-y-8 max-w-6xl mx-auto pb-12">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-4xl font-display font-bold text-foreground" data-testid="text-characters-title">IDENTITIES</h1>
          <p className="text-muted-foreground font-mono mt-2">Manage your PCs and NPCs.</p>
        </div>

        <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
          <DialogTrigger asChild>
            <Button className="rounded-none bg-nc-cyan text-background hover:bg-nc-cyan/80 font-display font-bold tracking-widest" data-testid="button-new-character">
              <Plus className="w-4 h-4 mr-2" /> NEW_IDENTITY
            </Button>
          </DialogTrigger>
          <DialogContent className="rounded-none border-nc-cyan bg-background/95 backdrop-blur-xl sm:max-w-[425px]">
            <DialogHeader>
              <DialogTitle className="font-display text-2xl text-nc-cyan uppercase tracking-widest">Register Identity</DialogTitle>
              <DialogDescription className="font-mono text-muted-foreground">
                Enter details for your new character.
              </DialogDescription>
            </DialogHeader>
            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 font-mono">
                <FormField
                  control={form.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Name</FormLabel>
                      <FormControl>
                        <Input className="rounded-none border-border bg-card focus-visible:ring-nc-cyan" placeholder="V" {...field} data-testid="input-char-name" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="kind"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Type</FormLabel>
                      <Select onValueChange={field.onChange} defaultValue={field.value}>
                        <FormControl>
                          <SelectTrigger className="rounded-none border-border bg-card focus:ring-nc-cyan" data-testid="select-char-kind">
                            <SelectValue placeholder="Select type" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent className="rounded-none border-border bg-card">
                          <SelectItem value="pc">Player Character (PC)</SelectItem>
                          <SelectItem value="npc">Non-Player Character (NPC)</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="archetype"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Archetype (Optional)</FormLabel>
                      <FormControl>
                        <Input className="rounded-none border-border bg-card focus-visible:ring-nc-cyan" placeholder="Solo, Netrunner, Techie..." {...field} data-testid="input-char-archetype" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <Button type="submit" disabled={createChar.isPending} className="w-full rounded-none bg-nc-cyan text-background hover:bg-nc-cyan/80 font-display mt-4" data-testid="button-submit-char">
                  {createChar.isPending ? "REGISTERING..." : "REGISTER"}
                </Button>
              </form>
            </Form>
          </DialogContent>
        </Dialog>
      </div>

      {isLoading ? (
        <div className="py-20 text-center text-nc-cyan animate-pulse font-display text-xl">SCANNING_DATABASE...</div>
      ) : characters?.length === 0 ? (
        <div className="py-20 text-center border border-dashed border-border bg-card/30">
          <Users className="w-12 h-12 text-muted-foreground mx-auto mb-4 opacity-50" />
          <h3 className="text-xl font-display text-foreground mb-2">NO IDENTITIES FOUND</h3>
          <p className="text-muted-foreground font-mono text-sm">You haven't registered any characters yet.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {characters?.map(char => (
            <Link key={char.id} href={`/characters/${char.id}`}>
              <Card className="rounded-none border-border bg-card/50 hover:border-nc-cyan hover:shadow-[0_0_15px_rgba(0,255,255,0.1)] transition-all cursor-pointer group h-full flex flex-col" data-testid={`card-character-${char.id}`}>
                <CardHeader className="flex flex-row items-start gap-4 space-y-0 pb-2">
                  <Avatar className="h-16 w-16 border border-border rounded-none group-hover:border-nc-cyan transition-colors shadow-sm">
                    <AvatarImage src={char.portraitUrl || ''} className="object-cover" />
                    <AvatarFallback className="bg-background text-nc-cyan rounded-none font-display text-2xl">
                      {char.name.substring(0, 2).toUpperCase()}
                    </AvatarFallback>
                  </Avatar>
                  <div className="flex-1 min-w-0">
                    <CardTitle className="text-xl font-display group-hover:text-nc-cyan transition-colors truncate" title={char.name}>{char.name}</CardTitle>
                    <CardDescription className="font-mono text-xs uppercase mt-1">
                      <span className={char.kind === 'pc' ? 'text-nc-magenta' : 'text-nc-yellow'}>{char.kind}</span>
                      {char.archetype && ` // ${char.archetype}`}
                    </CardDescription>
                  </div>
                </CardHeader>
                <CardContent className="mt-auto pt-4 border-t border-border/50">
                  <div className="flex items-center justify-between text-xs font-mono">
                    <div className="flex items-center gap-2">
                      <span className={`w-2 h-2 rounded-full ${char.isActive ? 'bg-nc-cyan animate-pulse shadow-[0_0_5px_currentColor]' : 'bg-muted'}`} />
                      <span className={char.isActive ? 'text-foreground' : 'text-muted-foreground'}>
                        {char.isActive ? 'ACTIVE' : 'STANDBY'}
                      </span>
                    </div>
                    {char.approved ? (
                      <span className="flex items-center gap-1 text-nc-cyan">
                        <Shield className="w-3 h-3" /> APPROVED
                      </span>
                    ) : (
                      <span className="flex items-center gap-1 text-nc-yellow">
                        <ShieldAlert className="w-3 h-3" /> PENDING
                      </span>
                    )}
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
