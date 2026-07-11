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
            stripe_payment_intent_id:
              paymentIntentId,
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