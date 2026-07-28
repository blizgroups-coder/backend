const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const { createClient } = require("@supabase/supabase-js");
const Stripe = require("stripe");

const stripe = new Stripe(
  process.env.STRIPE_SECRET_KEY
);

const app = express();

/* ===================================================== */
/* 🔐 SUPABASE */
/* ===================================================== */

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

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
        const paymentIntent =
          event.data.object;

        const paymentIntentId =
          paymentIntent.id;

        const userId =
          paymentIntent.metadata?.user_id;

        const selectedPlan =
          paymentIntent.metadata?.plan;

        const allowedPlans = [
          "standard",
          "premium",
          "lossless",
          "hires",
        ];

        if (
          !userId ||
          !allowedPlans.includes(selectedPlan)
        ) {
          throw new Error(
            "Invalid Stripe payment metadata"
          );
        }

        /*
         * Stripe can send the same webhook
         * more than once.
         */
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
          console.log(
            "⚠️ STRIPE PAYMENT ALREADY PROCESSED:",
            paymentIntentId
          );

          return res.json({
            received: true,
            duplicate: true,
          });
        }

        const paidAmount =
          Number(
            paymentIntent.amount_received
          ) / 100;

        const paidCurrency =
          paymentIntent.currency
            .toUpperCase();

        const premiumUntil = new Date(
          Date.now() +
            30 * 24 * 60 * 60 * 1000
        );

        /* Update user plan */

        const {
          error: profileError,
        } = await supabase
          .from("profiles")
          .update({
            is_premium: true,
            plan: selectedPlan,
            premium_until:
              premiumUntil.toISOString(),
          })
          .eq("id", userId);

        if (profileError) {
          throw profileError;
        }

        /* Record payment */

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

        /* Record subscription */

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
            expires_at:
              premiumUntil.toISOString(),
          });

        if (subscriptionError) {
          throw subscriptionError;
        }

        /* Record admin revenue */

        const {
          error: revenueError,
        } = await supabase
          .from("admin_revenue")
          .insert({
            source: selectedPlan,
            amount: paidAmount,
            currency: paidCurrency,
          });

        if (revenueError) {
          throw revenueError;
        }

        console.log(
          `✅ STRIPE ACTIVATED: ${userId} → ${selectedPlan}`
        );
      }

      if (
        event.type ===
        "payment_intent.payment_failed"
      ) {
        const paymentIntent =
          event.data.object;

        console.log(
          "❌ STRIPE PAYMENT FAILED:",
          paymentIntent.id
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
/* 🔑 GET PAYPAL TOKEN */
/* ===================================================== */

async function getAccessToken() {
  try {
    const response = await axios({
      url:
        "https://api-m.sandbox.paypal.com/v1/oauth2/token",

      method: "post",

      auth: {
        username:
          process.env.PAYPAL_CLIENT_ID,

        password:
          process.env.PAYPAL_SECRET,
      },

      headers: {
        "Content-Type":
          "application/x-www-form-urlencoded",
      },

      data:
        "grant_type=client_credentials",
    });

    return response.data.access_token;
  } catch (error) {
    console.log(
      "❌ TOKEN ERROR:",
      error.response?.data ||
        error.message
    );

    throw error;
  }
}

/* ===================================================== */
/* 💳 CREATE PAYPAL ORDER */
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
        amount,
        currency,
      } = req.body;

      if (
        !user_id ||
        !plan ||
        !amount ||
        !currency
      ) {
        return res.status(400).json({
          error:
            "Missing user_id, plan, amount, or currency",
        });
      }

      const allowedPlans = [
        "standard",
        "premium",
        "lossless",
        "hires",
      ];

      if (!allowedPlans.includes(plan)) {
        return res.status(400).json({
          error: "Invalid plan",
        });
      }

      const accessToken =
        await getAccessToken();

      const response = await axios.post(
        "https://api-m.sandbox.paypal.com/v2/checkout/orders",
        {
          intent: "CAPTURE",

          purchase_units: [
            {
              custom_id: JSON.stringify({
                user_id,
                plan,
                amount,
                currency,
              }),

              amount: {
                currency_code:
                  currency.toUpperCase(),

                value:
                  Number(amount).toFixed(2),
              },
            },
          ],

          application_context: {
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
          },
        }
      );

      return res.json(response.data);
    } catch (error) {
      console.log(
        "❌ CREATE PAYPAL ERROR:",
        error.response?.data ||
          error.message
      );

      return res.status(500).json({
        error:
          "Create order failed",

        details:
          error.response?.data ||
          error.message,
      });
    }
  }
);

