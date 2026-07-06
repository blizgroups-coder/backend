const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const { createClient } = require("@supabase/supabase-js");

const Stripe = require("stripe");

const stripe = new Stripe(
  process.env.STRIPE_SECRET_KEY
);
const app = express();
app.use(bodyParser.json());

/* 🔐 SUPABASE */
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

/* 🔍 DEBUG */
console.log("SUPABASE URL:", process.env.SUPABASE_URL);
console.log("SUPABASE KEY EXISTS:", !!process.env.SUPABASE_SERVICE_ROLE_KEY);
console.log("PAYPAL CLIENT:", process.env.PAYPAL_CLIENT_ID);
console.log("PAYPAL SECRET:", process.env.PAYPAL_SECRET ? "EXISTS" : "MISSING");

/* ===================================================== */
/* 🔑 GET PAYPAL TOKEN */
/* ===================================================== */
async function getAccessToken() {
  try {
    const response = await axios({
      url: "https://api-m.sandbox.paypal.com/v1/oauth2/token",
      method: "post",
      auth: {
        username: process.env.PAYPAL_CLIENT_ID,
        password: process.env.PAYPAL_SECRET,
      },
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      data: "grant_type=client_credentials",
    });

    return response.data.access_token;
  } catch (error) {
    console.log("❌ TOKEN ERROR:", error.response?.data || error.message);
    throw error;
  }
}

/* ===================================================== */
/* 💳 CREATE ORDER */
/* ===================================================== */
app.post("/create-order", async (req, res) => {
  try {
    console.log("🔥 CREATE ORDER HIT");

    const { user_id, plan, amount, currency } = req.body;

    if (!user_id || !plan || !amount || !currency) {
      return res.status(400).json({
        error: "Missing user_id, plan, amount, or currency",
      });
    }

    const accessToken = await getAccessToken();

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
              currency_code: currency.toUpperCase(),
              value: Number(amount).toFixed(2),
            },
          },
        ],
        application_context: {
          return_url: "tunevora://success",
          cancel_url: "tunevora://cancel",
        },
      },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      }
    );

    res.json(response.data);
  } catch (error) {
    console.log("❌ CREATE ERROR:", error.response?.data || error.message);

    res.status(500).json({
      error: "Create order failed",
      details: error.response?.data || error.message,
    });
  }
});

/* ===================================================== */
/* 💳 CAPTURE ORDER */
/* ===================================================== */
app.post("/capture-order", async (req, res) => {
  try {
    console.log("🔥 CAPTURE HIT");

    const { orderID, user_id } = req.body;

    if (!orderID || !user_id) {
      return res.status(400).json({
        error: "Missing orderID or user_id",
      });
    }

    const accessToken = await getAccessToken();

    const capture = await axios.post(
      `https://api-m.sandbox.paypal.com/v2/checkout/orders/${orderID}/capture`,
      {},
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      }
    );

    console.log("💰 PAYPAL RESPONSE:", capture.data);

    if (capture.data.status !== "COMPLETED") {
      return res.status(400).json({
        error: "Payment not completed",
        status: capture.data.status,
      });
    }

    const purchaseUnit =
      capture.data.purchase_units?.[0];

    let paymentInfo = {};

    try {
      paymentInfo = JSON.parse(
        purchaseUnit?.payments?.captures?.[0]?.custom_id ||
          purchaseUnit?.custom_id ||
          "{}"
      );
    } catch (e) {
      paymentInfo = {};
    }

    const selectedPlan = paymentInfo.plan || "premium";
    const paidAmount = Number(paymentInfo.amount || 0);
    const paidCurrency = paymentInfo.currency || "USD";

    const premiumUntil = new Date(
      Date.now() + 30 * 24 * 60 * 60 * 1000
    );

    const { error: userError } = await supabase
      .from("profiles")
      .update({
        is_premium: selectedPlan !== "free",
        plan: selectedPlan,
        premium_until: premiumUntil,
      })
      .eq("id", user_id);

    if (userError) {
      console.log("❌ USER UPDATE ERROR:", userError);

      return res.status(500).json({
        error: userError.message,
      });
    }

    const { error: paymentError } = await supabase
      .from("payments")
      .insert({
        user_id: user_id,
        plan: selectedPlan,
        amount: paidAmount,
        currency: paidCurrency,
        status: "completed",
      });

    if (paymentError) {
      console.log("❌ PAYMENT INSERT ERROR:", paymentError);

      return res.status(500).json({
        error: paymentError.message,
      });
    }

    res.json({
      success: true,
      message: `${selectedPlan} activated`,
    });
  } catch (err) {
    console.log("❌ CAPTURE ERROR:", err.response?.data || err.message);

    res.status(500).json({
      error: "Capture failed",
      details: err.response?.data || err.message,
    });
  }
});
/* ===================================================== */
/* 💳 STRIPE PAYMENT INTENT */
/* ===================================================== */
app.post("/create-payment-intent", async (req, res) => {
  try {

    const { amount, currency } = req.body;

    const paymentIntent =
      await stripe.paymentIntents.create({

        amount: amount,

        currency: currency,

        automatic_payment_methods: {
          enabled: true,
        },

      });

    res.json({

      clientSecret:
      paymentIntent.client_secret,

    });

  } catch (error) {

    console.log(
      "❌ STRIPE ERROR:",
      error.message,
    );

    res.status(500).json({
      error: error.message,
    });

  }
});
/* ===================================================== */
/* ❤️ HEALTH CHECK */
/* ===================================================== */
app.get("/", (req, res) => {
  res.send("Server is running 🚀");
});

/* ===================================================== */
/* 🚀 SERVER */
/* ===================================================== */
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});