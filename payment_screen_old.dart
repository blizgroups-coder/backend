import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:supabase_flutter/supabase_flutter.dart';
import 'package:url_launcher/url_launcher.dart';
import 'package:app_links/app_links.dart';

import '../services/user_service.dart';
import 'package:flutter_stripe/flutter_stripe.dart';

class PaymentScreen extends StatefulWidget {
  final String plan;

  const PaymentScreen({
    super.key,
    required this.plan,
  });

  @override
  State<PaymentScreen> createState() => _PaymentScreenState();
}

class _PaymentScreenState extends State<PaymentScreen> {

  bool isLoading = false;

  double price = 0;
  String currency = 'AED';
  bool priceLoading = true;

  late AppLinks _appLinks;
  StreamSubscription<Uri>? _sub;

  String? currentOrderId;

  final String baseUrl = "https://backend-production-1391.up.railway.app";

  @override
  void initState() {
    super.initState();

    loadPrice();

    _appLinks = AppLinks();

    _sub = _appLinks.uriLinkStream.listen((uri) {
      _handlePaymentReturn(uri);
    });
  }
  bool get _usesHostedStripeCheckout {
    if (kIsWeb) return true;

    return defaultTargetPlatform == TargetPlatform.windows ||
        defaultTargetPlatform == TargetPlatform.macOS ||
        defaultTargetPlatform == TargetPlatform.linux;
  }

