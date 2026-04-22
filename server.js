const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(bodyParser.json());

/* 🔥 REQUEST LOG */
app.use((req, res, next) => {
  console.log("👉 Incoming:", req.method, req.url);
  next();
});

/* 🔐 SUPABASE */
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

/* 🔑 PAYPAL TOKEN */
async function getAccessToken() {
  console.log("CLIENT:", process.env.PAYPAL_CLIENT_ID);
  console.log("SECRET:", process.env.PAYPAL_SECRET ? "EXISTS" : "MISSING");

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

/* 💳 CREATE ORDER */
app.post("/create-order", async (req, res) => {
  console.log("🔥 /create-order HIT");

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

    console.log("✅ ORDER CREATED");

    res.json(response.data);

  } catch (error) {
    console.log("❌ CREATE ORDER ERROR:", error.message);
    console.log("❌ DETAILS:", error.response?.data);

    res.status(500).json({
      error: "Create order failed",
      details: error.response?.data || error.message,
    });
  }
});

/* 💳 CAPTURE */
app.post("/capture-order", async (req, res) => {
  try {
    const { orderID, user_id } = req.body;

    const accessToken = await getAccessToken();

    const capture = await axios.post(
      `https://api-m.sandbox.paypal.com/v2/checkout/orders/${orderID}/capture`,
      {},
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      }
    );

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

    if (error) return res.status(500).json({ error: error.message });

    res.json({ success: true, user: data });

  } catch (err) {
    console.log("❌ CAPTURE ERROR:", err.message);
    res.status(500).json({ error: "Capture failed" });
  }
});

/* ❤️ HEALTH CHECK */
app.get("/", (req, res) => {
  res.send("Server is running 🚀");
});

/* 🚀 START SERVER */
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});