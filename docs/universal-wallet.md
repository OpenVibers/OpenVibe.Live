# Shared wallet

Live enables the Shared wallet and delegates balance display, buying Vibes, top-ups and cosmetic ownership/equipment to it. The local purchase modal, balance loader and cosmetic editor are removed; Live still renders Inventory cosmetics and keeps its stream-specific tipping/subscription actions.

The review branch pins Shared's wallet branch (PR #365). Replace the branch pin with its reviewed release tag before shipping. The sheet asks Network's `/api/frame/wallet/…` relays (Network PR), so Live's `connect-src` keeps neither `billing.openvibe.network` nor `inventory.openvibe.network`. Billing #228 and Inventory #219 must be deployed with the wallet release; reviewed store listings and configured checkout providers are separate rollout prerequisites.

GET /api/payments/wallet-state exposes only the owner money_writes_frozen boolean with no-store. Database errors return 503. Billing reads this alongside its own ledger freeze and fails closed if it is unavailable. No cookies, user data or new permission to change the switch are exposed.

The Shared PR contains phone/desktop screenshots and Chrome sheet checks. Live's focused tests cover navbar delegation, removed local UI, retained cosmetic renderers and the owner switch including database failure. No production writes or deployment are performed by this PR.
