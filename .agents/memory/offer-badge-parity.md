---
name: Offer nav badge parity
description: My Offers nav badge must mirror the page's actionable filter or it sticks forever.
---
The AppLayout "My Offers" nav badge must count ONLY offers the MyOffers page can actually action: `status === "pending" && offerType === "stock_add"`.

**Why:** MyOffers only renders/actions pending stock_add offers. Counting ALL pending offers (e.g. legacy give/sale offers that have no dismiss UI) produces a phantom badge the user can never clear.

**How to apply:** Any nav/count badge must use the SAME predicate as the list that lets the user clear the underlying rows. Same class as my-unseen-phantom-badge and dashboard-review-count-parity.
