const express = require('express');
const router = express.Router();

const { requireAuth } = require('../middleware/auth');
const logger = require('../utils/logger');
const { dbGet } = require('../db');

const { paddleRequest } = require('../services/billing/paddleClient');
const { verifyPaddleWebhook } = require('../services/billing/paddleWebhook');
const { ensureBillingAccount, updateBillingAccount } = require('../services/billing/billingAccount');
const { createNotification } = require('../services/notifications');

function getPriceIdForPlan(planKey) {
  const key = String(planKey || '').toLowerCase();
  if (key === 'starter') return process.env.PADDLE_PRICE_STARTER;
  return null;
}

/**
 * GET /api/billing/status
 * Returns current billing status for logged-in user.
 */
router.get('/status', requireAuth, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const acct = await ensureBillingAccount(userId);
    res.json({
      success: true,
      billing: {
        provider: acct.provider,
        plan_key: acct.plan_key,
        status: acct.status,
        current_period_end: acct.current_period_end,
        grace_period_ends_at: acct.grace_period_ends_at
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/billing/checkout
 * Body: { plan_key: "starter" }
 * Returns a hosted checkout URL.
 */
router.post('/checkout', requireAuth, express.json(), async (req, res) => {
  try {
    const userId = req.session.user.id;
    const planKey = String(req.body?.plan_key || 'starter').toLowerCase();
    const priceId = getPriceIdForPlan(planKey);
    if (!priceId) return res.status(400).json({ error: 'Unknown plan_key' });

    const user = await dbGet('SELECT id, email, username FROM users WHERE id = ?', [userId]);
    if (!user) return res.status(401).json({ error: 'Not authenticated' });
    if (!user.email) return res.status(400).json({ error: 'User email is required for billing' });

    await ensureBillingAccount(userId);

    // Paddle Billing: create a transaction for a recurring price; Paddle creates a subscription.
    const payload = {
      items: [{ price_id: priceId, quantity: 1 }],
      customer: { email: user.email },
      custom_data: { user_id: user.id, username: user.username, plan_key: planKey }
    };

    const data = await paddleRequest('POST', '/transactions', payload);
    const checkoutUrl = data?.data?.checkout?.url;
    if (!checkoutUrl) {
      logger.error(`Paddle checkout missing url: ${JSON.stringify(data)?.slice(0, 500)}`);
      return res.status(502).json({ error: 'Billing provider error: missing checkout url' });
    }

    // Record user's intended plan (activated by webhook once paid)
    await updateBillingAccount(userId, { plan_key: planKey });

    res.json({ success: true, checkout_url: checkoutUrl });
  } catch (e) {
    logger.error(`Billing checkout error: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/billing/webhook
 * Paddle sends JSON with signature header "Paddle-Signature".
 */
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const secret = process.env.PADDLE_WEBHOOK_SECRET;
    const signatureHeader = req.get('Paddle-Signature') || req.get('paddle-signature');
    const verification = verifyPaddleWebhook({ signatureHeader, rawBody: req.body, secret });
    if (!verification.ok) {
      logger.warn(`Paddle webhook rejected: ${verification.reason}`);
      return res.status(401).send('invalid signature');
    }

    const event = JSON.parse(req.body.toString('utf8'));
    const eventType = event?.event_type || event?.eventType;
    const data = event?.data || {};

    // We rely on custom_data.user_id from checkout.
    const userId = data?.custom_data?.user_id || data?.custom_data?.userId;
    if (!userId) {
      logger.warn(`Paddle webhook missing custom_data.user_id for ${eventType}`);
      return res.status(200).json({ received: true });
    }

    await ensureBillingAccount(userId);

    // Minimal event handling for sell-ready gating
    if (eventType === 'subscription.created' || eventType === 'subscription.updated') {
      const status = String(data?.status || '').toLowerCase();
      const mapped =
        status === 'active' ? 'active' :
        status === 'past_due' ? 'past_due' :
        status === 'canceled' ? 'canceled' :
        'inactive';

      const periodEnd = data?.current_billing_period?.ends_at || data?.current_period?.ends_at || null;
      await updateBillingAccount(userId, {
        status: mapped,
        paddle_customer_id: data?.customer_id || data?.customer?.id || null,
        paddle_subscription_id: data?.id || data?.subscription_id || null,
        current_period_end: periodEnd,
        grace_period_ends_at: null
      });

      await createNotification(userId, 'billing_update', `Billing updated: ${mapped}`);
    }

    if (eventType === 'subscription.canceled' || eventType === 'subscription.deleted') {
      await updateBillingAccount(userId, { status: 'canceled' });
      await createNotification(userId, 'billing_update', 'Subscription canceled');
    }

    if (eventType === 'transaction.payment_failed' || eventType === 'invoice.payment_failed') {
      const graceDays = parseInt(process.env.BILLING_GRACE_DAYS || '3', 10);
      const graceEnds = new Date(Date.now() + graceDays * 24 * 60 * 60 * 1000).toISOString();
      await updateBillingAccount(userId, { status: 'past_due', grace_period_ends_at: graceEnds });
      await createNotification(userId, 'billing_payment_failed', `Payment failed. Update payment method. Grace until ${graceEnds}.`);
    }

    if (eventType === 'transaction.paid' || eventType === 'invoice.paid') {
      await updateBillingAccount(userId, { status: 'active', grace_period_ends_at: null });
      await createNotification(userId, 'billing_payment_ok', 'Payment received. Subscription active.');
    }

    res.json({ received: true });
  } catch (e) {
    logger.error(`Paddle webhook error: ${e.message}`);
    res.status(500).send('webhook error');
  }
});

module.exports = router;

