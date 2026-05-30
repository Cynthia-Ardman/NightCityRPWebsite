import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ImagePlus, Upload, X } from "lucide-react";
import { uploadImage } from "@/lib/uploadImage";
import { useToast } from "@/hooks/use-toast";

// Single-image uploader: an upload button that becomes a preview with a remove
// control once an image is set. Used by the custom-request and mission forms,
// which store a single image URL string (empty string = none).
export default function SingleImageUpload({
  value,
  onChange,
  testIdPrefix,
  alt = "image",
}: {
  value: string;
  onChange: (url: string) => void;
  testIdPrefix: string;
  alt?: string;
}) {
  const { toast } = useToast();
  const [uploading, setUploading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-uploading the same file
    if (!file) return;
    setUploading(true);
    try {
      const url = await uploadImage(file);
      onChange(url);
      toast({ title: "Upload complete" });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Upload failed";
      toast({ title: "Upload failed", description: msg, variant: "destructive" });
    } finally {
      setUploading(false);
    }
  }

  return (
    <div>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={onPick}
        data-testid={`input-upload-${testIdPrefix}`}
      />
      {value ? (
        <div className="relative inline-block border border-border bg-background p-1">
          <img src={value} alt={alt} className="h-32 w-auto max-w-full object-contain" loading="lazy" />
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="absolute top-1 right-1 h-7 w-7 text-destructive bg-background/80 hover:bg-background"
            onClick={() => onChange("")}
            data-testid={`button-remove-${testIdPrefix}`}
          >
            <X className="w-4 h-4" />
          </Button>
        </div>
      ) : (
        <Button
          type="button"
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
      )}
    </div>
  );
}
