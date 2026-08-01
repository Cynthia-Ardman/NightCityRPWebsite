# Catalog gun conversion — live prod run 2026-08-01

Script: `scripts/convert-catalog-guns.ts` (dry-run default, `--apply` to write, `--target=live` for prod).

## Result
- 209 gun/weapon inventory rows scanned; 67 already matched the catalog exactly.
- 10 rows auto-converted (below) — names set to exact catalog names, notes rewritten from catalog attributes, audit_log rows written (action `catalog_gun_convert`).
- 25 near-matches left for a human decision (below) — NOT modified.
- 107 rows judged genuinely custom — untouched.

## Converted
    CONVERT #8024 "Arasaka Tamayura" → "Tamayura" (manufacturer+name exact)
      notes: null → "Manufacturer: Arasaka · Category: Power · Type: pistol · Fire: Semi-Auto · Power: M"
    CONVERT #8384 "Malorian Overture" → "Overture" (manufacturer+name exact)
      notes: "Category: Power · Type: Revolver · Fire: Semi-Auto · Power: M" → "Manufacturer: Malorian · Category: Power · Type: revolver · Fire: Semi-Auto · Power: H"
    CONVERT #8411 "Tsunami Nue" → "Nue" (manufacturer+name exact)
      notes: "Category: Power · Type: Pistol · Fire: Semi-Auto · Power: M · A standard Nuw, just covered in Clown graffiti and bozo logos" → "Manufacturer: Tsunami · Category: Power · Type: pistol · Fire: Semi-Auto · Power: M"
    CONVERT #8538 "Tsunami Nue" → "Nue" (manufacturer+name exact)
      notes: "Category: Power · Type: Pistol · Fire: Semi-Auto · Power: M" → "Manufacturer: Tsunami · Category: Power · Type: pistol · Fire: Semi-Auto · Power: M"
    CONVERT #8779 "Tsunami Nue" → "Nue" (manufacturer+name exact)
      notes: "Manufacturer: n/a · Category: Power · Type: Pistol · Fire: Semi-Auto · Power: M · Gotten from Lazarus mission to save Phantom: Hostile Repossession." → "Manufacturer: Tsunami · Category: Power · Type: pistol · Fire: Semi-Auto · Power: M"
    CONVERT #8857 "HIB-MK33" → "HIB MK33" (loose-key exact)
      notes: "Category: Power · Type: Revolver · Fire: Semi-Auto · Power: M · Trade-in for the Overture." → "Manufacturer: SkullCO · Category: Power · Type: Revolver · Fire: Semi-Auto · Power: Medium"
    CONVERT #8889 "Nue [M]" → "Nue" (edit-distance 1)
      notes: "Category: Power · Power: M" → "Manufacturer: Tsunami · Category: Power · Type: pistol · Fire: Semi-Auto · Power: M"
    CONVERT #8890 "Nue [M]" → "Nue" (edit-distance 1)
      notes: "Category: Power · Power: M" → "Manufacturer: Tsunami · Category: Power · Type: pistol · Fire: Semi-Auto · Power: M"
    CONVERT #8899 "Constitutional Arms Liberty" → "Liberty" (manufacturer+name exact)
      notes: "Manufacturer: Constitutional Arms · Category: Power · Type: Pistol · Fire: Semi-Auto · Power: M" → "Manufacturer: Constitutional Arms · Category: Power · Type: pistol · Fire: Semi-Auto · Power: M"
    CONVERT #8972 "Tsunami Nue" → "Nue" (manufacturer+name exact)
      notes: "Category: Power · Type: Pistol · Fire: Semi-Auto · Power: M" → "Manufacturer: Tsunami · Category: Power · Type: pistol · Fire: Semi-Auto · Power: M"

