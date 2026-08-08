const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const { createClient } = require("@supabase/supabase-js");
const Stripe = require("stripe");
const crypto = require("crypto");
const { google } = require("googleapis");

const stripe = new Stripe(
  process.env.STRIPE_SECRET_KEY
);

const app = express();

/* ===================================================== */
/* 🌐 CORS - TUNEVORA WEB                               */
/* ===================================================== */

const allowedOrigins = new Set([
  "https://tunevora.com",
  "https://www.tunevora.com",
]);

app.use((req, res, next) => {
  const origin = req.headers.origin;

  if (origin && allowedOrigins.has(origin)) {
    res.header(
      "Access-Control-Allow-Origin",
      origin
    );

    res.header(
      "Vary",
      "Origin"
    );
  }

  res.header(
    "Access-Control-Allow-Methods",
    "GET,POST,OPTIONS"
  );

  res.header(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, Accept"
  );

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});

/* ===================================================== */
/* 🔐 SUPABASE */
/* ===================================================== */

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

/* ===================================================== */
/* 🤖 GOOGLE PLAY BILLING CONFIGURATION                  */
/* ===================================================== */

const GOOGLE_PLAY_PACKAGE_NAME = String(
  process.env.GOOGLE_PLAY_PACKAGE_NAME ||
    "com.tunevora.music"
).trim();

const GOOGLE_PLAY_STANDARD_PRODUCT_ID = String(
  process.env.GOOGLE_PLAY_STANDARD_PRODUCT_ID ||
    "standard_monthly"
).trim();

const GOOGLE_PLAY_PREMIUM_PRODUCT_ID = String(
  process.env.GOOGLE_PLAY_PREMIUM_PRODUCT_ID ||
    "premium_monthly"
).trim();

const GOOGLE_PLAY_PRODUCT_TO_PLAN = new Map([
  [GOOGLE_PLAY_STANDARD_PRODUCT_ID, "standard"],
  [GOOGLE_PLAY_PREMIUM_PRODUCT_ID, "premium"],
]);

const GOOGLE_PLAY_ENTITLED_STATES = new Set([
  "SUBSCRIPTION_STATE_ACTIVE",
  "SUBSCRIPTION_STATE_IN_GRACE_PERIOD",
  "SUBSCRIPTION_STATE_CANCELED",
]);

let googlePlayPublisherClient = null;

function readGoogleServiceAccount() {
  const rawValue = String(
  process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON || ""
).trim();

  if (!rawValue) {
    throw new Error(
      "Google Play service-account JSON is missing"
    );
  }

  let decodedValue = rawValue;

  if (!rawValue.startsWith("{")) {
    try {
      decodedValue = Buffer.from(
        rawValue,
        "base64"
      ).toString("utf8");
    } catch (_) {
      decodedValue = rawValue;
    }
  }

  let credentials;

  try {
    credentials = JSON.parse(decodedValue);
  } catch (_) {
    throw new Error(
      "Google Play service-account JSON is invalid"
    );
  }

  if (
    !credentials.client_email ||
    !credentials.private_key
  ) {
    throw new Error(
      "Google Play service-account credentials are incomplete"
    );
  }

  credentials.private_key = String(
    credentials.private_key
  ).replace(/\\n/g, "\n");

  return credentials;
}

function getGooglePlayPublisherClient() {
  if (googlePlayPublisherClient) {
    return googlePlayPublisherClient;
  }

  const credentials =
    readGoogleServiceAccount();

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: [
      "https://www.googleapis.com/auth/androidpublisher",
    ],
  });

  googlePlayPublisherClient =
    google.androidpublisher({
      version: "v3",
      auth,
    });

  return googlePlayPublisherClient;
}

function googlePlayReference(purchaseToken) {
  const digest = crypto
    .createHash("sha256")
    .update(String(purchaseToken))
    .digest("hex");

  return `google_play:${digest}`;
}

function latestGooglePlayExpiry(lineItems) {
  const expiries = (lineItems || [])
    .map((item) => new Date(item?.expiryTime || 0))
    .filter((date) =>
      Number.isFinite(date.getTime())
    );

  if (expiries.length === 0) {
    throw new Error(
      "Google Play did not return a valid expiry time"
    );
  }

  return new Date(
    Math.max(...expiries.map((date) => date.getTime()))
  );
}

async function authenticateSupabaseRequest(req) {
  const authorizationHeader = String(
    req.headers.authorization || ""
  );

  const accessToken =
    authorizationHeader.startsWith("Bearer ")
      ? authorizationHeader.substring(7).trim()
      : "";

  if (!accessToken) {
    const error = new Error(
      "Missing user authentication token"
    );
    error.statusCode = 401;
    throw error;
  }

  const {
    data,
    error,
  } = await supabase.auth.getUser(accessToken);

  if (error || !data?.user) {
    const authError = new Error(
      "Invalid or expired user session"
    );
    authError.statusCode = 401;
    throw authError;
  }

  return data.user;
}

async function syncGooglePlaySubscriptionPeriod({
  userId,
  plan,
  expiryTime,
}) {
  const {
    data: latestSubscription,
    error: loadError,
  } = await supabase
    .from("subscriptions")
    .select("id")
    .eq("user_id", userId)
    .eq("plan", plan)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (loadError) {
    throw loadError;
  }

  if (latestSubscription) {
    const { error: updateError } = await supabase
      .from("subscriptions")
      .update({
        status: "active",
        expires_at: expiryTime.toISOString(),
      })
      .eq("id", latestSubscription.id);

    if (updateError) {
      throw updateError;
    }

    return;
  }

  const { error: insertError } = await supabase
    .from("subscriptions")
    .insert({
      user_id: userId,
      plan,
      status: "active",
      amount: 0,
      currency: "AED",
      expires_at: expiryTime.toISOString(),
    });

  if (insertError) {
    throw insertError;
  }
}

/* ===================================================== */
/* 🧩 UNIFIED PAYMENT HELPERS                            */
/* ===================================================== */

const PAYMENT_TYPES = {
  SUBSCRIPTION: "subscription",
  EVENT_TICKET: "event_ticket",
  ADVERTISEMENT: "advertisement",
};

const ZERO_DECIMAL_CURRENCIES = new Set([
  "BIF",
  "CLP",
  "DJF",
  "GNF",
  "JPY",
  "KMF",
  "KRW",
  "MGA",
  "PYG",
  "RWF",
  "UGX",
  "VND",
  "VUV",
  "XAF",
  "XOF",
  "XPF",
]);

function normalizeCurrency(value, fallback = "USD") {
  const currency = String(value || fallback)
    .trim()
    .toUpperCase();

  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new Error("Invalid payment currency");
  }

  return currency;
}

function amountToSmallestUnit(amount, currency) {
  const numericAmount = Number(amount);
  const normalizedCurrency = normalizeCurrency(currency);

  if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
    throw new Error("Invalid payment amount");
  }

  const multiplier = ZERO_DECIMAL_CURRENCIES.has(
    normalizedCurrency
  )
    ? 1
    : 100;

  const smallestUnit = Math.round(
    numericAmount * multiplier
  );

  if (!Number.isInteger(smallestUnit) || smallestUnit <= 0) {
    throw new Error("Invalid smallest-unit payment amount");
  }

  return smallestUnit;
}

function smallestUnitToAmount(amount, currency) {
  const normalizedCurrency = normalizeCurrency(currency);
  const multiplier = ZERO_DECIMAL_CURRENCIES.has(
    normalizedCurrency
  )
    ? 1
    : 100;

  return Number(amount || 0) / multiplier;
}

function amountsMatch(first, second) {
  return Math.abs(Number(first) - Number(second)) < 0.001;
}

function paymentPublicBaseUrl(req) {
  const configured = String(
    process.env.PAYMENT_PUBLIC_BASE_URL || ""
  )
    .trim()
    .replace(/\/+$/, "");

  if (configured) {
    return configured;
  }

  return `${req.protocol}://${req.get("host")}`;
}

function checkoutUrls(req) {
  const baseUrl = paymentPublicBaseUrl(req);

  return {
    successUrl:
      `${baseUrl}/payment-success?session_id={CHECKOUT_SESSION_ID}`,

    cancelUrl:
      `${baseUrl}/payment-cancel`,
  };
}

async function loadProfile(userId) {
  const {
    data: profile,
    error,
  } = await supabase
    .from("profiles")
    .select("id")
    .eq("id", userId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!profile) {
    throw new Error("User profile was not found");
  }

  return profile;
}

async function findPaymentByReference(reference) {
  const {
    data,
    error,
  } = await supabase
    .from("payments")
    .select(`
      id,
      user_id,
      plan,
      amount,
      currency,
      status,
      transaction_reference
    `)
    .eq("transaction_reference", reference)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data;
}

/*
 * Ticket and advertisement rows pre-date the unified
 * payment history model. Recording them in payments is
 * therefore best-effort so a history-table mismatch never
 * prevents an already-verified purchase from being completed.
 */
async function recordCommercePayment({
  userId,
  purchaseType,
  amount,
  currency,
  method,
  reference,
  stripePaymentIntentId,
}) {
  const row = {
    user_id: userId,
    plan: purchaseType,
    amount: Number(amount),
    currency: normalizeCurrency(currency),
    status: "completed",
    payment_method: method,
    transaction_reference: reference,
  };

  if (stripePaymentIntentId) {
    row.stripe_payment_intent_id =
      stripePaymentIntentId;
  }

  const {
    error,
  } = await supabase
    .from("payments")
    .insert(row);

  if (error && error.code !== "23505") {
    console.log(
      "⚠️ COMMERCE PAYMENT HISTORY WARNING:",
      error.message
    );
  }
}

async function recordAdminRevenue({
  source,
  amount,
  currency,
}) {
  const numericAmount = Number(amount);

  if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
    return;
  }

  const {
    error,
  } = await supabase
    .from("admin_revenue")
    .insert({
      source,
      amount: numericAmount,
      currency: normalizeCurrency(currency),
    });

  if (error) {
    throw error;
  }
}

