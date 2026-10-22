-- phase: migrate
-- OpenVibe.Billing holds every payment provider's credentials since the cutover of 2026-10-17 (its environment file;
-- openvibe.network/admin → Payments points there), and Live offers a way to pay when Billing reports that provider
-- enabled (server/monetization/payments.js, GET /api/v1/rates). Nothing in Live reads these settings any more
-- (test/billing-authority.test.js), so they leave site_settings and the admin's Payments form. Production on
-- 2026-10-22: every credential here was empty; crypto_provider and paypal_mode held their seed defaults. The
-- per-provider switches (paypal_enabled, stripe_enabled, ccbill_enabled, crypto_enabled) stay. The N-1 release reads
-- only stripe_secret_key, paypal_client_id, ccbill_flexform_id, crypto_api_key and stripe_publishable_key, as empty
-- strings when absent, which is what production holds today.
DELETE FROM site_settings WHERE key IN (
    'ccbill_client_account', 'ccbill_flexform_id', 'ccbill_salt', 'ccbill_subaccount', 'ccbill_webhook_secret',
    'crypto_api_key', 'crypto_ipn_secret', 'crypto_provider',
    'paypal_client_id', 'paypal_client_secret', 'paypal_mode', 'paypal_webhook_id',
    'stripe_publishable_key', 'stripe_secret_key', 'stripe_webhook_secret'
);
