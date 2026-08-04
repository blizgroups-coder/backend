import 'dart:async';
import 'dart:convert';

import 'package:app_links/app_links.dart';
import 'package:flutter/material.dart';
import 'package:flutter_stripe/flutter_stripe.dart';
import 'package:http/http.dart' as http;
import 'package:supabase_flutter/supabase_flutter.dart';
import 'package:url_launcher/url_launcher.dart';

/// Centralized Tunevora subscription payment service.
///
/// This service handles:
/// - Stripe Payment Sheet
/// - PayPal browser approval + Tunevora deep-link return
/// - Railway API requests
/// - Subscription activation confirmation
///
/// IMPORTANT:
/// - Never place Stripe secret keys, PayPal secrets, or the Supabase
///   service-role key inside Flutter.
/// - The server remains the source of truth for prices and activation.
class PaymentService {
  PaymentService._();

  static const String baseUrl =
      'https://backend-production-1391.up.railway.app';

  static const Duration _requestTimeout = Duration(seconds: 35);
  static const Duration _paypalApprovalTimeout = Duration(minutes: 10);
  static const Duration _activationTimeout = Duration(seconds: 35);
  static const Duration _activationPollDelay = Duration(seconds: 2);

  static final SupabaseClient _supabase = Supabase.instance.client;
  static final AppLinks _appLinks = AppLinks();

  static const Set<String> _allowedPlans = <String>{
    'standard',
    'premium',
    'lossless',
    'hires',
  };

  /// Starts and completes a Stripe subscription payment.
  ///
  /// A successful Payment Sheet result is followed by a short server
  /// activation check because subscription access is granted by the
  /// verified Stripe webhook.
  static Future<PaymentResult> payWithStripe({
    required String plan,
    required String country,
  }) async {
    final normalizedPlan = _normalizePlan(plan);
    final normalizedCountry = _normalizeCountry(country);
    final user = _requireUser();

    try {
      final intent = await _createStripePaymentIntent(
        userId: user.id,
        plan: normalizedPlan,
        country: normalizedCountry,
      );

      await Stripe.instance.initPaymentSheet(
        paymentSheetParameters: SetupPaymentSheetParameters(
          merchantDisplayName: 'Tunevora',
          paymentIntentClientSecret: intent.clientSecret,
          style: ThemeMode.dark,
          allowsDelayedPaymentMethods: false,
        ),
      );

      await Stripe.instance.presentPaymentSheet();

      final activated = await waitForPlanActivation(
        plan: normalizedPlan,
        timeout: _activationTimeout,
      );

      if (!activated) {
        return PaymentResult.processing(
          provider: PaymentProvider.stripe,
          plan: normalizedPlan,
          amount: intent.amount,
          currency: intent.currency,
          reference: intent.paymentIntentId,
          message:
          'Your card payment was accepted and Tunevora is confirming your subscription.',
        );
      }

      return PaymentResult.success(
        provider: PaymentProvider.stripe,
        plan: normalizedPlan,
        amount: intent.amount,
        currency: intent.currency,
        reference: intent.paymentIntentId,
        message: '${_planTitle(normalizedPlan)} activated for 30 days.',
      );
    } on StripeException catch (error) {
      final code = error.error.code;
      final message = error.error.localizedMessage?.trim();

      if (code == FailureCode.Canceled) {
        return PaymentResult.cancelled(
          provider: PaymentProvider.stripe,
          plan: normalizedPlan,
          message: 'Card payment was cancelled.',
        );
      }

      throw PaymentServiceException(
        message == null || message.isEmpty
            ? 'Stripe could not complete the payment.'
            : message,
        cause: error,
      );
    } on PaymentServiceException {
      rethrow;
    } catch (error) {
      throw PaymentServiceException(
        'Stripe payment could not be completed.',
        cause: error,
      );
    }
  }

