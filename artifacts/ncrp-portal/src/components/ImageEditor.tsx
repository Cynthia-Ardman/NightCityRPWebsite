import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Upload, Star, X, ImagePlus } from "lucide-react";
import { uploadImage } from "@/lib/uploadImage";
import { useToast } from "@/hooks/use-toast";

// Multi-image uploader with an optional "set profile" affordance. Shared by the
// character editor and the new-character sheet form.
export default function ImageEditor({
  title,
  urls,
  onChange,
  profileUrl,
  onSetProfile,
  allowProfile,
  testIdPrefix,
}: {
  title: string;
  urls: string[];
  onChange: (next: string[]) => void;
  profileUrl?: string | null;
  onSetProfile?: (url: string) => void;
  allowProfile?: boolean;
  testIdPrefix: string;
}) {
  const { toast } = useToast();
  const [uploading, setUploading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = ""; // allow re-uploading the same file
    if (files.length === 0) return;
    setUploading(true);
    const added: string[] = [];
    try {
      for (const f of files) {
        const url = await uploadImage(f);
        added.push(url);
      }
      onChange([...urls, ...added]);
      // If this is the portraits list and no profile is set yet, default the
      // first newly-uploaded portrait as the profile image — saves a click.
      if (allowProfile && onSetProfile && !profileUrl && added.length > 0) {
        onSetProfile(added[0]);
      }
      toast({ title: "Upload complete", description: `${added.length} image(s) added.` });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Upload failed";
      toast({ title: "Upload failed", description: msg, variant: "destructive" });
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between border-b border-border pb-2">
        <Label className="text-xs tracking-widest text-nc-cyan">{title}</Label>
        <div className="flex items-center gap-2">
          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={onPick}
            data-testid={`input-upload-${testIdPrefix}`}
          />
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="rounded-none font-display"
            disabled={uploading}
            onClick={() => inputRef.current?.click()}
            data-testid={`button-upload-${testIdPrefix}`}
          >
            {uploading ? (
              <>
                <Upload className="w-3 h-3 mr-1 animate-pulse" /> UPLOADING...
              </>
            ) : (
              <>
                <ImagePlus className="w-3 h-3 mr-1" /> UPLOAD IMAGE
              </>
            )}
          </Button>
        </div>
      </div>
      {urls.length === 0 ? (
        <div className="text-muted-foreground italic">No images yet.</div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          {urls.map((u, i) => {
            const isProfile = allowProfile && profileUrl === u;
            return (
              <div
                key={`${u}-${i}`}
                className={`relative border ${isProfile ? "border-nc-cyan shadow-[0_0_10px_rgba(0,255,255,0.3)]" : "border-border"} bg-background p-1`}
                data-testid={`img-card-${testIdPrefix}-${i}`}
              >
                <img src={u} alt={`${title} ${i + 1}`} className="w-full h-32 object-contain" loading="lazy" />
                <div className="flex justify-between items-center mt-1 gap-1">
                  {allowProfile && onSetProfile ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className={`h-7 px-2 text-xs ${isProfile ? "text-nc-cyan" : "text-muted-foreground hover:text-nc-cyan"}`}
                      onClick={() => onSetProfile(u)}
                      disabled={isProfile}
                      data-testid={`button-set-profile-${i}`}
                    >
                      <Star className={`w-3 h-3 mr-1 ${isProfile ? "fill-nc-cyan" : ""}`} />
                      {isProfile ? "PROFILE" : "SET PROFILE"}
                    </Button>
                  ) : (
                    <span />
                  )}
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="text-destructive h-7 w-7"
                    onClick={() => {
                      onChange(urls.filter((_, idx) => idx !== i));
                      if (allowProfile && onSetProfile && profileUrl === u) onSetProfile("");
                    }}
                    data-testid={`button-remove-img-${testIdPrefix}-${i}`}
                  >
                    <X className="w-4 h-4" />
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
