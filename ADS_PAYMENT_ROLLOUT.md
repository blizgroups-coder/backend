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