async function finalizeStripeSubscription(paymentIntent) {
  const paymentIntentId = paymentIntent.id;
  const userId = paymentIntent.metadata?.user_id;
  const selectedPlan = String(
    paymentIntent.metadata?.plan || ""
  )
    .trim()
    .toLowerCase();

  if (
    !userId ||
    !ALLOWED_SUBSCRIPTION_PLANS.includes(selectedPlan)
  ) {
    throw new Error("Invalid Stripe subscription metadata");
  }

  const {
    data: existingPayment,
    error: existingPaymentError,
  } = await supabase
    .from("payments")
    .select("id")
    .eq(
      "stripe_payment_intent_id",
      paymentIntentId
    )
    .maybeSingle();

  if (existingPaymentError) {
    throw existingPaymentError;
  }

  if (existingPayment) {
    return {
      duplicate: true,
      paymentType: PAYMENT_TYPES.SUBSCRIPTION,
    };
  }

  const paidCurrency = normalizeCurrency(
    paymentIntent.currency
  );

  const paidAmount = smallestUnitToAmount(
    paymentIntent.amount_received,
    paidCurrency
  );

  const premiumUntil = new Date(
    Date.now() + 30 * 24 * 60 * 60 * 1000
  );

  const {
    error: profileError,
  } = await supabase
    .from("profiles")
    .update({
      is_premium: true,
      plan: selectedPlan,
      premium_until: premiumUntil.toISOString(),
    })
    .eq("id", userId);

  if (profileError) {
    throw profileError;
  }

  const {
    error: paymentError,
  } = await supabase
    .from("payments")
    .insert({
      user_id: userId,
      plan: selectedPlan,
      amount: paidAmount,
      currency: paidCurrency,
      status: "completed",
      stripe_payment_intent_id: paymentIntentId,
      payment_method: "Stripe",
      transaction_reference: paymentIntentId,
    });

  if (paymentError) {
    throw paymentError;
  }

  const {
    error: subscriptionError,
  } = await supabase
    .from("subscriptions")
    .insert({
      user_id: userId,
      plan: selectedPlan,
      status: "active",
      amount: paidAmount,
      currency: paidCurrency,
      expires_at: premiumUntil.toISOString(),
    });

  if (subscriptionError) {
    throw subscriptionError;
  }

  await recordAdminRevenue({
    source: selectedPlan,
    amount: paidAmount,
    currency: paidCurrency,
  });

  console.log(
    `✅ STRIPE SUBSCRIPTION ACTIVATED: ${userId} → ${selectedPlan}`
  );

  return {
    duplicate: false,
    paymentType: PAYMENT_TYPES.SUBSCRIPTION,
  };
}

async function loadTicketForPayment(ticketId) {
  const {
    data: ticket,
    error,
  } = await supabase
    .from("event_tickets")
    .select(`
      id,
      user_id,
      artist_id,
      event_title,
      venue,
      ticket_price,
      platform_fee,
      currency,
      payment_status,
      status,
      is_used
    `)
    .eq("id", ticketId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!ticket) {
    throw new Error("Event ticket was not found");
  }

  return ticket;
}

function ticketPricing(ticket) {
  const ticketPrice = Number(ticket.ticket_price || 0);
  const platformFee = Number(ticket.platform_fee || 0);
  const total = ticketPrice + platformFee;
  const currency = normalizeCurrency(
    ticket.currency || "USD"
  );

  if (
    !Number.isFinite(ticketPrice) ||
    ticketPrice < 0 ||
    !Number.isFinite(platformFee) ||
    platformFee < 0 ||
    !Number.isFinite(total) ||
    total <= 0
  ) {
    throw new Error("Event ticket price is invalid");
  }

  return {
    ticketPrice,
    platformFee,
    total,
    currency,
  };
}

async function finalizeStripeTicket(paymentIntent) {
  const userId = String(
    paymentIntent.metadata?.user_id || ""
  ).trim();

  const ticketId = String(
    paymentIntent.metadata?.reference_id ||
      paymentIntent.metadata?.ticket_id ||
      ""
  ).trim();

  if (!userId || !ticketId) {
    throw new Error("Invalid Stripe ticket metadata");
  }

  const ticket = await loadTicketForPayment(ticketId);

  if (String(ticket.user_id) !== userId) {
    throw new Error(
      "Stripe ticket ownership verification failed"
    );
  }

  if (
    String(ticket.payment_status || "")
      .toLowerCase() === "paid"
  ) {
    return {
      duplicate: true,
      paymentType: PAYMENT_TYPES.EVENT_TICKET,
    };
  }

  const pricing = ticketPricing(ticket);
  const paidCurrency = normalizeCurrency(
    paymentIntent.currency
  );
  const paidAmount = smallestUnitToAmount(
    paymentIntent.amount_received,
    paidCurrency
  );

  if (
    paidCurrency !== pricing.currency ||
    !amountsMatch(paidAmount, pricing.total)
  ) {
    throw new Error(
      "Stripe ticket amount or currency verification failed"
    );
  }

  const {
    error: updateError,
  } = await supabase
    .from("event_tickets")
    .update({
      payment_status: "paid",
      status: "valid",
    })
    .eq("id", ticketId)
    .eq("user_id", userId);

  if (updateError) {
    throw updateError;
  }

  await recordCommercePayment({
    userId,
    purchaseType: PAYMENT_TYPES.EVENT_TICKET,
    amount: paidAmount,
    currency: paidCurrency,
    method: "Stripe",
    reference: paymentIntent.id,
    stripePaymentIntentId: paymentIntent.id,
  });

  await recordAdminRevenue({
    source: "ticket_platform_fee",
    amount: pricing.platformFee,
    currency: paidCurrency,
  });

  console.log(
    `✅ STRIPE TICKET PAID: ${ticketId}`
  );

  return {
    duplicate: false,
    paymentType: PAYMENT_TYPES.EVENT_TICKET,
  };
}

async function loadCampaignForPayment(campaignId) {
  const {
    data: campaign,
    error,
  } = await supabase
    .from("ad_campaigns")
    .select(`
      id,
      ad_id,
      budget,
      currency,
      created_by,
      payment_status,
      payment_id,
      status
    `)
    .eq("id", campaignId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!campaign) {
    throw new Error("Advertisement campaign was not found");
  }

  return campaign;
}

function campaignPricing(campaign) {
  const amount = Number(campaign.budget);
  const currency = normalizeCurrency(
    campaign.currency || "USD"
  );

  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("Campaign budget is invalid");
  }

  return {
    amount,
    currency,
  };
}

async function finalizeStripeAdvertisement(paymentIntent) {
  const userId = String(
    paymentIntent.metadata?.user_id || ""
  ).trim();

  const campaignId = String(
    paymentIntent.metadata?.reference_id ||
      paymentIntent.metadata?.campaign_id ||
      ""
  ).trim();

  if (!userId || !campaignId) {
    throw new Error(
      "Invalid Stripe advertisement metadata"
    );
  }

  const campaign =
    await loadCampaignForPayment(campaignId);

  if (String(campaign.created_by) !== userId) {
    throw new Error(
      "Stripe campaign ownership verification failed"
    );
  }

  if (
    String(campaign.payment_status || "")
      .toLowerCase() === "paid"
  ) {
    return {
      duplicate: true,
      paymentType: PAYMENT_TYPES.ADVERTISEMENT,
    };
  }

  const pricing = campaignPricing(campaign);
  const paidCurrency = normalizeCurrency(
    paymentIntent.currency
  );
  const paidAmount = smallestUnitToAmount(
    paymentIntent.amount_received,
    paidCurrency
  );

  if (
    paidCurrency !== pricing.currency ||
    !amountsMatch(paidAmount, pricing.amount)
  ) {
    throw new Error(
      "Stripe advertisement amount or currency verification failed"
    );
  }

  const {
    error: updateError,
  } = await supabase
    .from("ad_campaigns")
    .update({
      payment_status: "paid",
      payment_id: paymentIntent.id,
    })
    .eq("id", campaignId)
    .eq("created_by", userId);

  if (updateError) {
    throw updateError;
  }

  await recordCommercePayment({
    userId,
    purchaseType: PAYMENT_TYPES.ADVERTISEMENT,
    amount: paidAmount,
    currency: paidCurrency,
    method: "Stripe",
    reference: paymentIntent.id,
    stripePaymentIntentId: paymentIntent.id,
  });

  await recordAdminRevenue({
    source: "advertisement",
    amount: paidAmount,
    currency: paidCurrency,
  });

  console.log(
    `✅ STRIPE AD CAMPAIGN PAID: ${campaignId}`
  );

  return {
    duplicate: false,
    paymentType: PAYMENT_TYPES.ADVERTISEMENT,
  };
}

async function finalizeStripePayment(paymentIntent) {
  const paymentType = String(
    paymentIntent.metadata?.payment_type ||
      PAYMENT_TYPES.SUBSCRIPTION
  )
    .trim()
    .toLowerCase();

  if (paymentType === PAYMENT_TYPES.SUBSCRIPTION) {
    return finalizeStripeSubscription(paymentIntent);
  }

  if (paymentType === PAYMENT_TYPES.EVENT_TICKET) {
    return finalizeStripeTicket(paymentIntent);
  }

  if (paymentType === PAYMENT_TYPES.ADVERTISEMENT) {
    return finalizeStripeAdvertisement(paymentIntent);
  }

  throw new Error(
    `Unsupported Stripe payment type: ${paymentType}`
  );
}

async function createPayPalOrder({
  description,
  amount,
  currency,
  metadata,
  returnUrl,
  cancelUrl,
}) {
  const accessToken = await getAccessToken();
  const normalizedCurrency =
    normalizeCurrency(currency);
  const numericAmount = Number(amount);

  if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
    throw new Error("Invalid PayPal order amount");
  }

  const response = await axios.post(
    `${PAYPAL_BASE_URL}/v2/checkout/orders`,
    {
      intent: "CAPTURE",
      purchase_units: [
        {
          custom_id: JSON.stringify(metadata),
          description,
          amount: {
            currency_code: normalizedCurrency,
            value: numericAmount.toFixed(2),
          },
        },
      ],
      application_context: {
        brand_name: "Tunevora",
        user_action: "PAY_NOW",
        return_url: returnUrl,
        cancel_url: cancelUrl,
      },
    },
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      timeout: 30000,
    }
  );

  return response.data;
}

async function capturePayPalOrder(orderId) {
  const accessToken = await getAccessToken();

  return axios.post(
    `${PAYPAL_BASE_URL}/v2/checkout/orders/${encodeURIComponent(
      orderId
    )}/capture`,
    {},
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      timeout: 30000,
    }
  );
}

function paypalCaptureData(captureResponse) {
  const purchaseUnit =
    captureResponse.data.purchase_units?.[0];

  const captureDetails =
    purchaseUnit?.payments?.captures?.[0];

  let metadata = {};

  try {
    metadata = JSON.parse(
      captureDetails?.custom_id ||
        purchaseUnit?.custom_id ||
        "{}"
    );
  } catch (_) {
    metadata = {};
  }

  return {
    status: captureResponse.data.status,
    purchaseUnit,
    captureDetails,
    metadata,
    amount: Number(
      captureDetails?.amount?.value
    ),
    currency: normalizeCurrency(
      captureDetails?.amount?.currency_code ||
        "USD"
    ),
  };
}

/* ===================================================== */
/* 🔍 DEBUG */
/* ===================================================== */

console.log(
  "SUPABASE URL:",
  process.env.SUPABASE_URL
);

