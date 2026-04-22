const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const { createClient } = require("@supabase/supabase-js");

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
}

/* ===================================================== */
/* 💳 CREATE ORDER */
/* ===================================================== */
app.post("/create-order", async (req, res) => {
  try {
    console.log("🔥 CREATE ORDER HIT");

    const accessToken = await getAccessToken();

    const response = await axios.post(
      "https://api-m.sandbox.paypal.com/v2/checkout/orders",
      {
        intent: "CAPTURE",
        purchase_units: [
          {
            amount: {
              currency_code: "USD",
              value: "5.00",
            },
          },
        ],
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
    res.status(500).json({ error: "Create order failed" });
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
      return res.status(400).json({ error: "Missing data" });
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
      return res.status(400).json({ error: "Payment not completed" });
    }

    /* 🔥 UPDATE USER */
    const { error } = await supabase
      .from("profiles")
      .update({
        is_premium: true,
        premium_until: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      })
      .eq("id", user_id);

    if (error) {
      console.log("❌ SUPABASE ERROR:", error);
      return res.status(500).json({ error: error.message });
    }

    res.json({
      success: true,
      message: "Premium activated",
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
/* 🚀 SERVER */
/* ===================================================== */
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});