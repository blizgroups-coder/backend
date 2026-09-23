'use strict';

function loopback(value, port) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) ||
      url.port !== String(port) || url.username || url.password ||
      !['', '/'].includes(url.pathname) || url.search || url.hash) {
    throw new Error('Local ads review requires loopback service addresses.');
  }
}

function configureLocalAdsReview(env) {
  if (env.TUNEVORA_ADS_LOCAL_REVIEW === undefined || env.TUNEVORA_ADS_LOCAL_REVIEW === '') {
    return null;
  }
  if (env.TUNEVORA_ADS_LOCAL_REVIEW !== '1') {
    throw new Error('The backend local review flag must be 1 or absent.');
  }
  loopback(env.SUPABASE_URL, 54321);
  loopback(env.PAYMENT_PUBLIC_BASE_URL, 3000);
  if (String(env.PORT) !== '3000') {
    throw new Error('The local review backend must use port 3000.');
  }
  let role;
  try {
    role = JSON.parse(Buffer.from(env.SUPABASE_SERVICE_ROLE_KEY.split('.')[1], 'base64url').toString()).role;
  } catch { /* Refused below, without logging a key. */ }
  if (role !== 'service_role') {
    throw new Error('The local backend requires its server-only Supabase key.');
  }
  const stripeKey = String(env.STRIPE_SECRET_KEY || '').trim();
  const webhookSecret = String(env.STRIPE_WEBHOOK_SECRET || '').trim();
  if (stripeKey && !/^sk_test_[A-Za-z0-9]+$/.test(stripeKey)) {
    throw new Error('Local review accepts only Stripe sandbox secret keys beginning sk_test_.');
  }
  if (webhookSecret && !/^whsec_[A-Za-z0-9]+$/.test(webhookSecret)) {
    throw new Error('Use the signing secret printed by the local Stripe CLI listener.');
  }
  const paymentsReady = Boolean(stripeKey && webhookSecret);
  const allowedPostPaths = new Set([
    '/create-ad-payment-intent', '/create-stripe-checkout-session', '/stripe-webhook',
  ]);

  function requestGuard(req, res, next) {
    const host = String(req.headers.host || '').toLowerCase();
    const origin = String(req.headers.origin || '');
    if (!['127.0.0.1:3000', 'localhost:3000'].includes(host) ||
        (origin && !['http://127.0.0.1:7357', 'http://localhost:7357'].includes(origin))) {
      return res.status(403).json({ error: 'Use the local ads review app on port 7357.' });
    }
    if (req.method === 'OPTIONS') { return next(); }
    if (req.method === 'GET' && req.path === '/local-ads-status') {
      return res.json({ local: true, database: 'local', stripeSandboxReady: paymentsReady });
    }
    if (req.method === 'GET' && ['/payment-success', '/payment-cancel'].includes(req.path)) {
      return res.type('html').send(
        '<!doctype html><html lang="en"><meta charset="utf-8"><title>Local ads review</title>' +
        '<body><h1>Stripe sandbox checkout returned</h1>' +
        '<p>Return to your original local review tab and use Verify Payment. ' +
        'The signed Stripe webhook determines the payment result.</p></body></html>'
      );
    }
    if (req.method === 'GET' && req.path === '/') { return next(); }
    if (req.method !== 'POST' || !allowedPostPaths.has(req.path)) {
      return res.status(404).json({ error: 'This route is unavailable in local ads review.' });
    }
    if (!paymentsReady) {
      return res.status(503).json({
        error: 'Configure a Stripe sandbox key and local webhook signing secret, then restart the local backend.',
      });
    }
    return next();
  }

  function bodyGuard(req, res, next) {
    if (req.path === '/create-stripe-checkout-session' && req.body?.payment_type !== 'advertisement') {
      return res.status(400).json({ error: 'Local review accepts advertisement payments only.' });
    }
    return next();
  }

  function acceptsWebhook(event) {
    return event.livemode === false && event.data?.object?.livemode === false &&
      event.data.object.metadata?.payment_type === 'advertisement';
  }

  return { stripeKey, paymentsReady, requestGuard, bodyGuard, acceptsWebhook };
}

module.exports = { configureLocalAdsReview, loopback };
