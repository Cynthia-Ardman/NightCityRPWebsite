import { useCallback, useEffect } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

// Shared in-app image viewer. Instead of bouncing to a new browser tab, any
// clickable image opens this near-fullscreen dialog; when the surface has
// several images (a ticket's reference images, a character's portraits, a
// sheet's stat screenshots) the arrows / arrow keys page through all of them.

export type LightboxState = { images: string[]; index: number } | null;

export function ImageLightbox({
  state,
  onChange,
  title = "Image",
}: {
  state: LightboxState;
  onChange: (next: LightboxState) => void;
  title?: string;
}) {
  const count = state?.images.length ?? 0;
  const index = state ? Math.min(Math.max(state.index, 0), Math.max(count - 1, 0)) : 0;

  const step = useCallback(
    (delta: number) => {
      if (!state || count < 2) return;
      onChange({ ...state, index: (index + delta + count) % count });
    },
    [state, count, index, onChange],
  );

  useEffect(() => {
    if (!state || count < 2) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        step(-1);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        step(1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state, count, step]);

  return (
    <Dialog open={!!state} onOpenChange={(o) => { if (!o) onChange(null); }}>
      <DialogContent
        className="w-[calc(100vw-2rem)] max-w-none sm:max-w-none rounded-none border-border bg-background p-2 sm:p-3"
        data-testid="dialog-image-lightbox"
      >
        <DialogTitle className="sr-only">{title}</DialogTitle>
        <DialogDescription className="sr-only">
          Full-size image viewer. Use the left and right arrows to move between images.
        </DialogDescription>
        {state ? (
          <div className="relative flex min-h-[40vh] items-center justify-center">
            <img
              src={state.images[index]}
              alt={count > 1 ? `${title} ${index + 1} of ${count}` : title}
              className="max-h-[85vh] w-auto max-w-full object-contain"
              data-testid="img-lightbox-current"
            />
            {count > 1 && (
              <>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={() => step(-1)}
                  className="absolute left-1 top-1/2 -translate-y-1/2 rounded-none border-border bg-background/85 hover:border-nc-cyan"
                  aria-label="Previous image"
                  data-testid="button-lightbox-prev"
                >
                  <ChevronLeft className="h-5 w-5" />
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={() => step(1)}
                  className="absolute right-1 top-1/2 -translate-y-1/2 rounded-none border-border bg-background/85 hover:border-nc-cyan"
                  aria-label="Next image"
                  data-testid="button-lightbox-next"
                >
                  <ChevronRight className="h-5 w-5" />
                </Button>
                <div
                  className="absolute bottom-1 left-1/2 -translate-x-1/2 border border-border bg-background/85 px-2 py-0.5 font-mono text-xs text-muted-foreground"
                  data-testid="text-lightbox-counter"
                >
                  {index + 1} / {count}
                </div>
              </>
            )}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
