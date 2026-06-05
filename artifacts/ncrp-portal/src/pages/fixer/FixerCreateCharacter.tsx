import { Link } from "wouter";
import { UserPlus, ArrowLeft } from "lucide-react";
import CreateCharacterCard from "@/components/CreateCharacterCard";

export default function FixerCreateCharacter() {
  return (
    <div className="max-w-5xl mx-auto space-y-6 pb-12">
      <Link
        href="/fixer"
        className="inline-flex items-center gap-1 font-mono text-xs text-muted-foreground hover:text-nc-cyan"
        data-testid="link-back-to-fixer-hub"
      >
        <ArrowLeft className="w-3 h-3" /> FIXER HUB
      </Link>
      <div>
        <h1 className="text-4xl font-display font-bold text-foreground flex items-center gap-3" data-testid="text-create-character-title">
          <UserPlus className="w-8 h-8 text-nc-cyan" /> CREATE CHARACTER
        </h1>
        <p className="font-mono text-sm text-muted-foreground mt-1">
          Hand-create a PC or NPC. It skips the sheet review queue and lands approved &amp; active.
        </p>
      </div>
      <CreateCharacterCard />
    </div>
  );
}
