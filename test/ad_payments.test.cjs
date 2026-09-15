const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
function between(start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, `Missing source boundary: ${start}`);
  return source.slice(a, b);
}
const currency = between('const ZERO_DECIMAL_CURRENCIES', 'function paymentPublicBaseUrl(');
const authentication = between('async function authenticateSupabaseRequest(', 'async function syncGooglePlaySubscriptionPeriod(');
const pricing = between('function campaignPricing(', 'async function requireAdPaymentUser(');
const helpers = between('async function requireAdPaymentUser(', 'async function finalizeStripePayment(');

function route(name) {
  const marker = source.indexOf(`"${name}"`);
  const start = source.lastIndexOf('app.post(', marker);
  const end = source.indexOf('app.post(', marker + name.length);
  assert.ok(start >= 0 && end > start);
  return source.slice(start, end);
}

function setup({ currencyCode = 'AED', invalidToken = false, failRpc = false, paypalOwner = 'owner' } = {}) {
  const calls = { stripe: [], paypalCapture: 0, db: 0, rpc: [], lookup: 0 };
  const campaign = { id: 'campaign', ad_id: 'ad', created_by: 'owner', artist_id: 'owner',
    budget: 5, currency: currencyCode, payment_status: 'unpaid', status: 'pending' };
  let handler;
  const order = { id: 'order', status: 'APPROVED', purchase_units: [{
    custom_id: JSON.stringify({ payment_type: 'advertisement', user_id: paypalOwner, reference_id: 'campaign' }),
    amount: { value: '5.00', currency_code: currencyCode },
  }] };
  const context = vm.createContext({
    console: { log() {}, error() {} },
    PAYMENT_TYPES: { ADVERTISEMENT: 'advertisement', SUBSCRIPTION: 'subscription', EVENT_TICKET: 'event_ticket' },
    PAYPAL_BASE_URL: 'https://example.invalid',
    PAYPAL_SUPPORTED_CURRENCIES: new Set(['USD', 'JPY']),
    app: { post(name, fn) { handler = fn; } },
    loadProfile: async () => { calls.db++; return {}; },
    loadCampaignForPayment: async () => { calls.db++; return { ...campaign }; },
    getAccessToken: async () => 'synthetic-provider-token',
    supabase: {
      auth: { getUser: async () => ({ data: invalidToken ? null : { user: { id: 'owner' } }, error: invalidToken ? new Error('expired') : null }) },
      from() { calls.db++; const q = { update() { return q; }, eq() { return q; }, then(resolve) { return Promise.resolve({ error: null }).then(resolve); } }; return q; },
      rpc: async (name, params) => { calls.rpc.push({ name, params });
        return failRpc ? { error: new Error('transaction failed') } : { data: { success: true, duplicate: false } }; },
    },
    stripe: {
      paymentIntents: { create: async args => { calls.stripe.push(args); return { id: 'pi_test', client_secret: 'synthetic' }; } },
      checkout: { sessions: { create: async args => { calls.stripe.push(args); return { id: 'cs_test', url: 'https://example.invalid' }; } } },
    },
    axios: { get: async () => { calls.lookup++; return { data: order }; } },
    createPayPalOrder: async () => { throw new Error('Unexpected provider call'); },
    capturePayPalOrder: async () => { calls.paypalCapture++; return { data: { ...order, status: 'COMPLETED', purchase_units: [{ ...order.purchase_units[0],
      payments: { captures: [{ status: 'COMPLETED', amount: { value: '5.00', currency_code: currencyCode } }] },
    }] } }; },
    checkoutUrls: () => ({ successUrl: 'https://example.invalid/success', cancelUrl: 'https://example.invalid/cancel' }),
  });
  vm.runInContext(currency + authentication + pricing + helpers + between('function paypalCaptureData(', '/* ===================================================== */\n/* 🔍 DEBUG'), context);
  async function run(name, body, token) {
    vm.runInContext(route(name), context);
    let status = 200, data;
    const res = { status(code) { status = code; return res; }, json(value) { data = value; return res; } };
    await handler({ body, headers: token ? { authorization: `Bearer ${token}` } : {} }, res);
    return { status, data };
  }
  return { calls, context, run };
}

