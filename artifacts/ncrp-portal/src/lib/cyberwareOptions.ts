// Canonical cyberware body-system slots, mirroring catalog_cyberware.slot. Used
// to drive the Slot + Category dropdowns when staff manage clinic stock; the
// "Custom…" escape covers anything off-list. Ordered roughly head-to-toe.
export const CYBERWARE_SLOTS = [
  "Neural",
  "Ocular System",
  "Auditory System",
  "Circulatory & Immune Systems",
  "Integumentary System",
  "Skeleton & Torso Musculature",
  "Universal Muscular (Arms/Legs/Tail)",
  "Arms & Arm Attachments",
  "Hands & Feet",
  "Legs & Mobility",
  "Miscellaneous",
] as const;
