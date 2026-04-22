app.post("/create-order", async (req, res) => {
  console.log("🔥 /create-order HIT");

  try {
    const accessToken = await getAccessToken();

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

    res.json(response.data);

  } catch (error) {
    console.log("❌ CREATE ORDER ERROR FULL:", error);
    console.log("❌ RESPONSE:", error.response?.data);

    res.status(500).json({
      error: "Create order failed",
      details: error.response?.data || error.message,
    });
  }
});