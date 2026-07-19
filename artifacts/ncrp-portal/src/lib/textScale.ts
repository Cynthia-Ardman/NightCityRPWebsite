// User-selectable global text size. The chosen scale is stored in
// localStorage (per browser) and applied as a class on <html>, which scales
// the root font size — and therefore every rem-based Tailwind size in the
// app. An inline script in index.html applies the stored class before first
// paint so there's no flash; this module is the runtime API for the
// Settings page.

export type TextScale = "default" | "lg" | "xl";

export const TEXT_SCALE_STORAGE_KEY = "ncrp-text-scale";

export const TEXT_SCALE_OPTIONS: { value: TextScale; label: string; description: string }[] = [
  { value: "default", label: "Default", description: "Standard terminal sizing." },
  { value: "lg", label: "Large", description: "About 10% bigger everywhere." },
  { value: "xl", label: "Extra Large", description: "About 20% bigger everywhere." },
];

const CLASS_BY_SCALE: Record<TextScale, string | null> = {
  default: null,
  lg: "text-scale-lg",
  xl: "text-scale-xl",
};

export function getTextScale(): TextScale {
  try {
    const v = localStorage.getItem(TEXT_SCALE_STORAGE_KEY);
    if (v === "lg" || v === "xl") return v;
  } catch {
    // localStorage unavailable (private mode etc.) — fall back to default.
  }
  return "default";
}

export function applyTextScale(scale: TextScale): void {
  const root = document.documentElement;
  root.classList.remove("text-scale-lg", "text-scale-xl");
  const cls = CLASS_BY_SCALE[scale];
  if (cls) root.classList.add(cls);
}

export function setTextScale(scale: TextScale): void {
  try {
    if (scale === "default") localStorage.removeItem(TEXT_SCALE_STORAGE_KEY);
    else localStorage.setItem(TEXT_SCALE_STORAGE_KEY, scale);
  } catch {
    // Persisting failed; still apply for this session.
  }
  applyTextScale(scale);
}