console.log(
  "SUPABASE KEY EXISTS:",
  !!process.env.SUPABASE_SERVICE_ROLE_KEY
);

console.log(
  "PAYPAL CLIENT:",
  process.env.PAYPAL_CLIENT_ID
);

console.log(
  "PAYPAL SECRET:",
  process.env.PAYPAL_SECRET
    ? "EXISTS"
    : "MISSING"
);

console.log(
  "STRIPE SECRET EXISTS:",
  !!process.env.STRIPE_SECRET_KEY
);

console.log(
  "STRIPE WEBHOOK SECRET EXISTS:",
  !!process.env.STRIPE_WEBHOOK_SECRET
);

console.log(
  "GOOGLE PLAY PACKAGE:",
  GOOGLE_PLAY_PACKAGE_NAME
);

console.log(
  "GOOGLE PLAY PRODUCTS:",
  {
    standard: GOOGLE_PLAY_STANDARD_PRODUCT_ID,
    premium: GOOGLE_PLAY_PREMIUM_PRODUCT_ID,
  }
);

console.log(
  "GOOGLE PLAY SERVICE ACCOUNT EXISTS:",
  !!process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON
);

/* ===================================================== */
/* 🔔 STRIPE WEBHOOK                                     */
/* MUST STAY BEFORE bodyParser.json()                    */
/* ===================================================== */

app.post(
  "/stripe-webhook",
  express.raw({
    type: "application/json",
  }),
  async (req, res) => {
    const signature =
      req.headers["stripe-signature"];

    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        signature,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (error) {
      console.log(
        "❌ STRIPE SIGNATURE ERROR:",
        error.message
      );

      return res.status(400).send(
        `Webhook Error: ${error.message}`
      );
    }

    try {
      console.log(
        "🔥 STRIPE WEBHOOK EVENT:",
        event.type
      );

      if (
        event.type ===
        "payment_intent.succeeded"
      ) {
        const result =
          await finalizeStripePayment(
            event.data.object
          );

        return res.json({
          received: true,
          ...result,
        });
      }

      if (
        event.type ===
        "payment_intent.payment_failed"
      ) {
        const paymentIntent =
          event.data.object;

        console.log(
          "❌ STRIPE PAYMENT FAILED:",
          {
            id: paymentIntent.id,
            payment_type:
              paymentIntent.metadata?.payment_type ||
              PAYMENT_TYPES.SUBSCRIPTION,
          }
        );
      }

      return res.json({
        received: true,
      });
    } catch (error) {
      console.log(
        "❌ STRIPE WEBHOOK PROCESSING ERROR:",
        error
      );

      return res.status(500).json({
        error: error.message,
      });
    }
  }
);

/*
 * Normal JSON parser must come after
 * the Stripe webhook.
 */
app.use(bodyParser.json());


/* ===================================================== */
/* 🔑 PAYPAL CONFIGURATION                              */
/* ===================================================== */

const PAYPAL_BASE_URL = String(
  process.env.PAYPAL_BASE_URL ||
    "https://api-m.sandbox.paypal.com"
).replace(/\/+$/, "");

const ALLOWED_SUBSCRIPTION_PLANS = [
  "standard",
  "premium",
  "lossless",
  "hires",
];

const SUBSCRIPTION_PRICE_COLUMNS = {
  standard: "standard_price",
  premium: "premium_price",
  lossless: "price_lossless",
  hires: "price_hires",
};

/* ===================================================== */
/* 💵 LOAD TRUSTED SUBSCRIPTION PRICE                    */
/* ===================================================== */

async function loadSubscriptionPrice(
  plan,
  country
) {
  const normalizedPlan =
    String(plan || "")
      .trim()
      .toLowerCase();

  const normalizedCountry =
    String(country || "US")
      .trim()
      .toUpperCase();

  if (
    !ALLOWED_SUBSCRIPTION_PLANS.includes(
      normalizedPlan
    )
  ) {
    throw new Error(
      "Invalid subscription plan"
    );
  }

  const priceColumn =
    SUBSCRIPTION_PRICE_COLUMNS[
      normalizedPlan
    ];

  let {
    data: priceRow,
    error: priceError,
  } = await supabase
    .from("subscription_prices")
    .select(
      `country, currency, ${priceColumn}`
    )
    .eq(
      "country",
      normalizedCountry
    )
    .maybeSingle();

  if (priceError) {
    throw priceError;
  }

  /*
   * Use US pricing if the requested
   * country does not have a configured row.
   */
  if (
    !priceRow ||
    priceRow[priceColumn] == null
  ) {
    const {
      data: fallbackRow,
      error: fallbackError,
    } = await supabase
      .from("subscription_prices")
      .select(
        `country, currency, ${priceColumn}`
      )
      .eq("country", "US")
      .single();

    if (fallbackError) {
      throw fallbackError;
    }

    priceRow = fallbackRow;
  }

  const amount =
    Number(priceRow[priceColumn]);

  const currency =
    String(priceRow.currency || "")
      .trim()
      .toUpperCase();

  if (
    !Number.isFinite(amount) ||
    amount <= 0
  ) {
    throw new Error(
      "Invalid subscription price"
    );
  }

  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new Error(
      "Invalid subscription currency"
    );
  }

  return {
    plan: normalizedPlan,

    country:
      String(
        priceRow.country ||
          normalizedCountry
      ).toUpperCase(),

    amount,

    currency,
  };
}

/* ===================================================== */
/* 🔑 GET PAYPAL TOKEN                                   */
/* ===================================================== */

async function getAccessToken() {
  try {
    const paypalSecret =
      process.env.PAYPAL_SECRET ||
      process.env.PAYPAL_CLIENT_SECRET;

    if (
      !process.env.PAYPAL_CLIENT_ID ||
      !paypalSecret
    ) {
      throw new Error(
        "PayPal credentials are missing"
      );
    }

    const response = await axios({
      url:
        `${PAYPAL_BASE_URL}/v1/oauth2/token`,

      method: "post",

      auth: {
        username:
          process.env.PAYPAL_CLIENT_ID,

        password:
          paypalSecret,
      },

      headers: {
        "Content-Type":
          "application/x-www-form-urlencoded",
      },

      data:
        "grant_type=client_credentials",

      timeout: 30000,
    });

    return response.data.access_token;
  } catch (error) {
    console.log(
      "❌ PAYPAL TOKEN ERROR:",
      error.response?.data?.name ||
        error.message
    );

    throw new Error(
      "Could not authenticate with PayPal"
    );
  }
}

/* ===================================================== */
/* 💳 CREATE PAYPAL ORDER                                */
/* ===================================================== */

app.post(
  "/create-order",
  async (req, res) => {
    try {
      console.log(
        "🔥 CREATE PAYPAL ORDER HIT"
      );

      const {
        user_id,
        plan,
        country,
      } = req.body || {};

      if (!user_id || !plan) {
        return res.status(400).json({
          error:
            "Missing user_id or plan",
        });
      }

      const pricing =
        await loadSubscriptionPrice(
          plan,
          country
        );

      const {
        data: profile,
        error: profileError,
      } = await supabase
        .from("profiles")
        .select("id")
        .eq("id", user_id)
        .maybeSingle();

      if (profileError) {
        throw profileError;
      }

      if (!profile) {
        return res.status(404).json({
          error:
            "User profile was not found",
        });
      }

      const accessToken =
        await getAccessToken();

      const trustedMetadata = {
        user_id,

        plan:
          pricing.plan,

        country:
          pricing.country,

        amount:
          pricing.amount.toFixed(2),

        currency:
          pricing.currency,
      };

      const response = await axios.post(
        `${PAYPAL_BASE_URL}/v2/checkout/orders`,
        {
          intent: "CAPTURE",

          purchase_units: [
            {
              custom_id:
                JSON.stringify(
                  trustedMetadata
                ),

              description:
                `Tunevora ${pricing.plan} subscription - 30 days`,

              amount: {
                currency_code:
                  pricing.currency,

                value:
                  pricing.amount.toFixed(2),
              },
            },
          ],

          application_context: {
            brand_name:
              "Tunevora",

            user_action:
              "PAY_NOW",

            return_url:
              "tunevora://success",

            cancel_url:
              "tunevora://cancel",
          },
        },
        {
          headers: {
            Authorization:
              `Bearer ${accessToken}`,

            "Content-Type":
              "application/json",

            Prefer:
              "return=representation",
          },

          timeout: 30000,
        }
      );

      return res.json({
        ...response.data,

        amount:
          pricing.amount,

        currency:
          pricing.currency,
      });
    } catch (error) {
      console.log(
        "❌ CREATE PAYPAL ERROR:",
        error.response?.data?.name ||
          error.message
      );

      return res.status(500).json({
        error:
          "Create order failed",
      });
    }
  }
);

/* ===================================================== */
/* 💳 CAPTURE PAYPAL ORDER                               */
/* ===================================================== */