  /// Starts and completes a PayPal subscription payment.
  ///
  /// Flow:
  /// 1. Server creates an order using the real Supabase price.
  /// 2. Tunevora opens PayPal.
  /// 3. PayPal redirects to tunevora://success or tunevora://cancel.
  /// 4. Tunevora captures the approved order on the server.
  static Future<PaymentResult> payWithPayPal({
    required String plan,
    required String country,
  }) async {
    final normalizedPlan = _normalizePlan(plan);
    final normalizedCountry = _normalizeCountry(country);
    final user = _requireUser();

    StreamSubscription<Uri>? linkSubscription;
    final linkCompleter = Completer<Uri>();

    try {
      // Start listening before opening PayPal so no return link is missed.
      linkSubscription = _appLinks.uriLinkStream.listen(
            (uri) {
          if (_isPaymentReturnUri(uri) && !linkCompleter.isCompleted) {
            linkCompleter.complete(uri);
          }
        },
        onError: (Object error, StackTrace stackTrace) {
          if (!linkCompleter.isCompleted) {
            linkCompleter.completeError(error, stackTrace);
          }
        },
      );

      final order = await _createPayPalOrder(
        userId: user.id,
        plan: normalizedPlan,
        country: normalizedCountry,
      );

      final opened = await launchUrl(
        Uri.parse(order.approvalUrl),
        mode: LaunchMode.externalApplication,
      );

      if (!opened) {
        throw const PaymentServiceException(
          'PayPal could not be opened on this device.',
        );
      }

      final returnUri = await linkCompleter.future.timeout(
        _paypalApprovalTimeout,
        onTimeout: () {
          throw const PaymentServiceException(
            'PayPal approval timed out. No payment was captured.',
          );
        },
      );

      if (_isPayPalCancelUri(returnUri)) {
        return PaymentResult.cancelled(
          provider: PaymentProvider.paypal,
          plan: normalizedPlan,
          amount: order.amount,
          currency: order.currency,
          reference: order.orderId,
          message: 'PayPal payment was cancelled.',
        );
      }

      if (!_isPayPalSuccessUri(returnUri)) {
        throw const PaymentServiceException(
          'Tunevora received an invalid PayPal return link.',
        );
      }

      final capture = await _capturePayPalOrder(
        orderId: order.orderId,
        userId: user.id,
      );

      if (!capture.success) {
        throw PaymentServiceException(
          capture.message.isEmpty
              ? 'PayPal payment was not completed.'
              : capture.message,
        );
      }

      final activated = await waitForPlanActivation(
        plan: normalizedPlan,
        timeout: _activationTimeout,
      );

      if (!activated) {
        return PaymentResult.processing(
          provider: PaymentProvider.paypal,
          plan: normalizedPlan,
          amount: capture.amount ?? order.amount,
          currency: capture.currency ?? order.currency,
          reference: capture.reference ?? order.orderId,
          message:
          'PayPal approved your payment and Tunevora is confirming your subscription.',
        );
      }

      return PaymentResult.success(
        provider: PaymentProvider.paypal,
        plan: normalizedPlan,
        amount: capture.amount ?? order.amount,
        currency: capture.currency ?? order.currency,
        reference: capture.reference ?? order.orderId,
        message: '${_planTitle(normalizedPlan)} activated for 30 days.',
      );
    } on PaymentServiceException {
      rethrow;
    } on TimeoutException catch (error) {
      throw PaymentServiceException(
        'PayPal approval timed out. No payment was captured.',
        cause: error,
      );
    } catch (error) {
      throw PaymentServiceException(
        'PayPal payment could not be completed.',
        cause: error,
      );
    } finally {
      await linkSubscription?.cancel();
    }
  }

  /// Polls Supabase until the selected plan is active.
  ///
  /// Stripe activation is webhook-driven, so a brief delay can occur after
  /// Payment Sheet closes.
  static Future<bool> waitForPlanActivation({
    required String plan,
    Duration timeout = _activationTimeout,
  }) async {
    final normalizedPlan = _normalizePlan(plan);
    final user = _requireUser();
    final deadline = DateTime.now().add(timeout);

    while (DateTime.now().isBefore(deadline)) {
      try {
        final profile = await _supabase
            .from('profiles')
            .select('plan, premium_until, is_premium')
            .eq('id', user.id)
            .maybeSingle();

        if (profile != null) {
          final currentPlan =
          (profile['plan'] ?? 'free').toString().trim().toLowerCase();

          final premiumUntil = DateTime.tryParse(
            (profile['premium_until'] ?? '').toString(),
          );

          final isPremium = profile['is_premium'] == true;
          final hasValidExpiry =
              premiumUntil != null && premiumUntil.isAfter(DateTime.now());

          if (currentPlan == normalizedPlan && isPremium && hasValidExpiry) {
            return true;
          }
        }
      } catch (_) {
        // A transient read failure should not immediately fail a paid flow.
      }

      await Future<void>.delayed(_activationPollDelay);
    }

    return false;
  }