  Future<void> _handlePaymentReturn(Uri uri) async {
    if (!mounted) return;

    final returnValue = uri.toString().toLowerCase();

    if (returnValue.contains('cancel')) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('Payment Cancelled'),
        ),
      );
      return;
    }

    if (!returnValue.contains('success')) {
      return;
    }

    /*
     * A PayPal return has a locally stored order ID and must be
     * captured by Railway. Stripe Checkout is finalized securely
     * by its webhook, so it only needs the user profile refreshed.
     */
    if (currentOrderId != null && currentOrderId!.isNotEmpty) {
      await capturePayment();
      return;
    }

    await _waitForPlanActivation();
  }

  Future<bool> _waitForPlanActivation() async {
    final requestedPlan = widget.plan.toLowerCase();

    for (int attempt = 0; attempt < 8; attempt++) {
      await Future.delayed(const Duration(seconds: 1));
      await UserService.loadUser();

      if (UserService.plan.toLowerCase() == requestedPlan) {
        if (!mounted) return true;

        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(
              '${widget.plan.toUpperCase()} Activated 🎉',
            ),
          ),
        );

        Navigator.pop(context, true);
        return true;
      }
    }

    if (!mounted) return false;

    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(
        content: Text(
          'Payment completed. Your plan is being activated.',
        ),
      ),
    );

    return false;
  }

  Future<void> _openStripeCheckout({
    required String userId,
  }) async {
    final response = await http.post(
      Uri.parse(
        '$baseUrl/create-stripe-checkout-session',
      ),
      headers: const {
        'Content-Type': 'application/json',
      },
      body: jsonEncode({
        'payment_type': 'subscription',
        'user_id': userId,
        'plan': widget.plan.toLowerCase(),
        'country': UserService.country.toUpperCase(),
      }),
    );

    final dynamic decoded = jsonDecode(response.body);

    if (decoded is! Map<String, dynamic>) {
      throw Exception(
        'Invalid Stripe Checkout response',
      );
    }

    if (response.statusCode < 200 ||
        response.statusCode >= 300) {
      throw Exception(
        decoded['error'] ??
            'Failed to create Stripe Checkout session',
      );
    }

    final checkoutUrl =
    decoded['checkoutUrl']?.toString();

    if (checkoutUrl == null || checkoutUrl.isEmpty) {
      throw Exception(
        'Stripe Checkout URL is missing',
      );
    }

    final opened = await launchUrl(
      Uri.parse(checkoutUrl),
      mode: LaunchMode.externalApplication,
      webOnlyWindowName: '_self',
    );

    if (!opened) {
      throw Exception(
        'Could not open Stripe Checkout',
      );
    }

    if (!mounted) return;

    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(
        content: Text(
          'Complete the secure payment in your browser, then return to Tunevora.',
        ),
      ),
    );
  }

  Future<void> loadPrice() async {
    try {
      Map<String, dynamic>? data;

      // First try the user’s country.
      data = await Supabase.instance.client
          .from('subscription_prices')
          .select()
          .eq('country', UserService.country)
          .maybeSingle();

      // Global fallback uses US/USD pricing.
      data ??= await Supabase.instance.client
          .from('subscription_prices')
          .select()
          .eq('country', 'US')
          .maybeSingle();

      if (!mounted) return;

      if (data == null) {
        setState(() {
          currency = 'USD';
          price = _fallbackPrice(widget.plan);
          priceLoading = false;
        });
        return;
      }

      final selectedPrice = switch (widget.plan.toLowerCase()) {
        'standard' => data['standard_price'],
        'premium' => data['premium_price'],
        _ => null,
      };

      setState(() {
        currency = (data!['currency'] ?? 'USD').toString();

        price = selectedPrice is num
            ? selectedPrice.toDouble()
            : _fallbackPrice(widget.plan);

        priceLoading = false;
      });
    } catch (e) {
      debugPrint("Load price error: $e");

      if (!mounted) return;

      setState(() {
        currency = 'USD';
        price = _fallbackPrice(widget.plan);
        priceLoading = false;
      });
    }
  }

  double _fallbackPrice(String plan) {
    switch (plan.toLowerCase()) {
      case 'standard':
        return 2.99;

      case 'premium':
        return 5.99;

      default:
        return 0;
    }
  }

  String get planFeatures {
    switch (widget.plan.toLowerCase()) {
      case 'standard':
        return "• 128 kbps audio\n"
            "• No ads\n"
            "• Offline listening\n"
            "• Unlimited skips";

      case 'premium':
        return "• 320 kbps audio\n"
            "• No ads\n"
            "• Offline listening\n"
            "• Equalizer & Crossfade\n"
            "• Unlimited skips";

      default:
        return "";
    }
  }

  Future<void> handleStripePayment() async {
    if (isLoading || priceLoading) return;

    setState(() {
      isLoading = true;
    });

    try {
      final user =
          Supabase.instance.client.auth.currentUser;

      if (user == null) {
        throw Exception('User not logged in');
      }

      if (_usesHostedStripeCheckout) {
        await _openStripeCheckout(
          userId: user.id,
        );
        return;
      }

      final response = await http.post(
        Uri.parse(
          '$baseUrl/create-payment-intent',
        ),
        headers: const {
          'Content-Type': 'application/json',
        },
        body: jsonEncode({
          'user_id': user.id,
          'plan': widget.plan.toLowerCase(),
          'country': UserService.country.toUpperCase(),
        }),
      );

      final dynamic decoded =
      jsonDecode(response.body);

      if (decoded is! Map<String, dynamic>) {
        throw Exception(
          'Invalid Stripe payment response',
        );
      }

      if (response.statusCode < 200 ||
          response.statusCode >= 300) {
        throw Exception(
          decoded['error'] ??
              'Failed to create Stripe payment',
        );
      }

      final clientSecret =
      decoded['clientSecret']?.toString();

      if (clientSecret == null ||
          clientSecret.isEmpty) {
        throw Exception(
          'Stripe client secret is missing',
        );
      }

      await Stripe.instance.initPaymentSheet(
        paymentSheetParameters:
        SetupPaymentSheetParameters(
          paymentIntentClientSecret:
          clientSecret,
          merchantDisplayName: 'Tunevora',
        ),
      );

      await Stripe.instance.presentPaymentSheet();

      await _waitForPlanActivation();
    } on StripeException catch (error) {
      if (!mounted) return;

      final message =
          error.error.localizedMessage ??
              'Stripe payment was cancelled';

      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(message),
        ),
      );
    } catch (error) {
      if (!mounted) return;

      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            'Stripe Error: $error',
          ),
        ),
      );
    } finally {
      if (mounted) {
        setState(() {
          isLoading = false;
        });
      }
    }
  }

  /// 🔥 STEP 1: CREATE ORDER + OPEN PAYPAL
  Future<void> handlePayPalPayment() async {
    if (isLoading) {
      return;
    }

    setState(() {
      isLoading = true;
    });

    try {
      final user = Supabase.instance.client.auth.currentUser;

      if (user == null) {
        throw Exception('User not logged in');
      }

      final createRes = await http.post(
        Uri.parse('$baseUrl/create-order'),
        headers: {
          'Content-Type': 'application/json',
        },
        body: jsonEncode({
          'user_id': user.id,
          'plan': widget.plan.toLowerCase(),
          'country': UserService.country.toUpperCase(),
        }),
      );

      final dynamic decoded =
      jsonDecode(createRes.body);

      if (decoded is! Map<String, dynamic>) {
        throw Exception(
          'Invalid PayPal order response',
        );
      }

      if (createRes.statusCode < 200 ||
          createRes.statusCode >= 300) {
        throw Exception(
          decoded['error'] ??
              'Create order failed',
        );
      }

      final createData = decoded;

      final orderID = createData['id'];
      currentOrderId = orderID;

      String? approvalUrl;

      for (final link in createData['links']) {
        if (link['rel'] == 'approve') {
          approvalUrl = link['href'];
          break;
        }
      }

      if (approvalUrl == null) {
        throw Exception('No approval URL');
      }

      final opened = await launchUrl(
        Uri.parse(approvalUrl),
        mode: LaunchMode.externalApplication,
        webOnlyWindowName: '_self',
      );

      if (!opened) {
        throw Exception(
          'Could not open PayPal',
        );
      }
    } catch (e) {
      if (!mounted) {
        return;
      }

      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text('Error: $e'),
        ),
      );
    }

    if (!mounted) {
      return;
    }

    setState(() {
      isLoading = false;
    });
  }

  /// 🔥 STEP 2: CAPTURE PAYMENT (AFTER RETURN)
  Future<void> capturePayment() async {
    try {
      final user = Supabase.instance.client.auth.currentUser;

      if (user == null) {
        throw Exception("User not logged in");
      }

      if (currentOrderId == null || currentOrderId!.isEmpty) {
        throw Exception("Missing PayPal order ID");
      }

      final res = await http.post(
        Uri.parse("$baseUrl/capture-order"),
        headers: {"Content-Type": "application/json"},
        body: jsonEncode({
          "orderID": currentOrderId,
          "user_id": user.id,
        }),
      );

      final dynamic decoded =
      jsonDecode(res.body);

      if (decoded is! Map<String, dynamic>) {
        throw Exception(
          'Invalid PayPal capture response',
        );
      }

      if (res.statusCode < 200 ||
          res.statusCode >= 300) {
        throw Exception(
          decoded['error'] ??
              'Payment capture failed',
        );
      }

      final data = decoded;

      if (data['success'] == true) {

        // Railway has already updated the user's plan.
        await UserService.loadUser();

        if (!mounted) return;

        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text("${widget.plan.toUpperCase()} Activated 🎉"),
          ),
        );

        currentOrderId = null;
        Navigator.pop(context, true);
      } else {
        throw Exception("Payment not completed");
      }

    } catch (e) {
      if (!mounted) return;

      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text("Capture failed: $e")),
      );
    }
  }

  @override
  void dispose() {
    _sub?.cancel();
    super.dispose();
  }

  Widget _summaryRow({
    required String label,
    required String value,
    required IconData icon,
    required Color color,
  }) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 8),
      child: Row(
        children: [
          Container(
            width: 38,
            height: 38,
            decoration: BoxDecoration(
              color: color.withValues(alpha: 0.12),
              borderRadius: BorderRadius.circular(12),
            ),
            child: Icon(
              icon,
              color: color,
              size: 20,
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Text(
              label,
              style: const TextStyle(
                color: Colors.white54,
                fontSize: 13,
              ),
            ),
          ),
          Text(
            value,
            textAlign: TextAlign.right,
            style: const TextStyle(
              color: Colors.white,
              fontSize: 13,
              fontWeight: FontWeight.w800,
            ),
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final plan = widget.plan.toLowerCase();

    final IconData planIcon = switch (plan) {
      'standard' => Icons.star_rounded,
      'premium' => Icons.workspace_premium_rounded,
      _ => Icons.music_note_rounded,
    };

    final String planName = switch (plan) {
      'standard' => 'Standard',
      'premium' => 'Premium',
      _ => widget.plan,
    };

    final List<Color> planColors = switch (plan) {
      'standard' => const [
        Color(0xFF1565C0),
        Color(0xFF00A8E8),
      ],
      'premium' => const [
        Color(0xFF7B2FF7),
        Color(0xFFE100FF),
      ],
      _ => const [
        Color(0xFF333333),
        Color(0xFF111111),
      ],
    };

    return Scaffold(
      backgroundColor: Colors.black,
      body: Container(
        decoration: const BoxDecoration(
          gradient: LinearGradient(
            begin: Alignment.topCenter,
            end: Alignment.bottomCenter,
            colors: [
              Color(0xFF100018),
              Color(0xFF05050A),
              Colors.black,
            ],
          ),
        ),
        child: SafeArea(
          child: Column(
            children: [
              /// PREMIUM HEADER
              Container(
                width: double.infinity,
                padding: const EdgeInsets.fromLTRB(12, 8, 20, 28),
                decoration: BoxDecoration(
                  gradient: LinearGradient(
                    begin: Alignment.topLeft,
                    end: Alignment.bottomRight,
                    colors: planColors,
                  ),
                  borderRadius: const BorderRadius.only(
                    bottomLeft: Radius.circular(38),
                    bottomRight: Radius.circular(38),
                  ),
                  boxShadow: [
                    BoxShadow(
                      color: planColors.last.withValues(alpha: .45),
                      blurRadius: 45,
                      spreadRadius: 3,
                      offset: const Offset(0, 12),
                    ),
                  ],
                ),
                child: Column(
                  children: [
                    Row(
                      children: [
                        IconButton(
                          onPressed: () => Navigator.pop(context),
                          icon: const Icon(
                            Icons.arrow_back_rounded,
                            color: Colors.white,
                          ),
                        ),
                        const Spacer(),
                        const Text(
                          'TUNEVORA',
                          style: TextStyle(
                            color: Colors.white70,
                            fontSize: 13,
                            fontWeight: FontWeight.w900,
                            letterSpacing: 2,
                          ),
                        ),
                      ],
                    ),

                    const SizedBox(height: 12),

                    Container(
                      width: 78,
                      height: 78,
                      decoration: BoxDecoration(
                        color: Colors.white.withValues(alpha: 0.16),
                        shape: BoxShape.circle,
                        border: Border.all(
                          color: Colors.white.withValues(alpha: 0.25),
                        ),
                      ),
                      child: TweenAnimationBuilder<double>(
                        tween: Tween(begin: 0.9, end: 1),
                        duration: const Duration(milliseconds: 700),
                        curve: Curves.easeOutBack,
                        builder: (_, value, child) {
                          return Transform.scale(
                            scale: value,
                            child: child,
                          );
                        },
                        child: Icon(
                          planIcon,
                          color: Colors.white,
                          size: 40,
                        ),
                      ),
                    ),

                    const SizedBox(height: 16),

                    Text(
                      'Tunevora $planName',
                      textAlign: TextAlign.center,
                      style: const TextStyle(
                        color: Colors.white,
                        fontSize: 30,
                        fontWeight: FontWeight.w900,
                      ),
                    ),

                    const SizedBox(height: 6),

                    const Text(
                      'Secure checkout for your Tunevora plan',
                      style: TextStyle(
                        color: Colors.white70,
                        fontSize: 14,
                      ),
                    ),
                  ],
                ),
              ),

              /// SCROLLABLE PAYMENT CONTENT
              Expanded(
                child: SingleChildScrollView(
                  padding: const EdgeInsets.fromLTRB(
                    20,
                    24,
                    20,
                    30,
                  ),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const Text(
                        'What you get',
                        style: TextStyle(
                          color: Colors.white,
                          fontSize: 21,
                          fontWeight: FontWeight.w800,
                        ),
                      ),

                      const SizedBox(height: 14),

                      Container(
                        width: double.infinity,
                        padding: const EdgeInsets.all(20),
                        decoration: BoxDecoration(
                          color: Colors.white.withValues(alpha: 0.055),
                          borderRadius: BorderRadius.circular(24),
                          border: Border.all(
                            color: Colors.white.withValues(alpha: 0.09),
                          ),
                        ),
                        child: Column(
                          children: planFeatures
                              .split('\n')
                              .map(
                                (feature) => Padding(
                              padding: const EdgeInsets.only(bottom: 12),
                              child: Row(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Icon(
                                    Icons.check_circle,
                                    color: planColors.last,
                                    size: 20,
                                  ),
                                  const SizedBox(width: 10),
                                  Expanded(
                                    child: Text(
                                      feature.replaceAll("• ", ""),
                                      style: const TextStyle(
                                        color: Colors.white70,
                                        fontSize: 15,
                                        height: 1.4,
                                      ),
                                    ),
                                  ),
                                ],
                              ),
                            ),
                          )
                              .toList(),
                        ),
                      ),

                      const SizedBox(height: 20),

                      Container(
                        width: double.infinity,
                        padding: const EdgeInsets.all(22),
                        decoration: BoxDecoration(
                          gradient: LinearGradient(
                            colors: [
                              Colors.white.withValues(alpha: 0.09),
                              Colors.white.withValues(alpha: 0.035),
                            ],
                          ),
                          borderRadius: BorderRadius.circular(26),
                          border: Border.all(
                            color: planColors.last.withValues(alpha: 0.35),
                          ),
                        ),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              '$planName Monthly Plan',
                              style: const TextStyle(
                                color: Colors.white70,
                                fontSize: 15,
                                fontWeight: FontWeight.w600,
                              ),
                            ),

                            const SizedBox(height: 10),

                            priceLoading
                                ? const SizedBox(
                              width: 28,
                              height: 28,
                              child: CircularProgressIndicator(
                                color: Color(0xFFE100FF),
                                strokeWidth: 3,
                              ),
                            )
                                : Row(
                              crossAxisAlignment:
                              CrossAxisAlignment.end,
                              children: [
                                Text(
                                  '$currency ${price.toStringAsFixed(2)}',
                                  style: const TextStyle(
                                    color: Colors.white,
                                    fontSize: 40,
                                    fontWeight: FontWeight.w900,
                                  ),
                                ),
                                const Padding(
                                  padding: EdgeInsets.only(
                                    left: 7,
                                    bottom: 5,
                                  ),
                                  child: Text(
                                    '/ month',
                                    style: TextStyle(
                                      color: Colors.white54,
                                      fontSize: 13,
                                    ),
                                  ),
                                ),
                              ],
                            ),
                          ],
                        ),
                      ),

                      const SizedBox(height: 18),

                      Container(
                        width: double.infinity,
                        padding: const EdgeInsets.all(20),
                        decoration: BoxDecoration(
                          color: Colors.white.withValues(alpha: 0.045),
                          borderRadius: BorderRadius.circular(24),
                          border: Border.all(
                            color: Colors.white.withValues(alpha: 0.08),
                          ),
                        ),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            const Text(
                              'Billing Summary',
                              style: TextStyle(
                                color: Colors.white,
                                fontSize: 19,
                                fontWeight: FontWeight.w900,
                              ),
                            ),
                            const SizedBox(height: 10),
                            _summaryRow(
                              label: 'Plan',
                              value: planName,
                              icon: Icons.workspace_premium_rounded,
                              color: planColors.last,
                            ),
                            _summaryRow(
                              label: 'Country',
                              value: UserService.country.toUpperCase(),
                              icon: Icons.public_rounded,
                              color: const Color(0xFF58A6FF),
                            ),
                            _summaryRow(
                              label: 'Billing',
                              value: 'Monthly',
                              icon: Icons.calendar_month_rounded,
                              color: const Color(0xFF27C499),
                            ),
                            _summaryRow(
                              label: 'Renewal',
                              value: 'Manual',
                              icon: Icons.autorenew_rounded,
                              color: Colors.orange,
                            ),
                            _summaryRow(
                              label: 'Total',
                              value: priceLoading
                                  ? 'Loading...'
                                  : '$currency ${price.toStringAsFixed(2)}',
                              icon: Icons.payments_rounded,
                              color: planColors.last,
                            ),
                          ],
                        ),
                      ),

                      const SizedBox(height: 28),

                      if (UserService.plan == plan)
                        SizedBox(
                          width: double.infinity,
                          height: 58,
                          child: ElevatedButton.icon(
                            onPressed: null,
                            icon: const Icon(Icons.check_circle_rounded),
                            label: const Text('Your Current Plan'),
                            style: ElevatedButton.styleFrom(
                              disabledBackgroundColor:
                              Colors.white.withValues(alpha: 0.12),
                              disabledForegroundColor: Colors.white60,
                              shape: RoundedRectangleBorder(
                                borderRadius: BorderRadius.circular(20),
                              ),
                            ),
                          ),
                        )
                      else ...[
                        SizedBox(
                          width: double.infinity,
                          height: 58,
                          child: ElevatedButton(
                            onPressed: isLoading || priceLoading
                                ? null
                                : handlePayPalPayment,
                            style: ElevatedButton.styleFrom(
                              backgroundColor: const Color(0xFF0070BA),
                              foregroundColor: Colors.white,
                              shape: RoundedRectangleBorder(
                                borderRadius: BorderRadius.circular(20),
                              ),
                            ),
                            child: isLoading
                                ? const SizedBox(
                              width: 24,
                              height: 24,
                              child: CircularProgressIndicator(
                                color: Colors.white,
                                strokeWidth: 3,
                              ),
                            )
                                : const Text(
                              'Continue with PayPal',
                              style: TextStyle(
                                fontSize: 16,
                                fontWeight: FontWeight.w800,
                              ),
                            ),
                          ),
                        ),

                        const SizedBox(height: 13),

                        SizedBox(
                          width: double.infinity,
                          height: 58,
                          child: ElevatedButton.icon(
                            onPressed: isLoading || priceLoading
                                ? null
                                : handleStripePayment,
                            icon: const Icon(Icons.credit_card_rounded),
                            label: Text(
                              _usesHostedStripeCheckout
                                  ? 'Continue to Secure Checkout'
                                  : 'Continue with Card',
                            ),
                            style: ElevatedButton.styleFrom(
                              backgroundColor: planColors.last,
                              foregroundColor: Colors.white,
                              shape: RoundedRectangleBorder(
                                borderRadius: BorderRadius.circular(20),
                              ),
                              textStyle: const TextStyle(
                                fontSize: 16,
                                fontWeight: FontWeight.w800,
                              ),
                            ),
                          ),
                        ),
                      ],
                      const SizedBox(height: 22),

                      Container(
                        width: double.infinity,
                        padding: const EdgeInsets.all(18),
                        decoration: BoxDecoration(
                          color: Colors.white.withValues(alpha: 0.045),
                          borderRadius: BorderRadius.circular(22),
                          border: Border.all(
                            color: Colors.white.withValues(alpha: 0.09),
                          ),
                        ),
                        child: const Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Row(
                              children: [
                                Icon(
                                  Icons.policy_rounded,
                                  color: Color(0xFFE100FF),
                                  size: 21,
                                ),
                                SizedBox(width: 9),
                                Text(
                                  'Payment & Cancellation Policy',
                                  style: TextStyle(
                                    color: Colors.white,
                                    fontSize: 16,
                                    fontWeight: FontWeight.w800,
                                  ),
                                ),
                              ],
                            ),

                            SizedBox(height: 14),

                            _PolicyRow(
                              icon: Icons.calendar_month_rounded,
                              text: 'Your payment provides 30 days of plan access.',
                            ),

                            _PolicyRow(
                              icon: Icons.autorenew_rounded,
                              text: 'Automatic renewal is not enabled yet.',
                            ),

                            _PolicyRow(
                              icon: Icons.cancel_outlined,
                              text: 'You may cancel your plan at any time.',
                            ),

                            _PolicyRow(
                              icon: Icons.payments_outlined,
                              text: 'Completed payments are generally non-refundable, except where required by applicable law.',
                            ),

                            _PolicyRow(
                              icon: Icons.security_rounded,
                              text: 'Payments are securely processed by trusted payment providers.',
                            ),
                          ],
                        ),
                      ),


                      const SizedBox(height: 18),

                      const Center(
                        child: Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Icon(
                              Icons.lock_rounded,
                              color: Colors.white38,
                              size: 14,
                            ),
                            SizedBox(width: 6),
                            Text(
                              'Secure payment processing',
                              style: TextStyle(
                                color: Colors.white38,
                                fontSize: 12,
                              ),
                            ),
                          ],
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
class _PolicyRow extends StatelessWidget {
  final IconData icon;
  final String text;

  const _PolicyRow({
    required this.icon,
    required this.text,
  });

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 11),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(
            icon,
            color: Colors.white54,
            size: 18,
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              text,
              style: const TextStyle(
                color: Colors.white60,
                fontSize: 13,
                height: 1.45,
              ),
            ),
          ),
        ],
      ),
    );
  }
}