import {
  ArrowRight,
  CalendarDays,
  Store,
  MonitorPlay,
  ShieldCheck,
  Cpu,
  AlertTriangle,
  FileText,
  Network
} from "lucide-react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import ncrpBanner from "@assets/NCRP_GroupBanner_1780331827566.png";

function DiscordIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M20.317 4.369a19.79 19.79 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.249a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.036A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.1 13.1 0 0 1-1.872-.892.077.077 0 0 1-.008-.128c.126-.094.252-.192.372-.291a.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.061 0a.074.074 0 0 1 .078.009c.12.099.246.198.373.292a.077.077 0 0 1-.006.127 12.3 12.3 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.84 19.84 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.331c-1.182 0-2.157-1.085-2.157-2.419 0-1.333.956-2.418 2.157-2.418 1.21 0 2.176 1.094 2.157 2.418 0 1.334-.956 2.419-2.157 2.419zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.418 2.157-2.418 1.21 0 2.176 1.094 2.157 2.418 0 1.334-.946 2.419-2.157 2.419z" />
    </svg>
  );
}

function VRChatIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 6.4 24 11.4" fill="currentColor" className={className} aria-label="VRChat" role="img">
      <path d="M22.732 6.767H1.268A1.27 1.27 0 0 0 0 8.035v5.296c0 .7.57 1.268 1.268 1.268h18.594l1.725 2.22c.215.275.443.415.68.415.153 0 .296-.06.403-.167.128-.129.193-.308.193-.536l-.002-1.939A1.27 1.27 0 0 0 24 13.331V8.035c0-.7-.569-1.269-1.268-1.269Zm.8 6.564a.8.8 0 0 1-.8.801h-.34v.031l.004 2.371c0 .155-.05.233-.129.233s-.19-.079-.31-.235l-1.866-2.4H1.268a.8.8 0 0 1-.8-.8V8.064a.8.8 0 0 1 .8-.8h21.464a.8.8 0 0 1 .8.8v5.266ZM4.444 8.573c-.127 0-.225.041-.254.15l-.877 3.129-.883-3.128c-.03-.11-.127-.15-.254-.15-.202 0-.473.126-.473.311 0 .012.005.035.011.058l1.114 3.63c.058.173.265.254.485.254s.433-.08.484-.254l1.109-3.63c.005-.023.011-.04.011-.058 0-.179-.27-.312-.473-.312Zm2.925 2.36c.433-.132.757-.49.757-1.153 0-.918-.612-1.207-1.368-1.207H5.614a.234.234 0 0 0-.242.231v3.752c0 .156.184.237.374.237s.376-.081.376-.237V11.05h.484l.82 1.593c.058.115.156.179.26.179.219 0 .467-.203.467-.393a.155.155 0 0 0-.028-.092l-.756-1.403Zm-.61-.473h-.636V9.231h.635c.375 0 .618.162.618.618s-.242.612-.618.612Zm10.056.826h1.004l-.502-1.772-.502 1.772Zm4.684-3.095H9.366a.8.8 0 0 0-.8.8v3.383a.8.8 0 0 0 .8.8h12.132a.8.8 0 0 0 .8-.8V8.992a.8.8 0 0 0-.8-.801Zm-10.946 3.977c.525 0 .571-.374.589-.617.011-.179.173-.236.369-.236.26 0 .38.075.38.369 0 .698-.57 1.142-1.379 1.142-.727 0-1.327-.357-1.327-1.322v-1.61c0-.963.606-1.322 1.333-1.322.802 0 1.374.427 1.374 1.097 0 .3-.121.37-.375.37-.214 0-.37-.064-.375-.238-.012-.178-.052-.57-.6-.57-.387 0-.606.213-.606.663v1.61c0 .45.219.664.617.664Zm4.703.388c0 .156-.19.237-.375.237s-.375-.081-.375-.237V10.9h-1.299v1.656c0 .156-.19.237-.375.237s-.375-.081-.375-.237V8.804c0-.161.185-.23.375-.23s.375.069.375.23v1.507h1.299V8.804c0-.161.185-.23.375-.23s.375.069.375.23v3.752Zm3.198.236c-.127 0-.225-.04-.254-.15l-.22-.768h-1.322l-.219.768c-.029.11-.127.15-.254.15-.202 0-.473-.127-.473-.311 0-.012.006-.035.012-.058l1.114-3.63c.051-.173.265-.254.478-.254s.433.08.485.254l1.114 3.63c.006.023.012.04.012.058 0 .179-.272.311-.473.311Zm2.989-3.543h-.843v3.306c0 .156-.19.237-.375.237s-.375-.081-.375-.237V9.25h-.848c-.15 0-.237-.157-.237-.34 0-.162.075-.336.237-.336h2.44c.162 0 .238.173.238.335 0 .18-.087.34-.237.34Z" />
    </svg>
  );
}

