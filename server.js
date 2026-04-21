const express = require("express");
const bodyParser = require("body-parser");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(bodyParser.json());

/* 🔐 SUPABASE CONFIG */
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

/* 💳 PAYPAL SUCCESS */
app.post("/paypal-success", async (req, res) => {
  const { user_id } = req.body;

  console.log("🔥 USER ID:", user_id);

  const { data, error } = await supabase
    .from("profiles") // ✅ MUST be profiles
    .update({
      is_premium: true,
      premium_until: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
    })
    .eq("id", user_id);

  console.log("📦 DATA:", data);
  console.log("❌ ERROR:", error);

  if (error) {
    return res.status(500).json({ error });
  }

  res.send("OK");
});

/* 🚀 SERVER */
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});