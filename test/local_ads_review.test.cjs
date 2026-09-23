'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { configureLocalAdsReview } = require('../local/ads_review.cjs');
const { loadConfig } = require('../local/start_ads_review.cjs');

function config(overrides = {}) {
  return {
    TUNEVORA_ADS_LOCAL_REVIEW: '1', PORT: '3000',
    SUPABASE_URL: 'http://127.0.0.1:54321',
    SUPABASE_SERVICE_ROLE_KEY: `header.${Buffer.from('{"role":"service_role"}').toString('base64url')}.signature`,
    PAYMENT_PUBLIC_BASE_URL: 'http://127.0.0.1:3000',
    STRIPE_SECRET_KEY: 'sk_test_synthetic', STRIPE_WEBHOOK_SECRET: 'whsec_synthetic', ...overrides,
  };
}
function request(guard, { method = 'POST', pathname = '/create-ad-payment-intent', headers = {}, body } = {}) {
  let status = 200, data, advanced = false;
  const response = {
    status(value) { status = value; return response; },
    json(value) { data = value; return response; },
    type() { return response; }, send(value) { data = value; return response; },
  };
  guard({ method, path: pathname, headers: { host: '127.0.0.1:3000', ...headers }, body },
    response, () => { advanced = true; });
  return { status, data, advanced };
}

