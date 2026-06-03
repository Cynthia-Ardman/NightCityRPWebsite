// Deep-links into the Guidebook browse page (/guidebook), keyed by the fixed
// section keys defined server-side in GUIDEBOOK_SECTIONS. The browse page
// renders each section with an `id` matching its key and scrolls to the hash on
// load, so `/guidebook#<key>` lands the reader on the right section.
export type GuidebookLink = { key: string; label: string };

export function guidebookSectionHref(key: string): string {
  return `/guidebook#${key}`;
}

// First-run onboarding banner: the most important sections for a brand-new
// player to read. "Rules & Restrictions" covers both the RP rules and the
// avatar restrictions.
export const ONBOARDING_BANNER_LINKS: GuidebookLink[] = [
  { key: "getting_started", label: "Getting Started" },
  { key: "faq", label: "FAQ" },
  { key: "character_creation", label: "Character Creation Help" },
  { key: "rules", label: "Rules & Restrictions" },
  { key: "setup", label: "Link VRChat & Discord" },
];

// Character-creation page help area: references a player needs while building a
// character, including the systems/CWP rules.
export const CHARACTER_CREATION_LINKS: GuidebookLink[] = [
  { key: "getting_started", label: "Getting Started" },
  { key: "character_creation", label: "Character Creation Help" },
  { key: "faq", label: "FAQ" },
  { key: "rules", label: "Rules & Restrictions" },
  { key: "systems", label: "Systems & CWP" },
  { key: "setup", label: "Link VRChat & Discord" },
];
