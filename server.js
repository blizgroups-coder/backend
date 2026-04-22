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
    console.log("❌ Create Order Error:", error.response?.data || error.message);
    res.status(500).send("Error creating order");
  }
});

/* ===================================================== */
/* 💳 CAPTURE PAYMENT (REAL VERIFICATION) */
/* ===================================================== */
app.post("/capture-order", async (req, res) => {
  try {
    const { orderID, user_id } = req.body;

    if (!orderID || !user_id) {
      return res.status(400).json({ error: "Missing orderID or user_id" });
    }

    const accessToken = await getAccessToken();

    // 🔥 CAPTURE PAYMENT FROM PAYPAL
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

    const status = capture.data.status;

    console.log("💰 Payment status:", status);

    if (status !== "COMPLETED") {
      return res.status(400).json({ error: "Payment not completed" });
    }

    /* 🔥 UPDATE USER TO PREMIUM */
    const { data, error } = await supabase
      .from("profiles")
      .update({
        is_premium: true,
        premium_until: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      })
      .eq("id", user_id)
      .select();

    if (error) {
      console.log("❌ Supabase error:", error);
      return res.status(500).json({ error: error.message });
    }

    res.json({
      success: true,
      payment: capture.data,
      user: data,
    });

  } catch (err) {
    console.log("❌ Capture error:", err.response?.data || err.message);
    res.status(500).json({ error: "Capture failed" });
  }
});

/* ===================================================== */
/* 💳 OLD SYSTEM (KEEP FOR TESTING) */
/* ===================================================== */
app.post("/paypal-success", async (req, res) => {
  try {
    const { user_id } = req.body;

    const { data, error } = await supabase
      .from("profiles")
      .update({
        is_premium: true,
        premium_until: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      })
      .eq("id", user_id)
      .select();

    if (error) return res.status(500).json({ error: error.message });

    res.json({ success: true, user: data });

  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

/* ===================================================== */
/* 🚀 SERVER */
/* ===================================================== */
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});