test('normal backend startup stays outside local mode', () => {
  assert.equal(configureLocalAdsReview({ STRIPE_SECRET_KEY: 'sk_live_synthetic' }), null);
});
test('local mode rejects hosted services, live keys and ambiguous flags', () => {
  for (const override of [
    { TUNEVORA_ADS_LOCAL_REVIEW: 'true' }, { SUPABASE_URL: 'https://example.supabase.co' },
    { SUPABASE_URL: 'http://localhost.evil.test:54321' }, { PORT: '8000' },
    { PAYMENT_PUBLIC_BASE_URL: 'https://tunevora.com' }, { STRIPE_SECRET_KEY: 'sk_live_synthetic' },
  ]) { assert.throws(() => configureLocalAdsReview(config(override))); }
});
test('backend can start with checkout disabled, and exposes no keys in status', () => {
  const local = configureLocalAdsReview(config({ STRIPE_SECRET_KEY: '', STRIPE_WEBHOOK_SECRET: '' }));
  assert.equal(local.paymentsReady, false);
  assert.equal(request(local.requestGuard).status, 503);
  const health = request(local.requestGuard, { method: 'GET', pathname: '/local-ads-status' });
  assert.deepEqual(health.data, { local: true, database: 'local', stripeSandboxReady: false });
});
test('both a test key and webhook secret are required before checkout', () => {
  for (const override of [{ STRIPE_SECRET_KEY: '' }, { STRIPE_WEBHOOK_SECRET: '' }]) {
    assert.equal(request(configureLocalAdsReview(config(override)).requestGuard).status, 503);
  }
  assert.equal(request(configureLocalAdsReview(config()).requestGuard).advanced, true);
});
test('only local ads routes and local browser origins pass the request guard', () => {
  const local = configureLocalAdsReview(config());
  for (const pathname of ['/create-subscription', '/paypal-webhook', '/create-ad-order', '/verify-apple-purchase']) {
    assert.equal(request(local.requestGuard, { pathname }).status, 404);
  }
  assert.equal(request(local.requestGuard, { headers: { origin: 'https://tunevora.com' } }).status, 403);
  assert.equal(request(local.requestGuard, { headers: { host: 'attacker.test:3000' } }).status, 403);
  assert.equal(request(local.requestGuard, { headers: { origin: 'http://127.0.0.1:7357' } }).advanced, true);
});
test('shared checkout route requires advertisement payment type', () => {
  const local = configureLocalAdsReview(config());
  for (const payment_type of [undefined, 'subscription', 'event_ticket']) {
    assert.equal(request(local.bodyGuard, { pathname: '/create-stripe-checkout-session', body: { payment_type } }).status, 400);
  }
  assert.equal(request(local.bodyGuard, {
    pathname: '/create-stripe-checkout-session', body: { payment_type: 'advertisement' },
  }).advanced, true);
});
test('webhook scope excludes live events and unrelated sandbox payments', () => {
  const local = configureLocalAdsReview(config());
  const object = { livemode: false, metadata: { payment_type: 'advertisement' } };
  assert.equal(local.acceptsWebhook({ livemode: false, data: { object } }), true);
  assert.equal(local.acceptsWebhook({ livemode: true, data: { object } }), false);
  assert.equal(local.acceptsWebhook({ livemode: false, data: { object: { ...object, livemode: true } } }), false);
  assert.equal(local.acceptsWebhook({ livemode: false, data: { object: { ...object, metadata: { payment_type: 'subscription' } } } }), false);
});
test('return page asks for verified payment and never deep-links to the production app', () => {
  const local = configureLocalAdsReview(config());
  const response = request(local.requestGuard, { method: 'GET', pathname: '/payment-success' });
  assert.match(response.data, /Verify Payment/);
  assert.doesNotMatch(response.data, /tunevora:\/\/|payment successful/i);
});
test('launcher refuses config missing the local flag and reads only selected variables', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ads-launcher-test-'));
  const folder = path.join(root, 'tunevora-ads-local');
  fs.mkdirSync(folder);
  try {
    const values = config({ GOOGLE_API_KEY: 'must-not-be-loaded' });
    fs.writeFileSync(path.join(folder, 'ads-review-backend.json'), JSON.stringify(values));
    fs.writeFileSync(path.join(folder, 'stripe-sandbox.json'), '{}');
    assert.equal(loadConfig(folder).GOOGLE_API_KEY, undefined);
    assert.equal(loadConfig(folder).STRIPE_SECRET_KEY, '');
    delete values.TUNEVORA_ADS_LOCAL_REVIEW;
    fs.writeFileSync(path.join(folder, 'ads-review-backend.json'), JSON.stringify(values));
    assert.throws(() => loadConfig(folder), /did not enable local/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('actual server bootstrap wires the local guard before routes and binds loopback', () => {
  const vm = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  for (const localMode of [true, false]) {
    const stack = [];
    let listenArgs, stripeCreations = 0, databaseUrl;
    const app = {
      use(fn) { stack.push({ kind: 'middleware', fn }); },
      get(url, ...handlers) { stack.push({ kind: 'route', url, handlers }); },
      post(url, ...handlers) { stack.push({ kind: 'route', url, handlers }); },
      listen(...args) { listenArgs = args; },
    };
    const express = Object.assign(() => app, { raw: () => function rawBody() {} });
    const modules = {
      express, 'body-parser': { json: () => function jsonBody() {} }, axios: {},
      '@supabase/supabase-js': { createClient(url) { databaseUrl = url; return {}; } },
      stripe: class { constructor() { stripeCreations++; } },
      crypto: require('node:crypto'), googleapis: { google: {} },
      '@apple/app-store-server-library': {},
      './local/ads_review.cjs': { configureLocalAdsReview },
    };
    const env = config({ STRIPE_SECRET_KEY: '', STRIPE_WEBHOOK_SECRET: '' });
    if (!localMode) { delete env.TUNEVORA_ADS_LOCAL_REVIEW; }
    vm.runInNewContext(source, {
      require(name) { assert.ok(Object.hasOwn(modules, name), name); return modules[name]; },
      process: { env }, console: { log() {}, error() {} }, Buffer, URL,
    });
    assert.equal(databaseUrl, env.SUPABASE_URL);
    assert.equal(stripeCreations, localMode ? 0 : 1);
    assert.equal(listenArgs.length, localMode ? 3 : 2);
    if (localMode) {
      assert.equal(listenArgs[1], '127.0.0.1');
      assert.equal(request(stack[0].fn).status, 503);
    }
    const webhookIndex = stack.findIndex(layer => layer.url === '/stripe-webhook');
    const jsonIndex = stack.findIndex(layer => layer.fn?.name === 'jsonBody');
    assert.ok(webhookIndex >= 0 && webhookIndex < jsonIndex);
    assert.equal(stack[webhookIndex].handlers[0].name, 'rawBody');
  }
});