app.post(
  "/capture-order",
  async (req, res) => {
    try {
      console.log(
        "🔥 CAPTURE PAYPAL HIT"
      );

      const {
        orderID,
        user_id,
      } = req.body || {};

      if (!orderID || !user_id) {
        return res.status(400).json({
          error:
            "Missing orderID or user_id",
        });
      }

      /*
       * Prevent processing the same
       * PayPal order more than once.
       */
      const {
        data: existingPayment,
        error: existingPaymentError,
      } = await supabase
        .from("payments")
        .select(`
          id,
          user_id,
          plan,
          amount,
          currency,
          status,
          transaction_reference
        `)
        .eq(
          "transaction_reference",
          orderID
        )
        .maybeSingle();

      if (existingPaymentError) {
        throw existingPaymentError;
      }

      if (existingPayment) {
        if (
          existingPayment.user_id !==
          user_id
        ) {
          return res.status(403).json({
            error:
              "This PayPal order belongs to another user",
          });
        }

        return res.json({
          success: true,

          duplicate: true,

          message:
            `${existingPayment.plan} already activated`,

          amount:
            Number(
              existingPayment.amount
            ),

          currency:
            existingPayment.currency,

          transaction_reference:
            orderID,
        });
      }

      const accessToken =
        await getAccessToken();

      const capture =
        await axios.post(
          `${PAYPAL_BASE_URL}/v2/checkout/orders/${encodeURIComponent(
            orderID
          )}/capture`,
          {},
          {
            headers: {
              Authorization:
                `Bearer ${accessToken}`,

              "Content-Type":
                "application/json",

              Prefer:
                "return=representation",
            },

            timeout: 30000,
          }
        );

      if (
        capture.data.status !==
        "COMPLETED"
      ) {
        return res.status(400).json({
          error:
            "Payment not completed",

          status:
            capture.data.status,
        });
      }

      const purchaseUnit =
        capture.data
          .purchase_units?.[0];

      const captureDetails =
        purchaseUnit
          ?.payments
          ?.captures?.[0];

      let paymentInfo = {};

      try {
        paymentInfo = JSON.parse(
          captureDetails?.custom_id ||
            purchaseUnit?.custom_id ||
            "{}"
        );
      } catch (_) {
        paymentInfo = {};
      }

      const metadataUserId =
        String(
          paymentInfo.user_id || ""
        ).trim();

      const selectedPlan =
        String(
          paymentInfo.plan || ""
        )
          .trim()
          .toLowerCase();

      const metadataCountry =
        String(
          paymentInfo.country || "US"
        )
          .trim()
          .toUpperCase();

      if (
        metadataUserId !== user_id
      ) {
        return res.status(403).json({
          error:
            "PayPal order ownership verification failed",
        });
      }

      if (
        !ALLOWED_SUBSCRIPTION_PLANS.includes(
          selectedPlan
        )
      ) {
        return res.status(400).json({
          error:
            "Invalid PayPal plan",
        });
      }

      const expectedPricing =
        await loadSubscriptionPrice(
          selectedPlan,
          metadataCountry
        );

      const capturedAmount =
        Number(
          captureDetails
            ?.amount
            ?.value
        );

      const capturedCurrency =
        String(
          captureDetails
            ?.amount
            ?.currency_code ||
            ""
        )
          .trim()
          .toUpperCase();

      if (
        !Number.isFinite(
          capturedAmount
        ) ||
        capturedAmount <= 0
      ) {
        return res.status(400).json({
          error:
            "Invalid captured PayPal amount",
        });
      }

      const amountMatches =
        Math.abs(
          capturedAmount -
            expectedPricing.amount
        ) < 0.001;

      const currencyMatches =
        capturedCurrency ===
        expectedPricing.currency;

      if (
        !amountMatches ||
        !currencyMatches
      ) {
        console.log(
          "❌ PAYPAL PRICE VERIFICATION FAILED:",
          {
            orderID,

            expectedAmount:
              expectedPricing.amount,

            capturedAmount,

            expectedCurrency:
              expectedPricing.currency,

            capturedCurrency,
          }
        );

        return res.status(400).json({
          error:
            "PayPal payment amount or currency did not match the subscription price",
        });
      }

      const premiumUntil =
        new Date(
          Date.now() +
            30 *
              24 *
              60 *
              60 *
              1000
        );

      const {
        error: profileUpdateError,
      } = await supabase
        .from("profiles")
        .update({
          is_premium: true,

          plan:
            expectedPricing.plan,

          premium_until:
            premiumUntil.toISOString(),
        })
        .eq("id", user_id);

      if (profileUpdateError) {
        throw profileUpdateError;
      }

      const {
        error: paymentError,
      } = await supabase
        .from("payments")
        .insert({
          user_id,

          plan:
            expectedPricing.plan,

          amount:
            capturedAmount,

          currency:
            capturedCurrency,

          status:
            "completed",

          payment_method:
            "PayPal",

          transaction_reference:
            orderID,
        });

      if (paymentError) {
        if (
          paymentError.code === "23505"
        ) {
          return res.json({
            success: true,

            duplicate: true,

            message:
              `${expectedPricing.plan} already activated`,

            amount:
              capturedAmount,

            currency:
              capturedCurrency,

            transaction_reference:
              orderID,
          });
        }

        throw paymentError;
      }

      const {
        error: subscriptionError,
      } = await supabase
        .from("subscriptions")
        .insert({
          user_id,

          plan:
            expectedPricing.plan,

          status:
            "active",

          amount:
            capturedAmount,

          currency:
            capturedCurrency,

          expires_at:
            premiumUntil.toISOString(),
        });

      if (subscriptionError) {
        throw subscriptionError;
      }

      const {
        error: revenueError,
      } = await supabase
        .from("admin_revenue")
        .insert({
          source:
            expectedPricing.plan,

          amount:
            capturedAmount,

          currency:
            capturedCurrency,
        });

      if (revenueError) {
        throw revenueError;
      }

      console.log(
        `✅ PAYPAL ACTIVATED: ${user_id} → ${expectedPricing.plan}`
      );

      return res.json({
        success: true,

        message:
          `${expectedPricing.plan} activated`,

        amount:
          capturedAmount,

        currency:
          capturedCurrency,

        transaction_reference:
          orderID,

        premium_until:
          premiumUntil.toISOString(),
      });
    } catch (error) {
      const paypalIssue =
        error.response?.data;

      console.log(
        "❌ CAPTURE PAYPAL ERROR:",
        paypalIssue?.name ||
          error.message
      );

      return res.status(500).json({
        error:
          "Capture failed",
      });
    }
  }
);

/* ===================================================== */
/* 🌐 HOSTED PAYMENT RETURN PAGES                       */
/* ===================================================== */

