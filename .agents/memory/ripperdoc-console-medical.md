---
name: Ripperdoc console medical read + console-driven install/remove
description: Why the staff /medical endpoint exists and how the console reuses the player approval flow
---

# Role-gated medical read endpoint

`GET /admin/characters/:id/medical` (RIPPERDOC/ADMIN gated) exists because the
per-character history endpoints `/characters/:id/updates` and
`/characters/:id/wallet/transactions` are OWNER-ONLY (`loadOwnedChar`). A
ripperdoc treating someone else's patient is not the owner, so they need a
separate staff/role-gated aggregate read.

**Returns:** characterId, characterName, kind, cyberwareLevel (legacy column,
cosmetic), `band` DERIVED via `deriveCyberwareBand(usedCwp).level` (npc →
`"exempt"`), usedCwp (sum of `parseCwp`/`cwpForItem` over installed cyberware),
lastCheckupAt, checkupStreak, installed[], checkups[] (auditLog action=checkup),
medsPayments[] (wallet_transactions where `classifyWalletCategory`==='cyberware').

**Why:** the console previously displayed `characters.cyberwareLevel ?? "none"`
which is the empty legacy column — band must always be DERIVED from inventory
CWP (see cyberware-band-source.md). Don't reintroduce the column read.

# Console-driven install/remove reuses the approval flow

The Ripperdoc Console install/remove does NOT add a new write path. It opens the
same `CyberwareActionDialog` / `RemoveCyberwareDialog` used by MyClinicDetail,
which POST to `/ripperdocs/:id/install` and `/ripperdocs/:id/remove`
(createOffer / createRemoveOffer, `isOperator` clinic-operator authz enforced
server-side). The only additions are OPTIONAL `presetBuyer`/`lockBuyer` and
`presetTarget`/`lockTarget` props that pre-fill + lock the patient picker;
defaults keep MyClinicDetail unchanged.

**How to apply:** to add staff-initiated variants of an existing player flow,
preset+lock the existing dialog rather than forking the mutation — the server
authz/approval stays the single source of truth.