## Needs human decision (unmodified)
    NEEDS HUMAN DECISION:
      #7957 "HJKE-11 Yukimura "Magic Missile"" (notes: "Manufacturer: Arasaka · Type: Smart Pistol · Fire: Full-Auto · Power: Light · Damage: 40 · Mag: 30 · \"It never misses!\"") → candidate "HJKE-11 Yukimura" [dist=12, containment, ATTRS CONTRADICT] catalog attrs: Manufacturer: Arasaka · Category: Smart · Type: pistol · Fire: Full-Auto · Power: L — needs human decision
      #7970 "Bitch Ears [Takashi's red nue" (notes: null) → candidate "Nue" [dist=20, containment] catalog attrs: Manufacturer: Tsunami · Category: Power · Type: pistol · Fire: Semi-Auto · Power: M — needs human decision
      #7971 "Nue Surpressed" (notes: null) → candidate "Nue" [dist=10, containment] catalog attrs: Manufacturer: Tsunami · Category: Power · Type: pistol · Fire: Semi-Auto · Power: M — needs human decision
      #7975 "DB-2 Testera, "Rodrigo"" (notes: "Manufacturer: Rostović · Category: Power · Type: Shotgun · Fire: Semi-Auto · Power: M · One of a matching pair given to El Toro de Sangre upon his leaving Juarez to return to Night City by Don Illardo of the Juarez Cartel.") → candidate "DB-2 Testera" [dist=7, containment] catalog attrs: Manufacturer: Rostovic · Category: Power · Type: shotgun · Fire: Semi-Auto · Power: L — needs human decision
      #7976 "DB-2 Testera, "Gabriella"" (notes: "Manufacturer: Rostović · Category: Power · Type: Shotgun · Fire: Semi-Auto · Power: M · One of a matching pair given to El Toro de Sangre upon his leaving Juarez to return to Night City by Don Illardo of the Juarez Cartel.") → candidate "DB-2 Testera" [dist=9, containment] catalog attrs: Manufacturer: Rostovic · Category: Power · Type: shotgun · Fire: Semi-Auto · Power: L — needs human decision
      #8018 "Lexington" (notes: null) → candidate "M-10AF Lexington" [dist=5, containment] catalog attrs: Manufacturer: Militech · Category: Power · Type: pistol · Fire: Full-Auto · Power: L — needs human decision
      #8060 ""HOUNDROAR" Shotgun" (notes: "Type: Power Revolver\nManufacturer: Stella Quartz Armory\nCaliber: 4-Gauge\nCapacity: 6+1 Rounds\nWeight: Heavy") → candidate "Hound Roar" [dist=7, containment, ATTRS CONTRADICT] catalog attrs: Manufacturer: Stella Quartz · Category: Power · Type: Shotgun · Fire: Semi-Auto · Power: H — needs human decision
      #8071 "Traditional Mono Wakizashi" (notes: "A heirloom from the Shigeru Clan. Saburō customed it to become a Mono-Molecular Edged blade, independent of cyberware.") → candidate "Nowaki" [dist=18, containment] catalog attrs: Manufacturer: Arasaka · Category: Power · Type: assault_rifle · Fire: Burst · Power: M — needs human decision
      #8190 "Supressed Tsunami Nue "Lo Siento"" (notes: "Category: Power · Type: Pistol · Fire: Semi-Auto · Power: M · Previously Owned, not ported over") → candidate "Nue" [dist=24, containment] catalog attrs: Manufacturer: Tsunami · Category: Power · Type: pistol · Fire: Semi-Auto · Power: M — needs human decision
      #8220 "DB-2 Testera (6 pellets)" (notes: "Manufacturer: Rostovic · Category: Power · Type: shotgun · Fire: Semi-Auto · Power: L") → candidate "DB-2 Testera" [dist=8, containment] catalog attrs: Manufacturer: Rostovic · Category: Power · Type: shotgun · Fire: Semi-Auto · Power: L — needs human decision
      #8236 "N/A" (notes: "Category: n/a · Type: n/a · Fire: N/A · Power: N/A") → candidate "Nue" [dist=2] catalog attrs: Manufacturer: Tsunami · Category: Power · Type: pistol · Fire: Semi-Auto · Power: M — needs human decision
      #8254 "M2038 Tactician (6 pellets)" (notes: "Manufacturer: Constitutional Arms · Category: Power · Type: shotgun · Fire: Semi-Auto · Power: L") → candidate "M2038 Tactician" [dist=8, containment] catalog attrs: Manufacturer: Constitutional Arms · Category: Power · Type: shotgun · Fire: Semi-Auto · Power: L — needs human decision
      #8327 "DB-2 Satara (14 pellets) (2 shot burst)" (notes: "Category: Tech · Type: Shotgun · Fire: Semi-Auto · Power: M · (I started with this weapon, thought the inventory should be updated") → candidate "DB-2 Satara" [dist=19, containment, ATTRS CONTRADICT] catalog attrs: Manufacturer: Rostovic · Category: Tech · Type: shotgun · Fire: Semi-Auto · Power: M — needs human decision
      #8432 "Barghest M251s Ajax" (notes: "Manufacturer: Militech · Category: Power · Type: assault_rifle · Fire: Full-Auto · Power: M") → candidate "M251s Ajax" [dist=8, containment] catalog attrs: Manufacturer: Militech · Category: Power · Type: assault_rifle · Fire: Full-Auto · Power: M — needs human decision
      #8433 "Barghest M-10AF Lexington" (notes: "Manufacturer: Militech · Category: Power · Type: pistol · Fire: Full-Auto · Power: M") → candidate "M-10AF Lexington" [dist=8, containment] catalog attrs: Manufacturer: Militech · Category: Power · Type: pistol · Fire: Full-Auto · Power: L — needs human decision
      #8434 "Barghest M-10AF Lexington" (notes: "Manufacturer: Militech · Category: Power · Type: pistol · Fire: Full-Auto · Power: M") → candidate "M-10AF Lexington" [dist=8, containment] catalog attrs: Manufacturer: Militech · Category: Power · Type: pistol · Fire: Full-Auto · Power: L — needs human decision
      #8511 "Modified large frame DR-5 Nova, Loaded with Shotgun Rounds" (notes: "Category: Power · Type: Revolver · Fire: Semi-Auto · Power: H") → candidate "DR-5 Nova" [dist=41, containment] catalog attrs: Manufacturer: Darra Polytechnic · Category: Power · Type: revolver · Fire: Semi-Auto · Power: M — needs human decision
      #8524 "Lexington" (notes: "Category: Power · Type: Pistol · Fire: Full-Auto · Power: L · i bought a lexington months ago for 1000 and forgot to add it to my sheet") → candidate "M-10AF Lexington" [dist=5, containment] catalog attrs: Manufacturer: Militech · Category: Power · Type: pistol · Fire: Full-Auto · Power: L — needs human decision
      #8640 "M2038 Tactician (6 pellets)" (notes: "Manufacturer: Constitutional Arms · Category: Power · Type: shotgun · Fire: Semi-Auto · Power: L") → candidate "M2038 Tactician" [dist=8, containment] catalog attrs: Manufacturer: Constitutional Arms · Category: Power · Type: shotgun · Fire: Semi-Auto · Power: L — needs human decision
      #8646 "Unarmed, can possibly grab a Slaught-O-Matic from a vending machine." (notes: "Category: None · Type: None · Fire: None · Power: None") → candidate "Slaught-O-Matic" [dist=42, containment] catalog attrs: Manufacturer: Budget Arms · Category: Power · Type: pistol · Fire: Full-Auto · Power: L — needs human decision
      #8701 "Defender" (notes: "Manufacturer: Militech · Category: Power · Type: LMG · Fire: Full-Auto · Power: M") → candidate "M2067 Defender" [dist=5, containment, ATTRS CONTRADICT] catalog attrs: Manufacturer: Constitutional Arms · Category: Power · Type: light_machine_gun · Fire: Full-Auto · Power: M — needs human decision
      #8805 "DB-2 Testera (6 pellets)" (notes: "Category: Power · Type: Shotgun · Fire: Semi-Auto · Power: L") → candidate "DB-2 Testera" [dist=8, containment] catalog attrs: Manufacturer: Rostovic · Category: Power · Type: shotgun · Fire: Semi-Auto · Power: L — needs human decision
      #8824 "None" (notes: "Category: none · Type: none · Fire: none · Power: none") → candidate "Nue" [dist=2] catalog attrs: Manufacturer: Tsunami · Category: Power · Type: pistol · Fire: Semi-Auto · Power: M — needs human decision
      #8897 "M251s Ajax (Modified)" (notes: "Manufacturer: Custom · Category: Power · Type: Assault Rifle · Fire: Full-Auto · Power: M") → candidate "M251s Ajax" [dist=8, containment] catalog attrs: Manufacturer: Militech · Category: Power · Type: assault_rifle · Fire: Full-Auto · Power: M — needs human decision
      #8978 "Rostović DB-2 Testera" (notes: "Category: Power · Type: Shotgun · Fire: Semi-Auto · Power: L") → candidate "DB-2 Testera" [dist=7, containment] catalog attrs: Manufacturer: Rostovic · Category: Power · Type: shotgun · Fire: Semi-Auto · Power: L — needs human decision
    