  static Future<_StripeIntentData> _createStripePaymentIntent({
    required String userId,
    required String plan,
    required String country,
  }) async {
    final response = await _postJson(
      '/create-payment-intent',
      <String, dynamic>{
        'user_id': userId,
        'plan': plan,
        'country': country,
      },
    );

    final clientSecret = _readRequiredString(
      response,
      'clientSecret',
      fallbackMessage: 'Stripe did not return a client secret.',
    );

    final paymentIntentId = _readRequiredString(
      response,
      'paymentIntentId',
      fallbackMessage: 'Stripe did not return a payment reference.',
    );

    return _StripeIntentData(
      clientSecret: clientSecret,
      paymentIntentId: paymentIntentId,
      amount: _readNullableDouble(response['amount']),
      currency: _readNullableString(response['currency'])?.toUpperCase(),
    );
  }

  static Future<_PayPalOrderData> _createPayPalOrder({
    required String userId,
    required String plan,
    required String country,
  }) async {
    final response = await _postJson(
      '/create-order',
      <String, dynamic>{
        'user_id': userId,
        'plan': plan,
        'country': country,
      },
    );

    final orderId = _readRequiredString(
      response,
      'id',
      fallbackMessage: 'PayPal did not return an order ID.',
    );

    final links = response['links'];
    String? approvalUrl;

    if (links is List) {
      for (final rawLink in links) {
        if (rawLink is! Map) continue;

        final link = Map<String, dynamic>.from(rawLink);
        final relation = link['rel']?.toString().toLowerCase();
        final href = link['href']?.toString().trim();

        if ((relation == 'approve' || relation == 'payer-action') &&
            href != null &&
            href.isNotEmpty) {
          approvalUrl = href;
          break;
        }
      }
    }

    if (approvalUrl == null) {
      throw const PaymentServiceException(
        'PayPal did not return an approval link.',
      );
    }

    return _PayPalOrderData(
      orderId: orderId,
      approvalUrl: approvalUrl,
      amount: _readNullableDouble(response['amount']),
      currency: _readNullableString(response['currency'])?.toUpperCase(),
    );
  }

  static Future<_PayPalCaptureData> _capturePayPalOrder({
    required String orderId,
    required String userId,
  }) async {
    final response = await _postJson(
      '/capture-order',
      <String, dynamic>{
        'orderID': orderId,
        'user_id': userId,
      },
    );

    return _PayPalCaptureData(
      success: response['success'] == true,
      message: _readNullableString(response['message']) ?? '',
      amount: _readNullableDouble(response['amount']),
      currency: _readNullableString(response['currency'])?.toUpperCase(),
      reference: _readNullableString(response['transaction_reference']) ??
          _readNullableString(response['reference']),
    );
  }