/* ===================================================== */
/* 💳 CAPTURE PAYPAL ORDER */
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
      } = req.body;

      if (!orderID || !user_id) {
        return res.status(400).json({
          error:
            "Missing orderID or user_id",
        });
      }

      const accessToken =
        await getAccessToken();

      const capture =
        await axios.post(
          `https://api-m.sandbox.paypal.com/v2/checkout/orders/${orderID}/capture`,
          {},
          {
            headers: {
              Authorization:
                `Bearer ${accessToken}`,

              "Content-Type":
                "application/json",
            },
          }
        );

      console.log(
        "💰 PAYPAL RESPONSE:",
        capture.data
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

      let paymentInfo = {};

      try {
        paymentInfo = JSON.parse(
          purchaseUnit
            ?.payments
            ?.captures?.[0]
            ?.custom_id ||
            purchaseUnit?.custom_id ||
            "{}"
        );
      } catch (error) {
        paymentInfo = {};
      }

      const selectedPlan =
        paymentInfo.plan ||
        "premium";

      const paidAmount =
        Number(
          paymentInfo.amount || 0
        );

      const paidCurrency =
        (
          paymentInfo.currency ||
          "USD"
        ).toUpperCase();

      const allowedPlans = [
        "standard",
        "premium",
        "lossless",
        "hires",
      ];

      if (
        !allowedPlans.includes(
          selectedPlan
        )
      ) {
        return res.status(400).json({
          error:
            "Invalid PayPal plan",
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
        error: userError,
      } = await supabase
        .from("profiles")
        .update({
          is_premium: true,
          plan: selectedPlan,
          premium_until:
            premiumUntil.toISOString(),
        })
        .eq("id", user_id);

      if (userError) {
        console.log(
          "❌ USER UPDATE ERROR:",
          userError
        );

        return res.status(500).json({
          error:
            userError.message,
        });
      }

      const {
        error: paymentError,
      } = await supabase
           .from("payments")
           .insert({
             user_id,
             plan: selectedPlan,
             amount: paidAmount,
             currency: paidCurrency,
             status: "completed",
 
            payment_method: "PayPal",

            transaction_reference: orderID,
       });

      if (paymentError) {
        console.log(
          "❌ PAYMENT INSERT ERROR:",
          paymentError
        );

        return res.status(500).json({
          error:
            paymentError.message,
        });
      }

      const {
        error: subscriptionError,
      } = await supabase
        .from("subscriptions")
        .insert({
          user_id,
          plan: selectedPlan,
          status: "active",
          amount: paidAmount,
          currency: paidCurrency,
          expires_at:
            premiumUntil.toISOString(),
        });

      if (subscriptionError) {
        console.log(
          "❌ SUBSCRIPTION INSERT ERROR:",
          subscriptionError
        );

        return res.status(500).json({
          error:
            subscriptionError.message,
        });
      }

      const {
        error: revenueError,
      } = await supabase
        .from("admin_revenue")
        .insert({
          source: selectedPlan,
          amount: paidAmount,
          currency: paidCurrency,
        });

      if (revenueError) {
        console.log(
          "❌ REVENUE INSERT ERROR:",
          revenueError
        );

        return res.status(500).json({
          error:
            revenueError.message,
        });
      }

      return res.json({
        success: true,
        message:
          `${selectedPlan} activated`,
      });
    } catch (error) {
      console.log(
        "❌ CAPTURE PAYPAL ERROR:",
        error.response?.data ||
          error.message
      );

      return res.status(500).json({
        error:
          "Capture failed",

        details:
          error.response?.data ||
          error.message,
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
                "advertisement",

              user_id,

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