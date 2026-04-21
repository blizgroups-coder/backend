const express = require("express");
const bodyParser = require("body-parser");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(bodyParser.json());

/* 🔐 SUPABASE CONFIG (FIXED KEY NAME) */
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY // ✅ IMPORTANT FIX
);

/* 💳 PAYPAL SUCCESS */
app.post("/paypal-success", async (req, res) => {
  try {
    console.log("📥 FULL BODY:", req.body); // ✅ DEBUG

    const { user_id } = req.body;

    if (!user_id) {
      console.log("❌ No user_id received");
      return res.status(400).json({ error: "user_id is required" });
    }

    console.log("🔥 USER ID:", user_id);

    /* 🔥 UPDATE USER TO PREMIUM */
    const { data, error } = await supabase
      .from("profiles") // ✅ MUST MATCH YOUR TABLE
      .update({
        is_premium: true,
        premium_until: new Date(
          Date.now() + 30 * 24 * 60 * 60 * 1000
        ), // +30 days
      })
      .eq("id", user_id)
      .select(); // ✅ IMPORTANT

    console.log("📦 DATA:", data);
    console.log("❌ ERROR:", error);

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    if (!data || data.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    console.log("✅ PREMIUM ACTIVATED");

    res.json({
      success: true,
      message: "Premium activated",
      user: data[0],
    });
  } catch (err) {
    console.log("❌ SERVER ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/* 🧪 TEST ROUTE (OPTIONAL BUT USEFUL) */
app.get("/", (req, res) => {
  res.send("Backend is running 🚀");
});

/* 🚀 SERVER */
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});