app.get(
  "/payment-success",
  (req, res) => {
    const sessionId = String(
      req.query.session_id || ""
    );

    res
      .status(200)
      .type("html")
      .send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Tunevora Payment Complete</title>
  <style>
    body{margin:0;background:#08080a;color:#fff;font-family:Arial,sans-serif;display:grid;place-items:center;min-height:100vh}
    main{max-width:520px;margin:24px;padding:36px;border:1px solid #ffffff1a;border-radius:28px;background:linear-gradient(145deg,#34113d,#141419);text-align:center}
    .icon{font-size:54px}.muted{color:#ffffff99;line-height:1.6}.ref{color:#ffffff66;font-size:12px;word-break:break-all}
  </style>
</head>
<body>
  <main>
    <div class="icon">✓</div>
    <h1>Payment completed</h1>
    <p class="muted">Your payment was received. Tunevora is confirming the purchase securely. You may return to the app.</p>
    <p class="ref">${sessionId}</p>
  </main>
  <script>
    setTimeout(function () {
      window.location.href =
        "tunevora://success?session_id=" +
        encodeURIComponent(${JSON.stringify(sessionId)});
    }, 700);
  </script>
</body>
</html>`);
  }
);

app.get(
  "/payment-cancel",
  (req, res) => {
    res
      .status(200)
      .type("html")
      .send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Tunevora Payment Cancelled</title>
  <style>
    body{margin:0;background:#08080a;color:#fff;font-family:Arial,sans-serif;display:grid;place-items:center;min-height:100vh}
    main{max-width:520px;margin:24px;padding:36px;border:1px solid #ffffff1a;border-radius:28px;background:#17171c;text-align:center}
    .muted{color:#ffffff99;line-height:1.6}
  </style>
</head>
<body>
  <main>
    <h1>Payment cancelled</h1>
    <p class="muted">No charge was completed. You may close this page and return to Tunevora.</p>
  </main>
  <script>
    setTimeout(function () {
      window.location.href = "tunevora://cancel";
    }, 700);
  </script>
</body>
</html>`);
  }
);

/* ===================================================== */
/* 🌐 CREATE UNIFIED STRIPE CHECKOUT SESSION             */
/* WEB + WINDOWS                                         */
/* ===================================================== */

app.post(
  "/create-stripe-checkout-session",
  async (req, res) => {
    try {
      const {
        payment_type,
        user_id,
        plan,
        country,
        reference_id,
      } = req.body || {};

      const paymentType = String(
        payment_type || PAYMENT_TYPES.SUBSCRIPTION
      )
        .trim()
        .toLowerCase();

      if (!user_id) {
        return res.status(400).json({
          error: "Missing user_id",
        });
      }

      await loadProfile(user_id);

      let amount;
      let currency;
      let description;
      let metadata;

      if (
        paymentType ===
        PAYMENT_TYPES.SUBSCRIPTION
      ) {
        const pricing =
          await loadSubscriptionPrice(
            plan,
            country
          );

        amount = pricing.amount;
        currency = pricing.currency;
        description =
          `Tunevora ${pricing.plan} subscription - 30 days`;

        metadata = {
          payment_type:
            PAYMENT_TYPES.SUBSCRIPTION,
          user_id,
          plan: pricing.plan,
          country: pricing.country,
        };
      } else if (
        paymentType ===
        PAYMENT_TYPES.EVENT_TICKET
      ) {
        if (!reference_id) {
          return res.status(400).json({
            error: "Missing ticket reference_id",
          });
        }

        const ticket =
          await loadTicketForPayment(
            reference_id
          );

        if (
          String(ticket.user_id) !==
          String(user_id)
        ) {
          return res.status(403).json({
            error:
              "This ticket belongs to another user",
          });
        }

        if (
          String(ticket.payment_status || "")
            .toLowerCase() === "paid"
        ) {
          return res.status(409).json({
            error:
              "This ticket has already been paid",
          });
        }

        const pricing =
          ticketPricing(ticket);

        amount = pricing.total;
        currency = pricing.currency;
        description =
          `Tunevora ticket - ${ticket.event_title || "Event"}`;

        metadata = {
          payment_type:
            PAYMENT_TYPES.EVENT_TICKET,
          user_id,
          reference_id:
            String(ticket.id),
          ticket_id:
            String(ticket.id),
        };
      } else if (
        paymentType ===
        PAYMENT_TYPES.ADVERTISEMENT
      ) {
        if (!reference_id) {
          return res.status(400).json({
            error: "Missing campaign reference_id",
          });
        }

        const campaign =
          await loadCampaignForPayment(
            reference_id
          );

        if (
          String(campaign.created_by) !==
          String(user_id)
        ) {
          return res.status(403).json({
            error:
              "This campaign belongs to another user",
          });
        }

        if (
          String(campaign.payment_status || "")
            .toLowerCase() === "paid"
        ) {
          return res.status(409).json({
            error:
              "This campaign has already been paid",
          });
        }

        const pricing =
          campaignPricing(campaign);

        amount = pricing.amount;
        currency = pricing.currency;
        description =
          "Tunevora advertisement campaign";

        metadata = {
          payment_type:
            PAYMENT_TYPES.ADVERTISEMENT,
          user_id,
          reference_id:
            String(campaign.id),
          campaign_id:
            String(campaign.id),
          ad_id:
            String(campaign.ad_id || ""),
        };
      } else {
        return res.status(400).json({
          error: "Unsupported payment_type",
        });
      }

      const {
        successUrl,
        cancelUrl,
      } = checkoutUrls(req);

      const session =
        await stripe.checkout.sessions.create({
          mode: "payment",
          line_items: [
            {
              price_data: {
                currency:
                  currency.toLowerCase(),
                product_data: {
                  name: description,
                },
                unit_amount:
                  amountToSmallestUnit(
                    amount,
                    currency
                  ),
              },
              quantity: 1,
            },
          ],
          success_url: successUrl,
          cancel_url: cancelUrl,
          client_reference_id:
            String(user_id),
          metadata,
          payment_intent_data: {
            metadata,
          },
        });

      return res.json({
        success: true,
        sessionId: session.id,
        checkoutUrl: session.url,
        payment_type: paymentType,
        amount,
        currency,
      });
    } catch (error) {
      console.log(
        "❌ CREATE STRIPE CHECKOUT ERROR:",
        error
      );

      return res.status(500).json({
        error:
          error.message ||
          "Could not create Stripe Checkout session",
      });
    }
  }
);

/* ===================================================== */
/* 🎫 CREATE STRIPE TICKET PAYMENT INTENT                */
/* MOBILE                                                */
/* ===================================================== */

app.post(
  "/create-ticket-payment-intent",
  async (req, res) => {
    try {
      const {
        user_id,
        ticket_id,
      } = req.body || {};

      if (!user_id || !ticket_id) {
        return res.status(400).json({
          error:
            "Missing user_id or ticket_id",
        });
      }

      const ticket =
        await loadTicketForPayment(ticket_id);

      if (
        String(ticket.user_id) !==
        String(user_id)
      ) {
        return res.status(403).json({
          error:
            "This ticket belongs to another user",
        });
      }

      if (
        String(ticket.payment_status || "")
          .toLowerCase() === "paid"
      ) {
        return res.status(409).json({
          error:
            "This ticket has already been paid",
        });
      }

      const pricing =
        ticketPricing(ticket);

      const paymentIntent =
        await stripe.paymentIntents.create({
          amount: amountToSmallestUnit(
            pricing.total,
            pricing.currency
          ),
          currency:
            pricing.currency.toLowerCase(),
          automatic_payment_methods: {
            enabled: true,
          },
          metadata: {
            payment_type:
              PAYMENT_TYPES.EVENT_TICKET,
            user_id,
            reference_id:
              String(ticket.id),
            ticket_id:
              String(ticket.id),
          },
        });

      return res.json({
        clientSecret:
          paymentIntent.client_secret,
        paymentIntentId:
          paymentIntent.id,
        amount: pricing.total,
        currency: pricing.currency,
      });
    } catch (error) {
      console.log(
        "❌ CREATE TICKET PAYMENT INTENT ERROR:",
        error
      );

      return res.status(500).json({
        error:
          error.message ||
          "Could not create ticket payment",
      });
    }
  }
);

/* ===================================================== */
/* 💳 CREATE STRIPE PAYMENT INTENT */
/* ===================================================== */

app.post(
  "/create-payment-intent",
  async (req, res) => {
    try {
      console.log(
        "🔥 CREATE STRIPE PAYMENT INTENT HIT"
      );

      const {
        user_id,
        plan,
        country,
      } = req.body;

      const normalizedPlan =
        String(plan || "")
          .toLowerCase();

      const normalizedCountry =
        String(country || "US")
          .toUpperCase();

      const allowedPlans = [
        "standard",
        "premium",
        "lossless",
        "hires",
      ];

      if (
        !user_id ||
        !allowedPlans.includes(
          normalizedPlan
        )
      ) {
        return res.status(400).json({
          error:
            "Invalid user or plan",
        });
      }

      const priceColumn = {
        standard:
          "standard_price",

        premium:
          "premium_price",

        lossless:
          "price_lossless",

        hires:
          "price_hires",
      }[normalizedPlan];

      let {
        data: priceRow,
        error: priceError,
      } = await supabase
        .from("subscription_prices")
        .select(
          `country, currency, ${priceColumn}`
        )
        .eq(
          "country",
          normalizedCountry
        )
        .maybeSingle();

      if (priceError) {
        throw priceError;
      }

      /*
       * Use US/USD pricing when no
       * country row is available.
       */
      if (
        !priceRow ||
        priceRow[priceColumn] ==
          null
      ) {
        const {
          data: fallbackRow,
          error: fallbackError,
        } = await supabase
          .from(
            "subscription_prices"
          )
          .select(
            `country, currency, ${priceColumn}`
          )
          .eq("country", "US")
          .single();

        if (fallbackError) {
          throw fallbackError;
        }

        priceRow = fallbackRow;
      }

      const amount =
        Math.round(
          Number(
            priceRow[priceColumn]
          ) * 100
        );

      if (
        !Number.isInteger(amount) ||
        amount <= 0
      ) {
        throw new Error(
          "Invalid subscription price"
        );
      }

      const paymentCurrency =
        String(
          priceRow.currency
        ).toLowerCase();

      const paymentIntent =
        await stripe
          .paymentIntents
          .create({
            amount,

            currency:
               paymentCurrency,

            automatic_payment_methods: {
              enabled: true,
            },

            metadata: {
              payment_type:
                PAYMENT_TYPES.SUBSCRIPTION,

              user_id,

              plan:
                normalizedPlan,

              country:
                priceRow.country,
            },
          });

      return res.json({
        clientSecret:
          paymentIntent.client_secret,

        paymentIntentId:
          paymentIntent.id,

        amount:
          amount / 100,

        currency:
          priceRow.currency,
      });
    } catch (error) {
      console.log(
        "❌ STRIPE ERROR:",
        error.message
      );

      return res.status(500).json({
        error:
          error.message,
      });
    }
  }
);

/* ===================================================== */
/* 📢 CREATE STRIPE AD PAYMENT INTENT */
/* ===================================================== */

app.post(
  "/create-ad-payment-intent",
  async (req, res) => {
    try {
      console.log(
        "🔥 CREATE AD PAYMENT INTENT"
      );

      const {
        user_id,
        campaign_id,
      } = req.body;

      /* --------------------------------------------- */
      /* Validate required request data                */
      /* --------------------------------------------- */

      if (!user_id || !campaign_id) {
        return res.status(400).json({
          error:
            "Missing user_id or campaign_id",
        });
      }

      /* --------------------------------------------- */
      /* Load real campaign values from Supabase       */
      /* --------------------------------------------- */

      const {
        data: campaign,
        error: campaignError,
      } = await supabase
        .from("ad_campaigns")
        .select(`
          id,
          ad_id,
          budget,
          currency,
          created_by,
          payment_status,
          payment_id,
          status
        `)
        .eq("id", campaign_id)
        .maybeSingle();

      if (campaignError) {
        console.log(
          "❌ LOAD AD CAMPAIGN ERROR:",
          campaignError
        );

        return res.status(500).json({
          error:
            "Could not load advertisement campaign",
          details:
            campaignError.message,
        });
      }

      if (!campaign) {
        return res.status(404).json({
          error:
            "Advertisement campaign not found",
        });
      }

      /* --------------------------------------------- */
      /* Verify the campaign belongs to this user      */
      /* --------------------------------------------- */
      
      console.log(
         "🔐 CAMPAIGN OWNERSHIP CHECK:",
         {
          campaign_created_by:
            campaign.created_by,
          request_user_id:
            user_id,
          matches:
            campaign.created_by === user_id,
        }
      );    

      if (campaign.created_by !== user_id) {
        return res.status(403).json({
          error:
            "You are not allowed to pay for this campaign",
        });
      }

      /* --------------------------------------------- */
      /* Prevent paying an already-paid campaign       */
      /* --------------------------------------------- */

      if (
        String(
          campaign.payment_status || ""
        ).toLowerCase() === "paid"
      ) {
        return res.status(409).json({
          error:
            "This campaign has already been paid",
          payment_id:
            campaign.payment_id,
        });
      }

      /* --------------------------------------------- */
      /* Use server-side database budget               */
      /* --------------------------------------------- */

      const campaignBudget =
        Number(campaign.budget);

      if (
        !Number.isFinite(campaignBudget) ||
        campaignBudget <= 0
      ) {
        return res.status(400).json({
          error:
            "Campaign budget is invalid",
        });
      }

      const paymentCurrency =
        String(campaign.currency || "USD")
          .trim()
          .toUpperCase();

      const stripeCurrency =
        paymentCurrency.toLowerCase();

      /*
       * Stripe expects the amount in the
       * smallest currency unit.
       *
       * Example:
       * 100 AED -> 10000 fils
       */
      const amountInSmallestUnit =
        Math.round(
          campaignBudget * 100
        );

      if (
        !Number.isInteger(
          amountInSmallestUnit
        ) ||
        amountInSmallestUnit <= 0
      ) {
        return res.status(400).json({
          error:
            "Invalid campaign payment amount",
        });
      }

      console.log(
        "📢 AD CAMPAIGN PAYMENT:",
        {
          campaign_id:
            campaign.id,
          user_id,
          budget:
            campaignBudget,
          currency:
            paymentCurrency,
          smallest_unit:
            amountInSmallestUnit,
        }
      );

      /* --------------------------------------------- */
      /* Create Stripe PaymentIntent                   */
      /* --------------------------------------------- */

      const paymentIntent =
        await stripe
          .paymentIntents
          .create({
            amount:
              amountInSmallestUnit,

            currency:
              stripeCurrency,

            automatic_payment_methods: {
              enabled: true,
            },

            metadata: {
              payment_type:
                PAYMENT_TYPES.ADVERTISEMENT,

              user_id,

              reference_id:
                campaign.id,

              campaign_id:
                campaign.id,

              ad_id:
                campaign.ad_id || "",

              campaign_budget:
                campaignBudget.toFixed(2),

              campaign_currency:
                paymentCurrency.toUpperCase(),
            },
          });

      /* --------------------------------------------- */
      /* Save PaymentIntent ID before payment          */
      /* --------------------------------------------- */

      const {
        error: updateError,
      } = await supabase
        .from("ad_campaigns")
        .update({
          payment_id:
            paymentIntent.id,
        })
        .eq("id", campaign.id)
        .eq("created_by", user_id);

      if (updateError) {
        console.log(
          "❌ SAVE AD PAYMENT ID ERROR:",
          updateError
        );

        /*
         * Cancel the PaymentIntent so we do not leave
         * an untracked payment open in Stripe.
         */
        try {
          await stripe
            .paymentIntents
            .cancel(paymentIntent.id);
        } catch (cancelError) {
          console.log(
            "⚠️ PAYMENT INTENT CANCEL ERROR:",
            cancelError.message
          );
        }

        return res.status(500).json({
          error:
            "Could not prepare advertisement payment",
          details:
            updateError.message,
        });
      }

      return res.json({
        clientSecret:
          paymentIntent.client_secret,

        paymentIntentId:
          paymentIntent.id,

        amount:
          campaignBudget,

        currency:
          paymentCurrency,
      });
    } catch (error) {
      console.log(
        "❌ AD STRIPE ERROR:",
        error
      );

      return res.status(500).json({
        error:
          error.message ||
          "Advertisement payment intent failed",
      });
    }
  }
);



/* ===================================================== */
/* 🎫 CREATE PAYPAL TICKET ORDER                         */
/* ===================================================== */

app.post(
  "/create-ticket-order",
  async (req, res) => {
    try {
      const {
        user_id,
        ticket_id,
      } = req.body || {};

      if (!user_id || !ticket_id) {
        return res.status(400).json({
          error:
            "Missing user_id or ticket_id",
        });
      }

      const ticket =
        await loadTicketForPayment(ticket_id);

      if (
        String(ticket.user_id) !==
        String(user_id)
      ) {
        return res.status(403).json({
          error:
            "This ticket belongs to another user",
        });
      }

      if (
        String(ticket.payment_status || "")
          .toLowerCase() === "paid"
      ) {
        return res.status(409).json({
          error:
            "This ticket has already been paid",
        });
      }

      const pricing =
        ticketPricing(ticket);

      const metadata = {
        payment_type:
          PAYMENT_TYPES.EVENT_TICKET,
        user_id,
        reference_id:
          String(ticket.id),
        ticket_id:
          String(ticket.id),
      };

      const order = await createPayPalOrder({
        description:
          `Tunevora ticket - ${ticket.event_title || "Event"}`,
        amount: pricing.total,
        currency: pricing.currency,
        metadata,
        returnUrl: "tunevora://ticket-success",
        cancelUrl: "tunevora://ticket-cancel",
      });

      return res.json({
        ...order,
        amount: pricing.total,
        currency: pricing.currency,
      });
    } catch (error) {
      console.log(
        "❌ CREATE PAYPAL TICKET ERROR:",
        error.response?.data ||
          error.message
      );

      return res.status(500).json({
        error:
          error.message ||
          "Could not create ticket order",
      });
    }
  }
);

/* ===================================================== */
/* 🎫 CAPTURE PAYPAL TICKET ORDER                        */
/* ===================================================== */

app.post(
  "/capture-ticket-order",
  async (req, res) => {
    try {
      const {
        orderID,
        user_id,
      } = req.body || {};

      if (!orderID || !user_id) {
        return res.status(400).json({
          error:
            "Missing orderID or user_id",
        });
      }

      const existing =
        await findPaymentByReference(
          orderID
        );

      if (existing) {
        if (
          String(existing.user_id) !==
          String(user_id)
        ) {
          return res.status(403).json({
            error:
              "This order belongs to another user",
          });
        }

        return res.json({
          success: true,
          duplicate: true,
          transaction_reference:
            orderID,
        });
      }

      const captureResponse =
        await capturePayPalOrder(orderID);

      const captured =
        paypalCaptureData(
          captureResponse
        );

      if (captured.status !== "COMPLETED") {
        return res.status(400).json({
          error:
            "Ticket payment was not completed",
          status: captured.status,
        });
      }

      const paymentType = String(
        captured.metadata.payment_type ||
          ""
      )
        .trim()
        .toLowerCase();

      const metadataUserId = String(
        captured.metadata.user_id || ""
      ).trim();

      const ticketId = String(
        captured.metadata.reference_id ||
          captured.metadata.ticket_id ||
          ""
      ).trim();

      if (
        paymentType !==
          PAYMENT_TYPES.EVENT_TICKET ||
        metadataUserId !==
          String(user_id) ||
        !ticketId
      ) {
        return res.status(403).json({
          error:
            "PayPal ticket metadata verification failed",
        });
      }

      const ticket =
        await loadTicketForPayment(ticketId);
      const pricing =
        ticketPricing(ticket);

      if (
        String(ticket.user_id) !==
        String(user_id)
      ) {
        return res.status(403).json({
          error:
            "Ticket ownership verification failed",
        });
      }

      if (
        captured.currency !==
          pricing.currency ||
        !amountsMatch(
          captured.amount,
          pricing.total
        )
      ) {
        return res.status(400).json({
          error:
            "PayPal ticket amount or currency did not match",
        });
      }

      const {
        error: updateError,
      } = await supabase
        .from("event_tickets")
        .update({
          payment_status: "paid",
          status: "valid",
        })
        .eq("id", ticketId)
        .eq("user_id", user_id);

      if (updateError) {
        throw updateError;
      }

      await recordCommercePayment({
        userId: user_id,
        purchaseType:
          PAYMENT_TYPES.EVENT_TICKET,
        amount: captured.amount,
        currency: captured.currency,
        method: "PayPal",
        reference: orderID,
      });

      await recordAdminRevenue({
        source: "ticket_platform_fee",
        amount: pricing.platformFee,
        currency: captured.currency,
      });

      return res.json({
        success: true,
        ticket_id: ticketId,
        amount: captured.amount,
        currency: captured.currency,
        transaction_reference:
          orderID,
      });
    } catch (error) {
      console.log(
        "❌ CAPTURE PAYPAL TICKET ERROR:",
        error.response?.data ||
          error.message
      );

      return res.status(500).json({
        error:
          error.message ||
          "Ticket capture failed",
      });
    }
  }
);

/* ===================================================== */
/* 📢 CREATE PAYPAL AD ORDER                             */
/* ===================================================== */

app.post(
  "/create-ad-order",
  async (req, res) => {
    try {
      const {
        user_id,
        campaign_id,
      } = req.body || {};

      if (!user_id || !campaign_id) {
        return res.status(400).json({
          error:
            "Missing user_id or campaign_id",
        });
      }

      const campaign =
        await loadCampaignForPayment(
          campaign_id
        );

      if (
        String(campaign.created_by) !==
        String(user_id)
      ) {
        return res.status(403).json({
          error:
            "This campaign belongs to another user",
        });
      }

      if (
        String(campaign.payment_status || "")
          .toLowerCase() === "paid"
      ) {
        return res.status(409).json({
          error:
            "This campaign has already been paid",
        });
      }

      const pricing =
        campaignPricing(campaign);

      const metadata = {
        payment_type:
          PAYMENT_TYPES.ADVERTISEMENT,
        user_id,
        reference_id:
          String(campaign.id),
        campaign_id:
          String(campaign.id),
        ad_id:
          String(campaign.ad_id || ""),
      };

      const order = await createPayPalOrder({
        description:
          "Tunevora advertisement campaign",
        amount: pricing.amount,
        currency: pricing.currency,
        metadata,
        returnUrl: "tunevora://ad-success",
        cancelUrl: "tunevora://ad-cancel",
      });

      const {
        error: updateError,
      } = await supabase
        .from("ad_campaigns")
        .update({
          payment_id: order.id,
        })
        .eq("id", campaign.id)
        .eq("created_by", user_id);

      if (updateError) {
        throw updateError;
      }

      return res.json({
        ...order,
        amount: pricing.amount,
        currency: pricing.currency,
      });
    } catch (error) {
      console.log(
        "❌ CREATE PAYPAL AD ERROR:",
        error.response?.data ||
          error.message
      );

      return res.status(500).json({
        error:
          error.message ||
          "Could not create advertisement order",
      });
    }
  }
);

/* ===================================================== */
/* 📢 CAPTURE PAYPAL AD ORDER                            */
/* ===================================================== */

app.post(
  "/capture-ad-order",
  async (req, res) => {
    try {
      const {
        orderID,
        user_id,
      } = req.body || {};

      if (!orderID || !user_id) {
        return res.status(400).json({
          error:
            "Missing orderID or user_id",
        });
      }

      const existing =
        await findPaymentByReference(
          orderID
        );

      if (existing) {
        if (
          String(existing.user_id) !==
          String(user_id)
        ) {
          return res.status(403).json({
            error:
              "This order belongs to another user",
          });
        }

        return res.json({
          success: true,
          duplicate: true,
          transaction_reference:
            orderID,
        });
      }

      const captureResponse =
        await capturePayPalOrder(orderID);

      const captured =
        paypalCaptureData(
          captureResponse
        );

      if (captured.status !== "COMPLETED") {
        return res.status(400).json({
          error:
            "Advertisement payment was not completed",
          status: captured.status,
        });
      }

      const paymentType = String(
        captured.metadata.payment_type ||
          ""
      )
        .trim()
        .toLowerCase();

      const metadataUserId = String(
        captured.metadata.user_id || ""
      ).trim();

      const campaignId = String(
        captured.metadata.reference_id ||
          captured.metadata.campaign_id ||
          ""
      ).trim();

      if (
        paymentType !==
          PAYMENT_TYPES.ADVERTISEMENT ||
        metadataUserId !==
          String(user_id) ||
        !campaignId
      ) {
        return res.status(403).json({
          error:
            "PayPal advertisement metadata verification failed",
        });
      }

      const campaign =
        await loadCampaignForPayment(
          campaignId
        );
      const pricing =
        campaignPricing(campaign);

      if (
        String(campaign.created_by) !==
        String(user_id)
      ) {
        return res.status(403).json({
          error:
            "Campaign ownership verification failed",
        });
      }

      if (
        captured.currency !==
          pricing.currency ||
        !amountsMatch(
          captured.amount,
          pricing.amount
        )
      ) {
        return res.status(400).json({
          error:
            "PayPal advertisement amount or currency did not match",
        });
      }

      const {
        error: updateError,
      } = await supabase
        .from("ad_campaigns")
        .update({
          payment_status: "paid",
          payment_id: orderID,
        })
        .eq("id", campaignId)
        .eq("created_by", user_id);

      if (updateError) {
        throw updateError;
      }

      await recordCommercePayment({
        userId: user_id,
        purchaseType:
          PAYMENT_TYPES.ADVERTISEMENT,
        amount: captured.amount,
        currency: captured.currency,
        method: "PayPal",
        reference: orderID,
      });

      await recordAdminRevenue({
        source: "advertisement",
        amount: captured.amount,
        currency: captured.currency,
      });

      return res.json({
        success: true,
        campaign_id: campaignId,
        amount: captured.amount,
        currency: captured.currency,
        transaction_reference:
          orderID,
      });
    } catch (error) {
      console.log(
        "❌ CAPTURE PAYPAL AD ERROR:",
        error.response?.data ||
          error.message
      );

      return res.status(500).json({
        error:
          error.message ||
          "Advertisement capture failed",
      });
    }
  }
);


/* ===================================================== */
/* 🤖 VERIFY GOOGLE PLAY SUBSCRIPTION                    */
/* ===================================================== */

app.post(
  "/verify-google-play-purchase",
  async (req, res) => {
    try {
      const authenticatedUser =
        await authenticateSupabaseRequest(req);

      const {
        product_id,
        purchase_token,
      } = req.body || {};

      const productId = String(
        product_id || ""
      ).trim();

      const purchaseToken = String(
        purchase_token || ""
      ).trim();

      if (!productId || !purchaseToken) {
        return res.status(400).json({
          error:
            "Missing product_id or purchase_token",
        });
      }

      const plan =
        GOOGLE_PLAY_PRODUCT_TO_PLAN.get(productId);

      if (!plan) {
        return res.status(400).json({
          error:
            "Unsupported Google Play product",
        });
      }

      await loadProfile(authenticatedUser.id);

      const publisher =
        getGooglePlayPublisherClient();

      const googleResponse =
        await publisher.purchases.subscriptionsv2.get({
          packageName:
            GOOGLE_PLAY_PACKAGE_NAME,
          token: purchaseToken,
        });

      const purchase =
        googleResponse.data || {};

      const lineItems = Array.isArray(
        purchase.lineItems
      )
        ? purchase.lineItems
        : [];

      const verifiedLineItem =
        lineItems.find(
          (item) =>
            String(item?.productId || "") ===
            productId
        );

      if (!verifiedLineItem) {
        return res.status(400).json({
          error:
            "Google Play product verification failed",
        });
      }

      const subscriptionState = String(
        purchase.subscriptionState || ""
      );

      if (
        !GOOGLE_PLAY_ENTITLED_STATES.has(
          subscriptionState
        )
      ) {
        return res.status(409).json({
          error:
            "Google Play subscription is not entitled",
          subscription_state:
            subscriptionState,
        });
      }

      const expiryTime =
        latestGooglePlayExpiry(lineItems);

      if (expiryTime.getTime() <= Date.now()) {
        return res.status(409).json({
          error:
            "Google Play subscription has expired",
          subscription_state:
            subscriptionState,
          expiry_time:
            expiryTime.toISOString(),
        });
      }

      const googleAccountId = String(
        purchase.externalAccountIdentifiers
          ?.obfuscatedExternalAccountId ||
          ""
      ).trim();

      if (
        googleAccountId &&
        googleAccountId !== authenticatedUser.id
      ) {
        return res.status(403).json({
          error:
            "Google Play purchase belongs to another Tunevora account",
        });
      }

      if (
        String(purchase.acknowledgementState) ===
        "ACKNOWLEDGEMENT_STATE_PENDING"
      ) {
        await publisher.purchases.subscriptions.acknowledge({
          packageName:
            GOOGLE_PLAY_PACKAGE_NAME,
          subscriptionId: productId,
          token: purchaseToken,
          requestBody: {},
        });
      }

      const transactionReference =
        googlePlayReference(purchaseToken);

      const {
        data: existingPayment,
        error: existingPaymentError,
      } = await supabase
        .from("payments")
        .select("id, user_id")
        .eq(
          "transaction_reference",
          transactionReference
        )
        .maybeSingle();

      if (existingPaymentError) {
        throw existingPaymentError;
      }

      if (
        existingPayment &&
        String(existingPayment.user_id) !==
          String(authenticatedUser.id)
      ) {
        return res.status(403).json({
          error:
            "Google Play purchase is already linked to another user",
        });
      }

      const { error: profileError } =
        await supabase
          .from("profiles")
          .update({
            is_premium: true,
            plan,
            premium_until:
              expiryTime.toISOString(),
          })
          .eq("id", authenticatedUser.id);

      if (profileError) {
        throw profileError;
      }

      await syncGooglePlaySubscriptionPeriod({
        userId: authenticatedUser.id,
        plan,
        expiryTime,
      });

      if (!existingPayment) {
        const { error: paymentError } =
          await supabase
            .from("payments")
            .insert({
              user_id:
                authenticatedUser.id,
              plan,
              amount: 0,
              currency: "AED",
              status: "completed",
              payment_method:
                "Google Play",
              transaction_reference:
                transactionReference,
            });

        if (
          paymentError &&
          paymentError.code !== "23505"
        ) {
          throw paymentError;
        }
      }

      console.log(
        "✅ GOOGLE PLAY SUBSCRIPTION VERIFIED:",
        {
          user_id: authenticatedUser.id,
          product_id: productId,
          plan,
          state: subscriptionState,
          expiry_time:
            expiryTime.toISOString(),
          test_purchase:
            !!purchase.testPurchase,
        }
      );

      return res.json({
        success: true,
        duplicate: !!existingPayment,
        plan,
        product_id: productId,
        subscription_state:
          subscriptionState,
        premium_until:
          expiryTime.toISOString(),
        acknowledged:
          String(purchase.acknowledgementState) !==
          "ACKNOWLEDGEMENT_STATE_PENDING",
        test_purchase:
          !!purchase.testPurchase,
      });
    } catch (error) {
      const statusCode =
        Number(error.statusCode) ||
        Number(error.code) ||
        500;

      console.log("========== GOOGLE PLAY ERROR ==========");
      console.log(error);

      if (error.response) {
       console.log(error.response.data);
      }

      if (error.errors) {
       console.log(error.errors);
      }

      console.log("======================================");

      if (statusCode === 401 || statusCode === 403) {
        return res.status(statusCode).json({
          error:
            error.message ||
            "Google Play authorization failed",
        });
      }

      if (statusCode === 404) {
        return res.status(404).json({
          error:
            "Google Play purchase was not found",
        });
      }

      return res.status(500).json({
        error:
          error.message ||
          "Google Play purchase verification failed",
      });
    }
  }
);


/* ===================================================== */
/* 💰 CALCULATE MONTHLY PREMIUM ARTIST PAYOUTS            */
/* ===================================================== */

app.post(
  "/calculate-premium-payouts",
  async (req, res) => {
    try {
      console.log(
        "💰 CALCULATE PREMIUM PAYOUTS HIT"
      );

     /* --------------------------------------------- */
/* Secure Supabase admin authentication          */
/* --------------------------------------------- */

const authorizationHeader =
  String(req.headers.authorization || "");

const accessToken =
  authorizationHeader.startsWith("Bearer ")
    ? authorizationHeader.substring(7).trim()
    : "";

if (!accessToken) {
  return res.status(401).json({
    error: "Missing admin authentication token",
  });
}

const {
  data: authenticatedUserData,
  error: authenticatedUserError,
} = await supabase.auth.getUser(accessToken);

if (
  authenticatedUserError ||
  !authenticatedUserData?.user
) {
  console.log(
    "❌ INVALID ADMIN TOKEN:",
    authenticatedUserError
  );

  return res.status(401).json({
    error: "Invalid or expired admin session",
  });
}

const authenticatedUser =
  authenticatedUserData.user;

const authenticatedEmail =
  String(
    authenticatedUser.email || ""
  )
    .trim()
    .toLowerCase();

if (
  authenticatedEmail !==
  "tunevora@gmail.com"
) {
  console.log(
    "❌ NON-ADMIN PAYOUT REQUEST:",
    authenticatedEmail
  );

  return res.status(403).json({
    error:
      "Only the Tunevora administrator can calculate payouts",
  });
}

console.log(
  "✅ ADMIN PAYOUT AUTHENTICATED:",
  authenticatedEmail
);


      /* --------------------------------------------- */
      /* Select month and year                        */
      /* Defaults to previous month                   */
      /* --------------------------------------------- */

      const now = new Date();

      const previousMonthDate =
        new Date(
          Date.UTC(
            now.getUTCFullYear(),
            now.getUTCMonth() - 1,
            1
          )
        );

      const selectedMonth =
        Number(
          req.body?.month ||
            previousMonthDate.getUTCMonth() +
              1
        );

      const selectedYear =
        Number(
          req.body?.year ||
            previousMonthDate.getUTCFullYear()
        );

      if (
        !Number.isInteger(selectedMonth) ||
        selectedMonth < 1 ||
        selectedMonth > 12
      ) {
        return res.status(400).json({
          error:
            "Month must be between 1 and 12",
        });
      }

      if (
        !Number.isInteger(selectedYear) ||
        selectedYear < 2020 ||
        selectedYear > 2100
      ) {
        return res.status(400).json({
          error:
            "Invalid payout year",
        });
      }

      const periodStart =
        new Date(
          Date.UTC(
            selectedYear,
            selectedMonth - 1,
            1
          )
        );

      const periodEnd =
        new Date(
          Date.UTC(
            selectedYear,
            selectedMonth,
            1
          )
        );

      const startIso =
        periodStart.toISOString();

      const endIso =
        periodEnd.toISOString();

      console.log(
        "📅 PAYOUT PERIOD:",
        {
          month: selectedMonth,
          year: selectedYear,
          start: startIso,
          end: endIso,
        }
      );

      const paidPlans = [
        "standard",
        "premium",
        "lossless",
        "hires",
      ];

      /* --------------------------------------------- */
      /* Helper: load all rows using pagination        */
      /* --------------------------------------------- */

      async function loadAllRows(
        queryBuilder
      ) {
        const pageSize = 1000;

        let from = 0;
        let allRows = [];

        while (true) {
          const {
            data,
            error,
          } = await queryBuilder(
            from,
            from + pageSize - 1
          );

          if (error) {
            throw error;
          }

          const rows =
            Array.isArray(data)
              ? data
              : [];

          allRows =
            allRows.concat(rows);

          if (rows.length < pageSize) {
            break;
          }

          from += pageSize;
        }

        return allRows;
      }

      /* --------------------------------------------- */
      /* Load completed subscription payments          */
      /* --------------------------------------------- */

      const paymentRows =
        await loadAllRows(
          async (from, to) =>
            await supabase
              .from("payments")
              .select(`
                id,
                user_id,
                plan,
                amount,
                currency,
                status,
                created_at
              `)
              .eq(
                "status",
                "completed"
              )
              .in(
                "plan",
                paidPlans
              )
              .gte(
                "created_at",
                startIso
              )
              .lt(
                "created_at",
                endIso
              )
              .range(from, to)
        );

      const validPayments =
        paymentRows.filter((payment) => {
          const amount =
            Number(payment.amount);

          return (
            Number.isFinite(amount) &&
            amount > 0
          );
        });

      /* --------------------------------------------- */
      /* Prevent incorrect mixed-currency calculations */
      /* --------------------------------------------- */

      const paymentCurrencies =
        [
          ...new Set(
            validPayments.map(
              (payment) =>
                String(
                  payment.currency ||
                    "USD"
                ).toUpperCase()
            )
          ),
        ];

      if (
        paymentCurrencies.length > 1
      ) {
        return res.status(409).json({
          error:
            "Multiple payment currencies were found for this month",
          currencies:
            paymentCurrencies,
          message:
            "Connect the live currency conversion service before calculating mixed-currency payouts",
        });
      }

      const payoutCurrency =
        paymentCurrencies[0] ||
        "USD";

      const totalPremiumRevenue =
        validPayments.reduce(
          (total, payment) =>
            total +
            Number(payment.amount || 0),
          0
        );

      /*
       * Tunevora model:
       * 60% platform
       * 40% artist pool
       *
       * Use integer cents to avoid
       * floating-point payout errors.
       */

      const totalRevenueCents =
        Math.round(
          totalPremiumRevenue * 100
        );

      const artistPoolCents =
        Math.round(
          totalRevenueCents * 0.4
        );

      const platformShareCents =
        totalRevenueCents -
        artistPoolCents;

      /* --------------------------------------------- */
      /* Load subscriptions overlapping this month     */
      /* --------------------------------------------- */

      const subscriptionRows =
        await loadAllRows(
          async (from, to) =>
            await supabase
              .from("subscriptions")
              .select(`
                user_id,
                plan,
                status,
                created_at,
                expires_at
              `)
              .in(
                "plan",
                paidPlans
              )
              .lt(
                "created_at",
                endIso
              )
              .gte(
                "expires_at",
                startIso
              )
              .range(from, to)
        );

      /*
       * Store each user's subscription
       * start/end periods.
       */

      const subscriptionPeriodsByUser =
        new Map();

      for (
        const subscription
        of subscriptionRows
      ) {
        const userId =
          subscription.user_id;

        if (!userId) {
          continue;
        }

        const subscriptionStart =
          new Date(
            subscription.created_at
          );

        const subscriptionEnd =
          new Date(
            subscription.expires_at
          );

        if (
          Number.isNaN(
            subscriptionStart.getTime()
          ) ||
          Number.isNaN(
            subscriptionEnd.getTime()
          )
        ) {
          continue;
        }

        if (
          !subscriptionPeriodsByUser.has(
            userId
          )
        ) {
          subscriptionPeriodsByUser.set(
            userId,
            []
          );
        }

        subscriptionPeriodsByUser
          .get(userId)
          .push({
            start:
              subscriptionStart.getTime(),

            end:
              subscriptionEnd.getTime(),
          });
      }

      /* --------------------------------------------- */
      /* Load listening activity for selected month    */
      /* --------------------------------------------- */

      const playRows =
        await loadAllRows(
          async (from, to) =>
            await supabase
              .from("play_analytics")
              .select(`
                id,
                song_id,
                artist_id,
                user_id,
                listened_seconds,
                song_duration_seconds,
                created_at
              `)
              .gte(
                "created_at",
                startIso
              )
              .lt(
                "created_at",
                endIso
              )
              .range(from, to)
        );

      const streamsByArtist =
        new Map();

      let qualifiedPremiumStreams = 0;
      let rejectedStreams = 0;

      for (const play of playRows) {
        const userId =
          play.user_id;

        const artistId =
          play.artist_id;

        const songId =
          play.song_id;

        if (
          !userId ||
          !artistId ||
          !songId
        ) {
          rejectedStreams += 1;
          continue;
        }

        const playDate =
          new Date(play.created_at);

        if (
          Number.isNaN(
            playDate.getTime()
          )
        ) {
          rejectedStreams += 1;
          continue;
        }

        const userSubscriptionPeriods =
          subscriptionPeriodsByUser.get(
            userId
          );

        if (
          !userSubscriptionPeriods ||
          userSubscriptionPeriods.length ===
            0
        ) {
          rejectedStreams += 1;
          continue;
        }

        const playTimestamp =
          playDate.getTime();

        const hadActiveSubscription =
          userSubscriptionPeriods.some(
            (period) =>
              playTimestamp >=
                period.start &&
              playTimestamp <=
                period.end
          );

        if (!hadActiveSubscription) {
          rejectedStreams += 1;
          continue;
        }

        const listenedSeconds =
          Number(
            play.listened_seconds || 0
          );

        const songDurationSeconds =
          Number(
            play.song_duration_seconds ||
              0
          );

        /*
         * A stream qualifies when:
         * - listener played at least 30 seconds, or
         * - song is shorter than 30 seconds and
         *   at least 90% was played.
         */

        const normalQualified =
          listenedSeconds >= 30;

        const shortSongQualified =
          songDurationSeconds > 0 &&
          songDurationSeconds < 30 &&
          listenedSeconds >=
            songDurationSeconds * 0.9;

        if (
          !normalQualified &&
          !shortSongQualified
        ) {
          rejectedStreams += 1;
          continue;
        }

        streamsByArtist.set(
          artistId,
          (
            streamsByArtist.get(
              artistId
            ) || 0
          ) + 1
        );

        qualifiedPremiumStreams += 1;
      }

      /* --------------------------------------------- */
      /* Calculate artist distribution in cents        */
      /* --------------------------------------------- */

      const artistCalculations = [];

      if (
        qualifiedPremiumStreams > 0 &&
        artistPoolCents > 0
      ) {
        for (
          const [
            artistId,
            streams,
          ] of streamsByArtist.entries()
        ) {
          const exactCents =
            (
              streams /
              qualifiedPremiumStreams
            ) * artistPoolCents;

          const baseCents =
            Math.floor(exactCents);

          artistCalculations.push({
            artistId,
            streams,
            exactCents,
            payoutCents:
              baseCents,
            remainder:
              exactCents -
              baseCents,
          });
        }

        /*
         * Distribute remaining cents to
         * artists with the largest fractional
         * remainder.
         */

        const distributedCents =
          artistCalculations.reduce(
            (
              total,
              calculation
            ) =>
              total +
              calculation.payoutCents,
            0
          );

        let remainingCents =
          artistPoolCents -
          distributedCents;

        artistCalculations.sort(
          (a, b) =>
            b.remainder -
            a.remainder
        );

        let remainderIndex = 0;

        while (
          remainingCents > 0 &&
          artistCalculations.length > 0
        ) {
          artistCalculations[
            remainderIndex %
              artistCalculations.length
          ].payoutCents += 1;

          remainingCents -= 1;
          remainderIndex += 1;
        }
      }

      /* --------------------------------------------- */
      /* Load existing monthly payout rows              */
      /* --------------------------------------------- */

      const {
        data: existingPayoutRows,
        error:
          existingPayoutError,
      } = await supabase
        .from(
          "premium_artist_payouts"
        )
        .select(`
          id,
          artist_id,
          premium_streams,
          artist_share,
          currency,
          status
        `)
        .eq(
          "month",
          selectedMonth
        )
        .eq(
          "year",
          selectedYear
        );

      if (existingPayoutError) {
        throw existingPayoutError;
      }

      const existingByArtist =
        new Map();

      for (
        const payout
        of existingPayoutRows || []
      ) {
        existingByArtist.set(
          payout.artist_id,
          payout
        );
      }

      const currentArtistIds =
        new Set(
          artistCalculations.map(
            (item) =>
              item.artistId
          )
        );

      let insertedRows = 0;
      let updatedRows = 0;
      let protectedRows = 0;
      let zeroedRows = 0;

      /* --------------------------------------------- */
      /* Save calculated payouts                       */
      /* --------------------------------------------- */

      for (
        const calculation
        of artistCalculations
      ) {
        const existing =
          existingByArtist.get(
            calculation.artistId
          );

        /*
         * Never overwrite approved or paid
         * payout records.
         */

        if (
          existing &&
          (
            existing.status ===
              "paid" ||
            existing.status ===
              "approved"
          )
        ) {
          protectedRows += 1;
          continue;
        }

        const payoutAmount =
          calculation.payoutCents /
          100;

        if (existing) {
          const {
            error: updateError,
          } = await supabase
            .from(
              "premium_artist_payouts"
            )
            .update({
              premium_streams:
                calculation.streams,

              artist_share:
                payoutAmount,

              currency:
                payoutCurrency,

              status:
                "pending",
            })
            .eq(
              "id",
              existing.id
            );

          if (updateError) {
            throw updateError;
          }

          updatedRows += 1;
        } else {
          const {
            error: insertError,
          } = await supabase
            .from(
              "premium_artist_payouts"
            )
            .insert({
              artist_id:
                calculation.artistId,

              month:
                selectedMonth,

              year:
                selectedYear,

              premium_streams:
                calculation.streams,

              artist_share:
                payoutAmount,

              currency:
                payoutCurrency,

              status:
                "pending",
            });

          if (insertError) {
            throw insertError;
          }

          insertedRows += 1;
        }
      }

      /* --------------------------------------------- */
      /* Reset old pending rows no longer qualifying    */
      /* --------------------------------------------- */

      for (
        const existing
        of existingPayoutRows || []
      ) {
        if (
          currentArtistIds.has(
            existing.artist_id
          )
        ) {
          continue;
        }

        if (
          existing.status ===
            "paid" ||
          existing.status ===
            "approved"
        ) {
          protectedRows += 1;
          continue;
        }

        const {
          error: zeroError,
        } = await supabase
          .from(
            "premium_artist_payouts"
          )
          .update({
            premium_streams: 0,
            artist_share: 0,
            currency:
              payoutCurrency,
            status: "pending",
          })
          .eq(
            "id",
            existing.id
          );

        if (zeroError) {
          throw zeroError;
        }

        zeroedRows += 1;
      }

      const resultRows =
        artistCalculations
          .sort(
            (a, b) =>
              b.payoutCents -
              a.payoutCents
          )
          .map(
            (calculation) => ({
              artist_id:
                calculation.artistId,

              premium_streams:
                calculation.streams,

              artist_share:
                calculation.payoutCents /
                100,

              currency:
                payoutCurrency,
            })
          );

      console.log(
        "✅ PREMIUM PAYOUT CALCULATION COMPLETE:",
        {
          month: selectedMonth,
          year: selectedYear,
          totalRevenue:
            totalRevenueCents / 100,
          artistPool:
            artistPoolCents / 100,
          qualifiedStreams:
            qualifiedPremiumStreams,
          artists:
            resultRows.length,
        }
      );

      return res.json({
        success: true,

        period: {
          month:
            selectedMonth,
          year:
            selectedYear,
          start:
            startIso,
          end:
            endIso,
        },

        currency:
          payoutCurrency,

        premium_revenue:
          totalRevenueCents / 100,

        tunevora_share:
          platformShareCents / 100,

        artist_pool:
          artistPoolCents / 100,

        qualified_premium_streams:
          qualifiedPremiumStreams,

        rejected_streams:
          rejectedStreams,

        artist_count:
          resultRows.length,

        database: {
          inserted:
            insertedRows,
          updated:
            updatedRows,
          zeroed:
            zeroedRows,
          protected:
            protectedRows,
        },

        payouts:
          resultRows,
      });
    } catch (error) {
      console.log(
        "❌ PREMIUM PAYOUT ERROR:",
        error
      );

      return res.status(500).json({
        error:
          error.message ||
          "Premium payout calculation failed",
      });
    }
  }
);



/* ===================================================== */
/* ❤️ HEALTH CHECK */
/* ===================================================== */

app.get("/", (req, res) => {
  res.send(
    "Tunevora payment server is running 🚀"
  );
});

/* ===================================================== */
/* 🚀 SERVER */
/* ===================================================== */

const PORT =
  process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(
    `🚀 Server running on port ${PORT}`
  );
});