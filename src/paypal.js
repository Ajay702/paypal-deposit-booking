// PayPal REST calls (Orders v2, webhooks, v6 SDK client token), plus a fake for demo mode.
import crypto from 'node:crypto';

export function createPayPal(cfg) {
  return cfg.demo ? fakePayPal() : realPayPal(cfg.paypal);
}

function realPayPal({ clientId, clientSecret, webhookId, live }) {
  const api = live ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  async function token(extra = {}) {
    const res = await fetch(`${api}/v1/oauth2/token`, {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', ...extra }),
    });
    if (!res.ok) throw new Error(`PayPal auth failed: ${res.status} ${await res.text()}`);
    return (await res.json()).access_token;
  }

  async function call(method, pathname, body) {
    const res = await fetch(`${api}${pathname}`, {
      method,
      headers: {
        Authorization: `Bearer ${await token()}`,
        'Content-Type': 'application/json',
        'PayPal-Request-Id': crypto.randomUUID(),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`PayPal ${method} ${pathname} failed: ${res.status} ${JSON.stringify(json)}`);
    return json;
  }

  return {
    sdkUrl: live ? 'https://www.paypal.com/web-sdk/v6/core' : 'https://www.sandbox.paypal.com/web-sdk/v6/core',

    // Browser-safe token the v6 SDK needs for createInstance().
    clientToken: () => token({ response_type: 'client_token', intent: 'sdk_init' }),

    createOrder: ({ bookingId, amountValue, currency, description }) =>
      call('POST', '/v2/checkout/orders', {
        intent: 'CAPTURE',
        purchase_units: [
          { reference_id: bookingId, custom_id: bookingId, description, amount: { currency_code: currency, value: amountValue } },
        ],
      }),

    captureOrder: (orderId) => call('POST', `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`),

    async verifyWebhook(headers, event) {
      if (!webhookId) throw new Error('PAYPAL_WEBHOOK_ID is not set');
      const result = await call('POST', '/v1/notifications/verify-webhook-signature', {
        auth_algo: headers['paypal-auth-algo'],
        cert_url: headers['paypal-cert-url'],
        transmission_id: headers['paypal-transmission-id'],
        transmission_sig: headers['paypal-transmission-sig'],
        transmission_time: headers['paypal-transmission-time'],
        webhook_id: webhookId,
        webhook_event: event,
      });
      return result.verification_status === 'SUCCESS';
    },
  };
}

/** Mimics the response shapes we read from PayPal, so the whole flow runs offline. */
export function fakePayPal() {
  const orders = new Map();
  return {
    sdkUrl: null,
    clientToken: async () => 'demo-client-token',
    async createOrder({ bookingId, amountValue, currency }) {
      const id = `DEMO-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
      orders.set(id, { bookingId, amountValue, currency });
      return { id, status: 'CREATED' };
    },
    async captureOrder(orderId) {
      const o = orders.get(orderId);
      if (!o) throw new Error(`Unknown demo order ${orderId}`);
      return {
        id: orderId,
        status: 'COMPLETED',
        purchase_units: [
          {
            reference_id: o.bookingId,
            payments: {
              captures: [
                {
                  id: `CAP-${orderId}`,
                  status: 'COMPLETED',
                  custom_id: o.bookingId,
                  amount: { currency_code: o.currency, value: o.amountValue },
                },
              ],
            },
          },
        ],
      };
    },
    verifyWebhook: async () => true,
  };
}

/** Pull the capture details we care about out of an Orders v2 capture response. */
export function captureFromOrder(order) {
  const cap = order?.purchase_units?.[0]?.payments?.captures?.[0];
  if (order?.status !== 'COMPLETED' || !cap || cap.status !== 'COMPLETED') return null;
  return { captureId: cap.id, amountValue: cap.amount?.value ?? null };
}
