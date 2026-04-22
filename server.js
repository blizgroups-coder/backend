app.post("/create-order", async (req, res) => {
  console.log("🔥 /create-order HIT");

  try {
    const accessToken = await getAccessToken();

    if (!accessToken) {
      throw new Error("No PayPal access token");
    }

    console.log("✅ Token received");

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

    return res.json(response.data);

  } catch (error) {
    console.log("❌ CREATE ORDER ERROR:", error.message);
    console.log("❌ DETAILS:", error.response?.data);

    return res.status(500).json({
      error: "Create order failed",
      details: error.response?.data || error.message,
    });
  }
});