## Second pass — 2026-08-01 (annotation suffixes + broader category scan)
- Scan widened to categories gun/weapon/power/tech/smart (some rows store the firing class as the category).
- New tier: catalog name + trailing annotation like "(6 pellets)" / "[M]" converts, with the annotation preserved at the end of the notes; annotations implying real customization (modified, custom, sawn-off…) still go to human review.
- 10 more rows converted; 21 remain flagged for staff decision.

    CONVERT #8184 "M-10AF Lexington [L]" → "M-10AF Lexington" (annotation suffix ("L" kept in notes))
    CONVERT #8220 "DB-2 Testera (6 pellets)" → "DB-2 Testera" (annotation suffix ("6 pellets" kept in notes))
    CONVERT #8254 "M2038 Tactician (6 pellets)" → "M2038 Tactician" (annotation suffix ("6 pellets" kept in notes))
    CONVERT #8601 "DB-2 Testera (6 pellets)" → "DB-2 Testera" (annotation suffix ("6 pellets" kept in notes))
    CONVERT #8603 "M2038 Tactician (6 pellets)" → "M2038 Tactician" (annotation suffix ("6 pellets" kept in notes))
    CONVERT #8605 "DB-2 Testera (6 pellets)" → "DB-2 Testera" (annotation suffix ("6 pellets" kept in notes))
    CONVERT #8606 "Carnage (6 pellets)" → "Carnage" (annotation suffix ("6 pellets" kept in notes))
    CONVERT #8640 "M2038 Tactician (6 pellets)" → "M2038 Tactician" (annotation suffix ("6 pellets" kept in notes))
    CONVERT #8764 "Nowaki [M]" → "Nowaki" (annotation suffix ("M" kept in notes))
    CONVERT #8805 "DB-2 Testera (6 pellets)" → "DB-2 Testera" (annotation suffix ("6 pellets" kept in notes))
