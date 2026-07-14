---
name: Event ticket money legs
description: Ordering and guards for event ticket purchase/refund/attendance money flow.
---
Rule: ticket purchase order is (1) insert a pending ticket row under a FOR UPDATE lock on the ticket type (pending consumes capacity), (2) buyer debit via applyWalletDelta (`event-ticket:{id}:debit`), (3) runner credit (`:credit`) which NEVER unwinds the purchase on failure — the ticket stays purchased with payoutStatus "failed" and a manager retries with the same idem key. Refund flips status to refunded FIRST with a status-guarded conditional UPDATE, then runs `:refund-credit` / `:refund-debit`.
**Why:** debit-after-reserve means a losing racer of the last ticket loses the recount, not money; unwinding a purchase on a bounced credit would strand the buyer.
**How to apply:** any attendance/refund/status write on event_tickets must repeat the status check in the UPDATE's WHERE (TOCTOU); event create deletes the fresh event row if initial ticket-type setup fails.
