#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { configureLocalAdsReview } = require('./ads_review.cjs');

function loadConfig(folder) {
  const localFolder = fs.realpathSync(folder);
  if (path.basename(localFolder) !== 'tunevora-ads-local') {
    throw new Error('Select the separate tunevora-ads-local folder.');
  }
  function read(name) {
    const file = path.join(localFolder, name);
    if (fs.lstatSync(file).isSymbolicLink()) {
      throw new Error('Local credential files must not be symbolic links.');
    }
    fs.chmodSync(file, 0o600);
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  const config = read('ads-review-backend.json');
  const stripe = read('stripe-sandbox.json');
  const selected = {};
  for (const key of ['TUNEVORA_ADS_LOCAL_REVIEW', 'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY', 'PORT', 'PAYMENT_PUBLIC_BASE_URL']) {
    selected[key] = config[key];
  }
  selected.STRIPE_SECRET_KEY = String(stripe.STRIPE_SECRET_KEY || '').trim();
  selected.STRIPE_WEBHOOK_SECRET = String(stripe.STRIPE_WEBHOOK_SECRET || '').trim();
  if (!configureLocalAdsReview(selected)) {
    throw new Error('The supplied configuration did not enable local ads review.');
  }
  return selected;
}

if (require.main === module) {
  try {
    const selected = loadConfig(process.argv[2] || '../tunevora-ads-local');
    // Do not inherit unrelated provider credentials from a developer shell.
    for (const name of Object.keys(process.env)) {
      if (/^(STRIPE_|SUPABASE_|PAYPAL_|APPLE_|GOOGLE_|PAYMENT_|CORS_)/.test(name)) {
        delete process.env[name];
      }
    }
    Object.assign(process.env, selected, { PAYPAL_BASE_URL: 'https://api-m.sandbox.paypal.com' });
    const local = configureLocalAdsReview(process.env);
    console.log('Local ads backend: http://127.0.0.1:3000');
    console.log(local.paymentsReady ? 'Stripe sandbox checkout enabled.' :
      'Stripe checkout disabled until local sandbox credentials are configured.');
    require('../server.js');
  } catch (error) {
    console.error(`Local ads backend stopped: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { loadConfig };
