const express = require("express");
const bodyParser = require("body-parser");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(bodyParser.json());

/* 🔐 SUPABASE CONFIG (FIXED FOR sb_secret KEY) */
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    },
    global: {
      headers: {
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`
      }
    }
  }
);

/* 🔍 DEBUG */
console.log("URL:", process.env.SUPABASE_URL);
console.log("KEY EXISTS:", !!process.env.SUPABASE_SERVICE_ROLE_KEY);

/* 💳 PAYPAL SUCCESS */
app.post("/paypal-success", async (req, res) => {
  try {
    const { user_id } = req.body;

    console.log("🔥 USER ID:", user_id);

    if (!user_id) {
      return res.status(400).json({ error: "user_id is required" });
    }

    const { data, error } = await supabase
      .from("profiles")
      .update({
        is_premium: true,
        premium_until: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
      })
      .eq("id", user_id)
      .select();

    console.log("📦 DATA:", data);
    console.log("❌ ERROR:", error);

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    res.json({
      success: true,
      user: data
    });

  } catch (err) {
    console.log("❌ SERVER ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/* 🚀 SERVER */
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});