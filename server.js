async function getAccessToken() {
  try {
    // 🔍 DEBUG HERE
    console.log("CLIENT:", process.env.PAYPAL_CLIENT_ID);
    console.log("SECRET:", process.env.PAYPAL_SECRET ? "EXISTS" : "MISSING");

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