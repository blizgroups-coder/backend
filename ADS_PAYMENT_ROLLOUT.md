# Ad payment fixes

Deploy with the paired Tunevora app branch `codex/ads-system-fixes-20260915` and
its reviewed Supabase accounting schema. This branch has not been merged or
deployed by the review.

Ad intent, hosted checkout, PayPal create and capture calls authenticate the
Supabase bearer token before using the claimed user ID. PayPal checks the trusted
order owner and price before capture. Verified Stripe callbacks and PayPal
capture/webhook results use `finalize_advertisement_payment` for atomic campaign,
receipt, commerce-payment and revenue writes. The SQL function is service-role only.

`node --check server.js` and `npm run test:ads` pass. The 11 regression tests
execute actual extracted route/helper source with mocked authentication/provider
responses; they do not charge money or claim a live webhook integration test.

Keep the existing signed Stripe/PayPal webhook configuration. No new provider
secret is required. Apply the paired database scripts and deploy the app/backend
together after Flutter analysis, native/browser checks and sandbox payment tests.
PayPal ad creation rejects unsupported AED; the UI directs users to Stripe.
Other purchase types retain their existing routes and accounting behavior.

## Separate local ads review

The paired app's `supabase/local/setup_ads_review.cjs` creates local test accounts
and config in a sibling `tunevora-ads-local` directory. From this backend review
checkout, run:

```bash
npm ci
node --test test/ad_payments.test.cjs test/local_ads_review.test.cjs
node local/start_ads_review.cjs ../tunevora-ads-local
```

The launcher binds `127.0.0.1:3000`, accepts only local Supabase configuration and
loads server credentials from the private sibling folder. It removes inherited
provider environment variables. With no Stripe sandbox configuration it starts
with checkout unavailable; `/local-ads-status` reports readiness without secrets.

Add a Stripe sandbox `sk_test_` key and the local Stripe CLI listener's `whsec_`
secret privately to `stripe-sandbox.json`, then restart. Forward signed sandbox
events to `http://127.0.0.1:3000/stripe-webhook`. Both must belong to the same test
environment. The review accepts only advertisement checkout and non-live ads
events; the existing signature verifier, authentication and finalizer still run.
PayPal and other purchase routes are disabled in this local mode. A checkout
return page does not establish success; use Verify Payment in the original app
tab after the webhook completes. No real or simulated charge is made by setup.

Ten isolated local-mode tests and the eleven existing payment tests pass. An
actual backend start and signed Stripe sandbox callback on the Mac remain pending.
Normal deployments must omit `TUNEVORA_ADS_LOCAL_REVIEW`; without it, the existing
provider configuration and route behavior apply. The local launcher is not a
production start command.
