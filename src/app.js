// The booking flow, wired to storage, PayPal and email. Used by both the HTTP server and the CLI demo.
import crypto from 'node:crypto';
import {
  availableSlots, bookingRefFromWebhook, confirmBooking, createBooking, daySummary,
  depositCents, findService, formatMoney, BookingError,
} from './booking.js';
import { captureFromOrder } from './paypal.js';
import { confirmationEmails } from './email.js';

export function createApp({ business, store, paypal, sendMail, log = console.log }) {
  async function finalize(booking, capture) {
    const { booking: updated, changed } = confirmBooking(booking, capture);
    if (!changed) return booking;
    store.put(updated);
    log(`booking ${updated.id} confirmed (capture ${updated.captureId})`);
    if (!updated.emailsSent) {
      for (const msg of confirmationEmails(updated, business)) log(`email ${await sendMail(msg)}`);
      store.put({ ...updated, emailsSent: true });
    }
    return store.get(updated.id);
  }

  return {
    publicConfig: () => ({
      name: business.name,
      tagline: business.tagline,
      brandColor: business.brandColor,
      currency: business.currency,
      services: business.services.map((s) => ({ ...s, depositCents: depositCents(s.priceCents, business) })),
    }),

    slots(serviceId, date) {
      const service = findService(business, serviceId);
      if (!service) throw new BookingError('Unknown service');
      return availableSlots({ business, service, date, bookings: store.all() });
    },

    /** Step 1: reserve the slot as "pending" and open a PayPal order for the deposit. */
    async startBooking(input) {
      const booking = createBooking({ business, bookings: store.all(), input, id: `bk_${crypto.randomUUID().slice(0, 8)}` });
      store.put(booking); // holds the slot for holdMinutes while the customer pays
      const order = await paypal.createOrder({
        bookingId: booking.id,
        amountValue: formatMoney(booking.depositCents),
        currency: booking.currency,
        description: `Deposit: ${booking.serviceName} ${booking.date} ${booking.start}`.slice(0, 127),
      });
      store.put({ ...booking, orderId: order.id });
      return { bookingId: booking.id, orderId: order.id };
    },

    /** Step 2: customer approved in the PayPal popup -> capture the money right away. */
    async captureDeposit(orderId) {
      const booking = store.findByOrder(orderId);
      if (!booking) throw new BookingError('Unknown order');
      if (booking.status === 'confirmed') return booking;
      const capture = captureFromOrder(await paypal.captureOrder(orderId));
      if (!capture) throw new BookingError('Payment was not completed');
      return finalize(booking, capture);
    },

    /** Step 3: PayPal webhook PAYMENT.CAPTURE.COMPLETED -> confirm (safety net if the browser closed). */
    async handleWebhook(headers, event) {
      if (!(await paypal.verifyWebhook(headers, event))) throw new BookingError('Webhook signature invalid');
      const ref = bookingRefFromWebhook(event);
      if (!ref) return { ignored: event?.event_type };
      const booking = (ref.bookingId && store.get(ref.bookingId)) || (ref.orderId && store.findByOrder(ref.orderId));
      if (!booking) return { ignored: 'no matching booking' };
      const updated = await finalize(booking, ref);
      return { bookingId: updated.id, status: updated.status };
    },

    adminDay: (date) => daySummary(store.all(), date),
    adminAll: () => store.all().sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start)),
  };
}