for (const endpoint of ['/create-ad-payment-intent','/create-ad-order','/capture-ad-order','/create-stripe-checkout-session']) {
  test(`${endpoint} rejects unauthenticated callers before DB/provider operations`, async () => {
    const env = setup();
    const result = await env.run(endpoint, { user_id: 'owner', campaign_id: 'campaign', orderID: 'order', payment_type: 'advertisement', reference_id: 'campaign' });
    assert.equal(result.status, 401);
    assert.equal(env.calls.db, 0);
    assert.equal(env.calls.stripe.length + env.calls.paypalCapture + env.calls.lookup, 0);
  });
}
test('invalid token and forged body identity are rejected', async () => {
  assert.equal((await setup({ invalidToken: true }).run('/create-ad-payment-intent', { user_id: 'owner', campaign_id: 'campaign' }, 'bad')).status, 401);
  assert.equal((await setup().run('/create-ad-payment-intent', { user_id: 'other', campaign_id: 'campaign' }, 'valid')).status, 403);
});
test('Stripe uses the campaign currency minor units', async () => {
  for (const [code, expected] of [['JPY', 5], ['AED', 500]]) {
    const env = setup({ currencyCode: code });
    const result = await env.run('/create-ad-payment-intent', { user_id: 'owner', campaign_id: 'campaign' }, 'valid');
    assert.equal(result.status, 200, JSON.stringify(result.data));
    assert.equal(env.calls.stripe[0].amount, expected);
  }
});
test('AED PayPal campaigns fail clearly before provider creation', async () => {
  const result = await setup().run('/create-ad-order', { user_id: 'owner', campaign_id: 'campaign' }, 'valid');
  assert.equal(result.status, 422);
  assert.match(result.data.error, /use Stripe/);
});
test('PayPal checks trusted ownership before capture', async () => {
  const env = setup({ currencyCode: 'USD', paypalOwner: 'other' });
  const result = await env.run('/capture-ad-order', { user_id: 'owner', orderID: 'order' }, 'valid');
  assert.equal(result.status, 403);
  assert.equal(env.calls.paypalCapture, 0);
});
test('PayPal finalizes through the atomic database transaction', async () => {
  const env = setup({ currencyCode: 'USD' });
  const result = await env.run('/capture-ad-order', { user_id: 'owner', orderID: 'order' }, 'valid');
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(env.calls.rpc[0].name, 'finalize_advertisement_payment');
  assert.equal(env.calls.rpc[0].params.p_transaction_reference, 'order');
});
test('Stripe finalizer never writes financial fields outside its atomic RPC', async () => {
  const env = setup();
  await env.context.finalizeStripeAdvertisement({ id: 'pi_test', status: 'succeeded', amount_received: 500, currency: 'aed',
    metadata: { user_id: 'owner', campaign_id: 'campaign' } });
  assert.equal(env.calls.db, 0);
  assert.equal(env.calls.rpc[0].name, 'finalize_advertisement_payment');
  assert.equal(env.calls.rpc[0].params.p_amount, 5);
});
test('transaction failure propagates for provider retry; incomplete Stripe payments are refused', async () => {
  const env = setup({ failRpc: true });
  const event = { id: 'pi_test', status: 'succeeded', amount_received: 500, currency: 'aed', metadata: { user_id: 'owner', campaign_id: 'campaign' } };
  await assert.rejects(env.context.finalizeStripeAdvertisement(event), /transaction failed/);
  await assert.rejects(env.context.finalizeStripeAdvertisement({ ...event, status: 'processing' }), /Invalid completed/);
});