export default function StartHere() {
  return (
    <div className="min-h-[100dvh] pb-24">
      {/* Hero Section */}
      <section className="relative overflow-hidden mb-24 flex flex-col items-center justify-center min-h-[70vh] border-b border-nc-cyan/20">
        <div className="absolute inset-0 bg-background/80 z-0" />
        {/* Animated background glow */}
        <div className="absolute inset-0 z-0 bg-[radial-gradient(ellipse_at_center,rgba(0,255,255,0.08)_0%,transparent_60%)] pointer-events-none" />
        
        <div className="relative z-10 max-w-5xl w-full text-center space-y-10 p-6 pt-12 pb-16">
          <img
            src={ncrpBanner}
            alt="Night City RP"
            className="w-full max-w-3xl mx-auto border border-nc-cyan/30 shadow-[0_0_40px_rgba(0,255,255,0.15)]"
            data-testid="img-hero-banner"
          />
          <div className="space-y-4">
            <h1 className="text-6xl md:text-8xl font-display font-bold text-nc-cyan glitch-hover tracking-tighter" data-testid="text-hero-title">
              NIGHT CITY RP
            </h1>
            <p className="text-xl md:text-2xl text-foreground font-mono" data-testid="text-hero-subtitle">
              The premier <span className="text-nc-magenta font-bold">18+ Cyberpunk roleplay</span> experience in VRChat.
            </p>
          </div>
          
          <div className="pt-6 flex flex-col sm:flex-row items-center justify-center gap-4">
            <Button asChild size="lg" className="h-16 px-10 text-lg font-display bg-nc-magenta hover:bg-nc-magenta/80 text-foreground rounded-none shadow-[0_0_20px_rgba(255,0,255,0.4)] transition-all hover:shadow-[0_0_40px_rgba(255,0,255,0.6)]" data-testid="button-login-hero">
              <a href="/api/auth/discord/login">
                CONNECT TO SUBNET <ArrowRight className="ml-3 h-6 w-6" />
              </a>
            </Button>
            <Button asChild size="lg" variant="outline" className="h-16 px-10 text-lg font-display border-nc-cyan text-nc-cyan hover:bg-nc-cyan/10 rounded-none shadow-[0_0_20px_rgba(0,255,255,0.1)] transition-all hover:shadow-[0_0_30px_rgba(0,255,255,0.3)]">
              <a href="https://discord.gg/ncrp" target="_blank" rel="noreferrer" data-testid="link-hero-discord">
                JOIN DISCORD <DiscordIcon className="ml-3 h-6 w-6" />
              </a>
            </Button>
          </div>
        </div>
      </section>

      <div className="max-w-7xl mx-auto px-4 md:px-8 space-y-32">
        {/* What is NCRP */}
        <section>
          <div className="text-center mb-16 space-y-4">
            <h2 className="text-3xl md:text-5xl font-display font-bold text-foreground">
              SYS_INFO: <span className="text-nc-cyan">WHAT IS NCRP?</span>
            </h2>
            <p className="text-muted-foreground font-mono max-w-2xl mx-auto">
              We are a dedicated roleplay community bringing the neon-soaked streets of Night City to life. Organized via Discord, played in VRChat, and managed right here on the Subnet.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
            <Card className="rounded-none border-border bg-card/40 hover:border-nc-cyan/50 transition-colors group">
              <CardHeader>
                <MonitorPlay className="h-10 w-10 text-nc-cyan mb-4 group-hover:text-nc-magenta transition-colors" />
                <CardTitle className="font-display tracking-widest text-lg">18+ VRCHAT RP</CardTitle>
              </CardHeader>
              <CardContent className="font-mono text-sm text-muted-foreground">
                Immersive, mature roleplay in a custom VRChat world. Create your character, build your reputation, and survive the streets.
              </CardContent>
            </Card>

            <Card className="rounded-none border-border bg-card/40 hover:border-nc-yellow/50 transition-colors group">
              <CardHeader>
                <CalendarDays className="h-10 w-10 text-nc-yellow mb-4 group-hover:text-nc-cyan transition-colors" />
                <CardTitle className="font-display tracking-widest text-lg">SUNDAY SESSIONS</CardTitle>
              </CardHeader>
              <CardContent className="font-mono text-sm text-muted-foreground">
                Our main structured sessions run every Sunday afternoon/evening (Pacific Time), packed with ongoing missions and events.
              </CardContent>
            </Card>

            <Card className="rounded-none border-border bg-card/40 hover:border-nc-magenta/50 transition-colors group">
              <CardHeader>
                <Store className="h-10 w-10 text-nc-magenta mb-4 group-hover:text-nc-yellow transition-colors" />
                <CardTitle className="font-display tracking-widest text-lg">LIVING ECONOMY</CardTitle>
              </CardHeader>
              <CardContent className="font-mono text-sm text-muted-foreground">
                A persistent, player-driven economy. Run your own storefront, operate a clinic, and hustle for your eddies.
              </CardContent>
            </Card>

            <Card className="rounded-none border-border bg-card/40 hover:border-nc-green/50 transition-colors group">
              <CardHeader>
                <Network className="h-10 w-10 text-nc-green mb-4 group-hover:text-nc-cyan transition-colors" />
                <CardTitle className="font-display tracking-widest text-lg">SUBNET PORTAL</CardTitle>
              </CardHeader>
              <CardContent className="font-mono text-sm text-muted-foreground">
                This website is your operational hub. Manage your character sheet, track your finances, and coordinate missions in real-time.
              </CardContent>
            </Card>
          </div>
        </section>

        {/* How to Join */}
        <section className="max-w-4xl mx-auto">
          <div className="text-center mb-16 space-y-4">
            <h2 className="text-3xl md:text-5xl font-display font-bold text-foreground">
              INITIALIZATION_SEQUENCE
            </h2>
            <p className="text-nc-magenta font-mono uppercase tracking-widest">
              How to get your chrome on the streets
            </p>
          </div>

          <div className="relative border-l border-nc-cyan/30 ml-4 md:ml-8 space-y-12 pb-8">
            {/* Step 1 */}
            <div className="relative pl-8 md:pl-12">
              <div className="absolute -left-[17px] top-1 h-8 w-8 bg-background border-2 border-nc-cyan rounded-none flex items-center justify-center font-display text-xs text-nc-cyan font-bold shadow-[0_0_10px_rgba(0,255,255,0.5)]">
                01
              </div>
              <h3 className="text-2xl font-display font-bold text-foreground mb-2">JOIN THE DISCORD</h3>
              <p className="font-mono text-sm text-muted-foreground mb-4">
                Our Discord server is the central nervous system of Night City RP. It's where all out-of-character coordination, announcements, and support happen.
              </p>
              <Button asChild variant="outline" className="border-nc-cyan text-nc-cyan hover:bg-nc-cyan/10 rounded-none">
                <a href="https://discord.gg/ncrp" target="_blank" rel="noreferrer" data-testid="link-start-discord">
                  <DiscordIcon className="mr-2 h-4 w-4" /> DISCORD.GG/NCRP
                </a>
              </Button>
            </div>

            {/* Step 2 */}
            <div className="relative pl-8 md:pl-12">
              <div className="absolute -left-[17px] top-1 h-8 w-8 bg-background border-2 border-border group-hover:border-nc-cyan rounded-none flex items-center justify-center font-display text-xs text-muted-foreground font-bold">
                02
              </div>
              <h3 className="text-2xl font-display font-bold text-foreground mb-2">AGE VERIFICATION</h3>
              <p className="font-mono text-sm text-muted-foreground">
                We are strictly 18+. Follow the instructions in Discord to get age-verified securely, then read and react to the rules post to unlock your roleplay access.
              </p>
            </div>

            {/* Step 3 */}
            <div className="relative pl-8 md:pl-12">
              <div className="absolute -left-[17px] top-1 h-8 w-8 bg-background border-2 border-nc-magenta rounded-none flex items-center justify-center font-display text-xs text-nc-magenta font-bold shadow-[0_0_10px_rgba(255,0,255,0.3)]">
                03
              </div>
              <h3 className="text-2xl font-display font-bold text-foreground mb-2">LINK SYSTEMS & VRCHAT</h3>
              <p className="font-mono text-sm text-muted-foreground mb-4">
                Link your VRChat and Discord accounts to sync your identity across platforms, and officially join our VRChat Group.
              </p>
              <Button asChild variant="outline" className="border-nc-magenta text-nc-magenta hover:bg-nc-magenta/10 rounded-none">
                <a href="https://vrchat.com/home/group/grp_667e7e40-7ea9-4142-a81e-5939c18c990f" target="_blank" rel="noreferrer" data-testid="link-start-vrchat">
                  <VRChatIcon className="mr-2 h-4 w-4" /> JOIN VRCHAT GROUP
                </a>
              </Button>
            </div>

            {/* Step 4 */}
            <div className="relative pl-8 md:pl-12">
              <div className="absolute -left-[17px] top-1 h-8 w-8 bg-background border-2 border-nc-cyan rounded-none flex items-center justify-center font-display text-xs text-nc-cyan font-bold shadow-[0_0_10px_rgba(0,255,255,0.5)]">
                04
              </div>
              <h3 className="text-2xl font-display font-bold text-foreground mb-2">PORTAL REGISTRATION</h3>
              <p className="font-mono text-sm text-muted-foreground mb-4">
                Log into this very portal using your Discord account. Here you'll submit your character sheet for staff approval before you can play.
              </p>
              <Button asChild className="bg-nc-cyan text-background hover:bg-nc-cyan/80 rounded-none font-display">
                <a href="/api/auth/discord/login" data-testid="button-start-login">
                  <Cpu className="mr-2 h-4 w-4" /> LOG INTO PORTAL
                </a>
              </Button>
            </div>

            {/* Step 5 */}
            <div className="relative pl-8 md:pl-12">
              <div className="absolute -left-[17px] top-1 h-8 w-8 bg-background border-2 border-nc-yellow rounded-none flex items-center justify-center font-display text-xs text-nc-yellow font-bold shadow-[0_0_10px_rgba(255,255,0,0.3)]">
                05
              </div>
              <h3 className="text-2xl font-display font-bold text-nc-yellow mb-2 glitch-hover">JACK IN</h3>
              <p className="font-mono text-sm text-muted-foreground">
                Once your character is approved, you're ready. Show up to a Sunday session, hit the neon streets, and start making a name for yourself.
              </p>
            </div>
          </div>
        </section>

        {/* Rules Summary */}
        <section>
          <div className="border border-destructive/30 bg-destructive/5 p-8 md:p-12 relative overflow-hidden">
            <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-destructive/80 to-transparent" />
            <div className="absolute -right-10 -top-10 text-destructive/5 rotate-12 pointer-events-none">
              <ShieldCheck className="w-64 h-64" />
            </div>
            
            <div className="relative z-10">
              <h2 className="text-3xl font-display font-bold text-destructive mb-8 flex items-center gap-3">
                <AlertTriangle className="h-8 w-8" />
                RULES OF THE STREETS
              </h2>
              
              <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
                <div className="space-y-3">
                  <h3 className="text-lg font-display text-foreground border-b border-destructive/20 pb-2">ROLEPLAY CONDUCT</h3>
                  <ul className="space-y-2 font-mono text-xs text-muted-foreground list-disc pl-4 marker:text-destructive">
                    <li>Strictly <strong className="text-foreground">18+ only</strong>.</li>
                    <li><strong className="text-foreground">Consent is mandatory</strong> for all RP interactions.</li>
                    <li>Zero tolerance for bigotry, hate speech, or discrimination.</li>
                    <li>Adult themes may appear in roleplay.</li>
                    <li>No exchanging real money for in-game currency (eddies).</li>
                  </ul>
                </div>

                <div className="space-y-3">
                  <h3 className="text-lg font-display text-foreground border-b border-destructive/20 pb-2">SERVER & SAFETY</h3>
                  <ul className="space-y-2 font-mono text-xs text-muted-foreground list-disc pl-4 marker:text-destructive">
                    <li>Discord ToS and VRChat Community Guidelines are hard lines.</li>
                    <li>Prohibited content is removed and actioned immediately.</li>
                  </ul>
                </div>

                <div className="space-y-3">
                  <h3 className="text-lg font-display text-foreground border-b border-destructive/20 pb-2">AVATAR CAPS</h3>
                  <ul className="space-y-2 font-mono text-xs text-muted-foreground list-disc pl-4 marker:text-destructive">
                    <li>Performance caps apply to <strong className="text-foreground">every avatar</strong>.</li>
                    <li>Strict limits on file size, polycount, materials, particles, and audio.</li>
                    <li>Ensures smooth sessions for everyone in the instance.</li>
                  </ul>
                </div>
              </div>

              <div className="mt-8 pt-6 border-t border-destructive/20 font-mono text-sm text-destructive/80 flex items-center gap-2 flex-wrap">
                <FileText className="h-4 w-4 shrink-0" />
                <span>
                  Read the complete rules now — no login needed:{" "}
                  <Link href="/guidebook/rules" className="text-nc-cyan underline hover:text-nc-cyan/80" data-testid="link-start-rules">
                    Rules at a Glance
                  </Link>
                </span>
              </div>
            </div>
          </div>
        </section>

        {/* Final CTA */}
        <section className="text-center pb-16">
          <h2 className="text-3xl md:text-4xl font-display font-bold text-foreground mb-8">READY TO JACK IN?</h2>
          <div className="flex flex-col sm:flex-row justify-center items-stretch gap-4 max-w-3xl mx-auto">
            <Button asChild size="lg" className="h-14 font-display bg-nc-cyan hover:bg-nc-cyan/80 text-background rounded-none shadow-[0_0_15px_rgba(0,255,255,0.3)]">
              <a href="https://discord.gg/ncrp" target="_blank" rel="noreferrer">
                <DiscordIcon className="mr-2 h-5 w-5" /> JOIN DISCORD
              </a>
            </Button>
            <Button asChild size="lg" variant="outline" className="h-14 font-display border-nc-magenta text-nc-magenta hover:bg-nc-magenta/10 rounded-none shadow-[0_0_15px_rgba(255,0,255,0.1)]">
              <a href="https://vrchat.com/home/group/grp_667e7e40-7ea9-4142-a81e-5939c18c990f" target="_blank" rel="noreferrer">
                <VRChatIcon className="mr-2 h-5 w-5" /> VRCHAT GROUP
              </a>
            </Button>
            <Button asChild size="lg" variant="outline" className="h-14 font-display border-border text-foreground hover:bg-card/50 rounded-none">
              <a href="/api/auth/discord/login">
                <Cpu className="mr-2 h-5 w-5" /> PORTAL LOGIN
              </a>
            </Button>
          </div>
        </section>
      </div>
    </div>
  );
}