  static Future<Map<String, dynamic>> _postJson(
      String path,
      Map<String, dynamic> body,
      ) async {
    final uri = Uri.parse('$baseUrl$path');

    http.Response response;

    try {
      response = await http
          .post(
        uri,
        headers: const <String, String>{
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: jsonEncode(body),
      )
          .timeout(_requestTimeout);
    } on TimeoutException catch (error) {
      throw PaymentServiceException(
        'The payment server took too long to respond.',
        cause: error,
      );
    } catch (error) {
      throw PaymentServiceException(
        'Could not connect to the Tunevora payment server.',
        cause: error,
      );
    }

    Map<String, dynamic> data = <String, dynamic>{};

    if (response.body.trim().isNotEmpty) {
      try {
        final decoded = jsonDecode(response.body);
        if (decoded is Map) {
          data = Map<String, dynamic>.from(decoded);
        }
      } catch (_) {
        throw PaymentServiceException(
          'The payment server returned an invalid response.',
          statusCode: response.statusCode,
        );
      }
    }

    if (response.statusCode < 200 || response.statusCode >= 300) {
      final message = _readNullableString(data['error']) ??
          _readNullableString(data['message']) ??
          _readNestedErrorMessage(data['details']) ??
          'Payment request failed.';

      throw PaymentServiceException(
        message,
        statusCode: response.statusCode,
      );
    }

    return data;
  }

  static User _requireUser() {
    final user = _supabase.auth.currentUser;

    if (user == null) {
      throw const PaymentServiceException(
        'Please sign in before making a payment.',
      );
    }

    return user;
  }

  static String _normalizePlan(String plan) {
    final normalized = plan.trim().toLowerCase();

    if (!_allowedPlans.contains(normalized)) {
      throw const PaymentServiceException(
        'The selected Tunevora plan is invalid.',
      );
    }

    return normalized;
  }

  static String _normalizeCountry(String country) {
    final normalized = country.trim().toUpperCase();

    if (normalized.isEmpty) return 'US';
    return normalized;
  }

  static bool _isPaymentReturnUri(Uri uri) {
    if (uri.scheme.toLowerCase() != 'tunevora') return false;

    final host = uri.host.toLowerCase();
    return host == 'success' || host == 'cancel';
  }

  static bool _isPayPalSuccessUri(Uri uri) {
    return uri.scheme.toLowerCase() == 'tunevora' &&
        uri.host.toLowerCase() == 'success';
  }

  static bool _isPayPalCancelUri(Uri uri) {
    return uri.scheme.toLowerCase() == 'tunevora' &&
        uri.host.toLowerCase() == 'cancel';
  }

  static String _readRequiredString(
      Map<String, dynamic> source,
      String key, {
        required String fallbackMessage,
      }) {
    final value = _readNullableString(source[key]);

    if (value == null) {
      throw PaymentServiceException(fallbackMessage);
    }

    return value;
  }

  static String? _readNullableString(dynamic value) {
    final text = value?.toString().trim();

    if (text == null || text.isEmpty || text.toLowerCase() == 'null') {
      return null;
    }

    return text;
  }

  static double? _readNullableDouble(dynamic value) {
    if (value is num) return value.toDouble();
    return double.tryParse(value?.toString() ?? '');
  }

  static String? _readNestedErrorMessage(dynamic details) {
    if (details is Map) {
      final map = Map<String, dynamic>.from(details);
      return _readNullableString(map['message']) ??
          _readNullableString(map['error_description']) ??
          _readNullableString(map['name']);
    }

    return _readNullableString(details);
  }

  static String _planTitle(String plan) {
    switch (plan) {
      case 'standard':
        return 'Standard';
      case 'premium':
        return 'Premium';
      case 'lossless':
        return 'Lossless';
      case 'hires':
        return 'Hi-Res';
      default:
        return 'Tunevora';
    }
  }
}

enum PaymentProvider {
  stripe,
  paypal,
}

enum PaymentStatus {
  success,
  processing,
  cancelled,
}

class PaymentResult {
  const PaymentResult._({
    required this.status,
    required this.provider,
    required this.plan,
    required this.message,
    this.amount,
    this.currency,
    this.reference,
  });

  factory PaymentResult.success({
    required PaymentProvider provider,
    required String plan,
    required String message,
    double? amount,
    String? currency,
    String? reference,
  }) {
    return PaymentResult._(
      status: PaymentStatus.success,
      provider: provider,
      plan: plan,
      message: message,
      amount: amount,
      currency: currency,
      reference: reference,
    );
  }

  factory PaymentResult.processing({
    required PaymentProvider provider,
    required String plan,
    required String message,
    double? amount,
    String? currency,
    String? reference,
  }) {
    return PaymentResult._(
      status: PaymentStatus.processing,
      provider: provider,
      plan: plan,
      message: message,
      amount: amount,
      currency: currency,
      reference: reference,
    );
  }

  factory PaymentResult.cancelled({
    required PaymentProvider provider,
    required String plan,
    required String message,
    double? amount,
    String? currency,
    String? reference,
  }) {
    return PaymentResult._(
      status: PaymentStatus.cancelled,
      provider: provider,
      plan: plan,
      message: message,
      amount: amount,
      currency: currency,
      reference: reference,
    );
  }

  final PaymentStatus status;
  final PaymentProvider provider;
  final String plan;
  final String message;
  final double? amount;
  final String? currency;
  final String? reference;

  bool get isSuccess => status == PaymentStatus.success;
  bool get isProcessing => status == PaymentStatus.processing;
  bool get isCancelled => status == PaymentStatus.cancelled;
}

class PaymentServiceException implements Exception {
  const PaymentServiceException(
      this.message, {
        this.statusCode,
        this.cause,
      });

  final String message;
  final int? statusCode;
  final Object? cause;

  @override
  String toString() => message;
}

class _StripeIntentData {
  const _StripeIntentData({
    required this.clientSecret,
    required this.paymentIntentId,
    this.amount,
    this.currency,
  });

  final String clientSecret;
  final String paymentIntentId;
  final double? amount;
  final String? currency;
}

class _PayPalOrderData {
  const _PayPalOrderData({
    required this.orderId,
    required this.approvalUrl,
    this.amount,
    this.currency,
  });

  final String orderId;
  final String approvalUrl;
  final double? amount;
  final String? currency;
}

class _PayPalCaptureData {
  const _PayPalCaptureData({
    required this.success,
    required this.message,
    this.amount,
    this.currency,
    this.reference,
  });

  final bool success;
  final String message;
  final double? amount;
  final String? currency;
  final String? reference;
}