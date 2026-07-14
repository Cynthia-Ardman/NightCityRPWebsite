import { Link } from "wouter";
import { useListRipperdocs } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Syringe } from "lucide-react";
import VenueRequestSection from "@/components/catalog/VenueRequestSection";

export default function DirectoryRipperdocs() {
  const { data, isLoading } = useListRipperdocs();
  return (
    <div className="max-w-7xl mx-auto space-y-6 pb-12">
      <div>
        <h1 className="text-4xl font-display" data-testid="text-ripperdocs-title">CLINIC DIRECTORY</h1>
        <p className="font-mono text-muted-foreground mt-2">Find a ripperdoc for your next upgrade.</p>
      </div>
      <VenueRequestSection
        type="ripperdoc"
        buttonLabel="REQUEST NEW CLINIC"
        dialogTitle="REQUEST NEW CLINIC"
        dialogDescription="Tell staff about the clinic you want to open. They'll review and create it on approval."
        nameLabel="Clinic Name"
        namePlaceholder="e.g. Vik's Clinic"
      />
      {isLoading ? <div className="text-nc-cyan font-display animate-pulse">SCANNING...</div> :
        !data?.length ? (
          <div className="py-20 text-center border border-dashed border-border bg-card/30">
            <Syringe className="w-12 h-12 text-muted-foreground mx-auto mb-4 opacity-50" />
            <h3 className="font-display text-xl">NO CLINICS REGISTERED</h3>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {data.map((r) => (
              <Link key={r.id} href={`/directory/ripperdocs/${r.id}`}>
                <Card className="rounded-none border-border bg-card/50 hover:border-nc-magenta transition-all cursor-pointer h-full overflow-hidden flex flex-col" data-testid={`card-ripperdoc-${r.id}`}>
                  {r.bannerUrl ? (
                    <div className="w-full h-32 overflow-hidden border-b border-border bg-black/30">
                      <img
                        src={r.bannerUrl}
                        alt={`${r.name} banner`}
                        className="w-full h-full object-contain"
                        loading="lazy"
                        data-testid={`img-ripperdoc-${r.id}`}
                      />
                    </div>
                  ) : (
                    <div className="w-full h-32 flex items-center justify-center border-b border-border bg-card/30" data-testid={`img-ripperdoc-fallback-${r.id}`}>
                      <Syringe className="w-10 h-10 text-muted-foreground opacity-30" />
                    </div>
                  )}
                  <CardHeader>
                    <CardTitle className="font-display text-xl">{r.name}</CardTitle>
                    <CardDescription className="font-mono text-xs">{r.location ?? "—"}</CardDescription>
                    <CardDescription className="font-mono text-xs text-nc-magenta" data-testid={`text-ripperdoc-owner-${r.id}`}>OWNER: {r.ownerName ?? "UNCLAIMED"}</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <p className="text-xs font-mono text-muted-foreground line-clamp-2">{r.purpose ?? r.description ?? ""}</p>
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
        )}
    </div>
  );
}
