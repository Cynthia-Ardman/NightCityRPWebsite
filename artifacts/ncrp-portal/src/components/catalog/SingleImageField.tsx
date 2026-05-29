import { useRef, useState } from "react";
import { ImagePlus, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { uploadImage } from "@/lib/uploadImage";

// A single-image picker used by the catalog editors (guns + housing). Holds
// one optional image path; uploading a new file replaces the existing one.
// The value is the stored object path (or "" for none); onChange reports the
// new value back to the parent form.
export default function SingleImageField({
  label = "Image",
  value,
  onChange,
  testIdPrefix,
}: {
  label?: string;
  value: string;
  onChange: (next: string) => void;
  testIdPrefix: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();
  const [uploading, setUploading] = useState(false);

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setUploading(true);
    try {
      const url = await uploadImage(file);
      onChange(url);
      toast({ title: "Image uploaded" });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Upload failed";
      toast({ title: "Upload failed", description: msg, variant: "destructive" });
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label className="text-xs font-mono uppercase tracking-widest text-muted-foreground">
          {label}
        </Label>
        <div className="flex items-center gap-2">
          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={onPick}
            data-testid={`input-upload-${testIdPrefix}`}
          />
          {value && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="rounded-none font-display text-nc-magenta"
              disabled={uploading}
              onClick={() => onChange("")}
              data-testid={`button-remove-${testIdPrefix}`}
            >
              <X className="w-3 h-3 mr-1" /> REMOVE
            </Button>
          )}
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
                <ImagePlus className="w-3 h-3 mr-1" /> {value ? "REPLACE" : "UPLOAD"}
              </>
            )}
          </Button>
        </div>
      </div>
      {value ? (
        <img
          src={value}
          alt={label}
          className="w-full max-h-56 object-contain border border-border bg-black/40"
          data-testid={`preview-${testIdPrefix}`}
        />
      ) : (
        <div className="text-muted-foreground italic text-sm">No image yet.</div>
      )}
    </div>
  );
}
