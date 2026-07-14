import { Link } from "wouter";
import { useListMyRipperdocs } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Syringe } from "lucide-react";
import VenueRequestSection from "@/components/catalog/VenueRequestSection";

export default function MyClinics() {
  const { data, isLoading } = useListMyRipperdocs();
  return (
    <div className="max-w-7xl mx-auto space-y-6 pb-12">
      <h1 className="text-4xl font-display" data-testid="text-my-clinics-title">MY CLINICS</h1>
      <VenueRequestSection
        type="ripperdoc"
        buttonLabel="REQUEST NEW CLINIC"
        dialogTitle="REQUEST NEW CLINIC"
        dialogDescription="Tell staff about the clinic you want to open. They'll review and create it on approval."
        nameLabel="Clinic Name"
        namePlaceholder="e.g. Vik's Clinic"
      />
      {isLoading ? <div className="text-nc-cyan font-display animate-pulse">LOADING...</div> :
        !data?.length ? (
          <div className="py-20 text-center border border-dashed border-border bg-card/30">
            <Syringe className="w-12 h-12 text-muted-foreground mx-auto mb-4 opacity-50" />
            <h3 className="font-display text-xl">NO CLINICS YET</h3>
            <p className="font-mono text-sm text-muted-foreground mt-2">Use "Request New Clinic" above to apply for one. Staff will review and create it on approval.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {data.map((r) => (
              <Link key={r.id} href={`/clinics/${r.id}`}>
                <Card className="rounded-none border-border bg-card/50 hover:border-nc-magenta transition-all cursor-pointer" data-testid={`card-myclinic-${r.id}`}>
                  <CardHeader><CardTitle className="font-display">{r.name}</CardTitle></CardHeader>
                  <CardContent><span className="font-mono text-xs text-muted-foreground">{r.location ?? "—"}</span></CardContent>
                </Card>
              </Link>
            ))}
          </div>
        )}
    </div>
  );
}
