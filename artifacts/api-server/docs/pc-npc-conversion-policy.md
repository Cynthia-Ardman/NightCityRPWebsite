# PC ↔ NPC Conversion — Side-Effect Policy

_Confirmed by staff, 2026-08-08. Implemented at `PATCH /characters/:id/kind`._

---

## Billing eligibility definitions

The billing crons use two LOA sources, both of which must be checked:

| LOA source | Column | Set by | Effect on billing |
|---|---|---|---|
| **Transient self-service LOA** | `character_status.loa = true` | Player via portal | `isOnLoa()` appears at the **top** of the personal billing cron loop and skips the entire character — baseline, Trauma Team, AND Xanadu Gold all skipped |
| **Headline life status** | `characters.lifeStatus in {dead, retired, loa}` | Admin / importer | Meds household only — excluded via `countsForCyberwareBilling()` |

### Personal billing eligibility (baseline / Trauma Team / Xanadu Gold)

All three fees share the **same** cron predicate:

```
kind = 'pc'  AND  approved  AND  NOT archived  AND  ownerId IS NOT NULL
AND  character_status.loa IS NOT true   ← isOnLoa() check
```

- **Baseline**: charged once per owner while any eligible PC exists
- **Trauma Team / Xanadu Gold**: charged per eligible PC that has the tier/flag set

### Meds household eligibility

Same as personal, plus:

```
characters.lifeStatus NOT IN ('dead', 'retired', 'loa')
```

Characters unapproved, archived, or lacking an owner are excluded from all billing regardless of kind.

---

## What changes automatically on kind conversion

| System | PC → NPC | NPC → PC |
|---|---|---|
| **Personal billing** (baseline, TT, Xanadu) | Character removed from personal billing pool. Baseline continues while owner has other eligible PCs. | Character added to pool. Billing starts/is-unchanged based on owner's other eligible PCs. If on transient LOA at conversion time, all personal billing stays paused until LOA ends. |
| **Meds household** | Character's CWP removed from household; band/multiplier may decrease | Character's CWP added; band/multiplier may increase if ≥7 CWP |
| **CWP install cap** | Removed — NPCs are exempt from the 15-CWP limit | Enforced — conversion blocked if over 15 CWP |

---

## What does NOT change

| System | Decision | Reason |
|---|---|---|
| **Housing / business leases** | Kept as-is; billing continues | NPCs can hold property. Staff must manually end a lease to free the listing. |
| **Tag-linked Discord roles** | Kept as-is | NPC tags still grant the linked Discord roles to the owner. |
| **Mission rosters / applications** | Kept as-is | Participation is keyed by character ID. |
| **Wallet / UB balance** | Kept as-is | Ledger history and UB balance are unaffected. |

---

## Audit entry

Every conversion writes `audit_log` with `action = 'set_kind'`. The `afterJson.billingEffects` snapshot is computed from the character's pre-conversion fields — no ±1 arithmetic — so it is accurate for unapproved, archived, transient-LOA, and dead/retired characters.

```json
{
  "kind": "npc",
  "billingEffects": {
    "characterPersonalBillingBefore": true,
    "characterPersonalBillingAfter": false,
    "characterMedsBillingBefore": true,
    "characterMedsBillingAfter": false,
    "transientLoaActive": false,
    "lifeStatusMedsExcluded": false,
    "ownerOtherPersonalBillingEligiblePcCount": 1,
    "personalBillingNote": "owner still has personally-eligible PC(s); baseline billing continues",
    "medsBillingNote": "character's CWP removed from meds household; band/multiplier may decrease"
  }
}
```

`ownerOtherPersonalBillingEligiblePcCount` counts the owner's other PCs passing the full personal-billing predicate (including `character_status.loa = false`), matching `isOnLoa()` in the billing cron. The transient and headline LOA states are recorded as reference fields (`transientLoaActive`, `lifeStatusMedsExcluded`) since neither is changed by the kind conversion.
