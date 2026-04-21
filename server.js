const express = require("express");
const bodyParser = require("body-parser");

const app = express();
app.use(bodyParser.json());

app.post("/paypal-success", async (req, res) => {
  const { user_id } = req.body;

  console.log("Payment success for:", user_id);

  // 👉 Here you will update Supabase
  // (we add this next step)

  res.send("OK");
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});