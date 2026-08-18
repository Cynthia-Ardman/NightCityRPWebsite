import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ImagePlus, Upload, X } from "lucide-react";
import { uploadImage } from "@/lib/uploadImage";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/apiError";

// Multi-image uploader: thumbnails of every uploaded image, each with its own
// remove control, plus an "add image" button while under the cap. Used by the
// custom-request forms, which store an ordered string[] of image URLs.
export const MAX_REQUEST_IMAGES = 8;

export default function MultiImageUpload({
  value,
  onChange,
  testIdPrefix,
  alt = "image",
  max = MAX_REQUEST_IMAGES,
}: {
  value: string[];
  onChange: (urls: string[]) => void;
  testIdPrefix: string;
  alt?: string;
  max?: number;
}) {
  const { toast } = useToast();
  const [uploading, setUploading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = ""; // allow re-uploading the same file
    if (files.length === 0) return;
    const room = max - value.length;
    if (room <= 0) return;
    const toUpload = files.slice(0, room);
    setUploading(true);
    try {
      const urls: string[] = [];
      for (const file of toUpload) {
        urls.push(await uploadImage(file));
      }
      onChange([...value, ...urls.filter((u) => !value.includes(u))]);
      toast({ title: urls.length > 1 ? `${urls.length} uploads complete` : "Upload complete" });
    } catch (err: unknown) {
      toast({ title: "Upload failed", description: apiErrorMessage(err, "Upload failed"), variant: "destructive" });
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="space-y-2">
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={onPick}
        data-testid={`input-upload-${testIdPrefix}`}
      />
      {value.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {value.map((url, i) => (
            <div key={url} className="relative inline-block border border-border bg-background p-1">
              <img src={url} alt={`${alt} ${i + 1}`} className="h-24 w-auto max-w-full object-contain" loading="lazy" />
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="absolute top-1 right-1 h-6 w-6 text-destructive bg-background/80 hover:bg-background"
                onClick={() => onChange(value.filter((u) => u !== url))}
                data-testid={`button-remove-${testIdPrefix}-${i}`}
              >
                <X className="w-4 h-4" />
              </Button>
            </div>
          ))}
        </div>
      )}
      {value.length < max && (
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
              <ImagePlus className="w-3 h-3 mr-1" /> {value.length > 0 ? "ADD IMAGE" : "UPLOAD IMAGE"}
            </>
          )}
        </Button>
      )}
    </div>
  );
}
