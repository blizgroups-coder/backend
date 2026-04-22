const express = require("express");
const bodyParser = require("body-parser");
const { createClient } = require("@supabase/supabase-js");
const axios = require("axios");

const app = express();
app.use(bodyParser.json());

/* ===================================================== */
/* 🔐 SUPABASE CONFIG */
/* ===================================================== */
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

console.log("URL:", process.env.SUPABASE_URL);
console.log("KEY EXISTS:", !!process.env.SUPABASE_SERVICE_ROLE_KEY);

/* ===================================================== */
/* 🔑 PAYPAL ACCESS TOKEN */
/* ===================================================== */
async function getAccessToken() {
  try {
    console.log("🔑 Getting PayPal access token...");

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

    console.log("✅ Access token success");
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
    console.log("🚀 /create-order called");

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

    console.log("✅ ORDER CREATED");

    res.json(response.data);

  } catch (error) {
    console.log("❌ CREATE ORDER ERROR:", error.response?.data || error.message);

    res.status(500).json({
      error: "Create order failed",
      details: error.response?.data || error.message
    });
  }
});

/* ===================================================== */
/* 💳 CAPTURE PAYMENT */
/* ===================================================== */
app.post("/capture-order", async (req, res) => {
  try {
    const { orderID, user_id } = req.body;

    console.log("💳 Capture request:", orderID, user_id);

    if (!orderID || !user_id) {
      return res.status(400).json({ error: "Missing orderID or user_id" });
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

    console.log("💰 Capture response:", capture.data.status);

    if (capture.data.status !== "COMPLETED") {
      return res.status(400).json({ error: "Payment not completed" });
    }

    const { data, error } = await supabase
      .from("profiles")
      .update({
        is_premium: true,
        premium_until: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      })
      .eq("id", user_id)
      .select();

    if (error) {
      console.log("❌ SUPABASE ERROR:", error);
      return res.status(500).json({ error: error.message });
    }

    res.json({
      success: true,
      user: data,
    });

  } catch (error) {
    console.log("❌ CAPTURE ERROR:", error.response?.data || error.message);

    res.status(500).json({
      error: "Capture failed",
      details: error.response?.data || error.message
    });
  }
});

/* ===================================================== */
/* 🧪 HEALTH CHECK (VERY IMPORTANT) */
/* ===================================================== */
app.get("/", (req, res) => {
  res.send("Server is running ✅");
});

/* ===================================================== */
/* 🚀 SERVER */
/* ===================================================== */
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});