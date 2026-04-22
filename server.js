app.post("/capture-order", async (req, res) => {
  try {
    const { orderID, user_id } = req.body;

    if (!orderID || !user_id) {
      return res.status(400).json({ error: "Missing orderID or user_id" });
    }

    console.log("📦 OrderID:", orderID);

    const accessToken = await getAccessToken();

    console.log("🔑 Access Token OK");

    // 🔥 CAPTURE PAYMENT
    const response = await axios.post(
      `https://api-m.sandbox.paypal.com/v2/checkout/orders/${orderID}/capture`,
      {},
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      }
    );

    console.log("💰 FULL PAYPAL RESPONSE:", response.data);

    const status = response.data.status;

    if (status !== "COMPLETED") {
      return res.status(400).json({
        error: "Payment not completed",
        status: status,
      });
    }

    // 🔥 UPDATE USER
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

    return res.json({
      success: true,
      payment: response.data,
      user: data,
    });

  } catch (err) {
    console.log("❌ CAPTURE ERROR FULL:", err.response?.data || err.message);

    return res.status(500).json({
      error: "Capture failed",
      details: err.response?.data || err.message,
    });
  }
});