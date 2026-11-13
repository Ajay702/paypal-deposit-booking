// Pure booking logic: deposits, time slots, and status changes. No I/O here.

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

export const toMinutes = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

export const toHHMM = (mins) =>
  `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;

export const formatMoney = (cents) => (cents / 100).toFixed(2);

/** Deposit = percent of price, at least the minimum, never more than the price. */
export function depositCents(priceCents, { depositPercent, minDepositCents = 0 }) {
  const pct = Math.round((priceCents * depositPercent) / 100);
  return Math.min(priceCents, Math.max(pct, minDepositCents));
}

export function findService(business, serviceId) {
  return business.services.find((s) => s.id === serviceId) || null;
}

/** A booking blocks its time if it is confirmed, or pending and still inside the hold window. */
export function isActive(booking, business, now = new Date()) {
  if (booking.status === 'confirmed') return true;
  if (booking.status !== 'pending') return false;
  const ageMin = (now - new Date(booking.createdAt)) / 60000;
  return ageMin < business.holdMinutes;
}

const localDate = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Free start times ("HH:MM") for a service on a date ("YYYY-MM-DD"), business-local time. */
export function availableSlots({ business, service, date, bookings, now = new Date() }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return [];
  const [y, mo, d] = date.split('-').map(Number);
  const day = DAYS[new Date(y, mo - 1, d).getDay()];
  const hours = business.hours[day];
  if (!hours) return [];

  const today = localDate(now);
  if (date < today) return [];
  const nowMin = date === today ? now.getHours() * 60 + now.getMinutes() : -1;

  const open = toMinutes(hours[0]);
  const close = toMinutes(hours[1]);
  const taken = bookings
    .filter((b) => b.date === date && isActive(b, business, now))
    .map((b) => [toMinutes(b.start), toMinutes(b.start) + b.durationMin]);

  const slots = [];
  for (let t = open; t + service.durationMin <= close; t += business.slotMinutes) {
    if (t <= nowMin) continue;
    const end = t + service.durationMin;
    if (taken.some(([s, e]) => t < e && s < end)) continue;
    slots.push(toHHMM(t));
  }
  return slots;
}

/** Build a new pending booking after validating input and that the slot is still free. */
export function createBooking({ business, bookings, input, id, now = new Date() }) {
  const service = findService(business, input.serviceId);
  if (!service) throw new BookingError('Unknown service');
  for (const field of ['name', 'email', 'date', 'start']) {
    if (!input[field] || typeof input[field] !== 'string') throw new BookingError(`Missing ${field}`);
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email)) throw new BookingError('Invalid email');
  const free = availableSlots({ business, service, date: input.date, bookings, now });
  if (!free.includes(input.start)) throw new BookingError('That time is no longer available');

  return {
    id,
    status: 'pending',
    serviceId: service.id,
    serviceName: service.name,
    priceCents: service.priceCents,
    depositCents: depositCents(service.priceCents, business),
    currency: business.currency,
    durationMin: service.durationMin,
    date: input.date,
    start: input.start,
    name: input.name.trim().slice(0, 100),
    email: input.email.trim().slice(0, 200),
    phone: (input.phone || '').trim().slice(0, 40),
    orderId: null,
    captureId: null,
    createdAt: now.toISOString(),
    confirmedAt: null,
    emailsSent: false,
  };
}

/**
 * Move a booking from pending to confirmed once the deposit is captured.
 * Idempotent: the capture call and the webhook can both arrive; only the first changes anything.
 */
export function confirmBooking(booking, { captureId, amountValue }, now = new Date()) {
  if (booking.status === 'confirmed') return { booking, changed: false };
  if (amountValue != null && amountValue !== formatMoney(booking.depositCents)) {
    throw new BookingError(`Captured amount ${amountValue} does not match deposit ${formatMoney(booking.depositCents)}`);
  }
  return {
    booking: { ...booking, status: 'confirmed', captureId, confirmedAt: now.toISOString() },
    changed: true,
  };
}

/** Find which booking a PayPal webhook event refers to. Returns null for events we ignore. */
export function bookingRefFromWebhook(event) {
  if (event?.event_type !== 'PAYMENT.CAPTURE.COMPLETED') return null;
  const r = event.resource || {};
  return {
    bookingId: r.custom_id || null,
    orderId: r.supplementary_data?.related_ids?.order_id || null,
    captureId: r.id,
    amountValue: r.amount?.value ?? null,
  };
}

/** Admin summary for one day: schedule sorted by time plus deposit totals. */
export function daySummary(bookings, date) {
  const day = bookings
    .filter((b) => b.date === date && b.status !== 'expired')
    .sort((a, b) => a.start.localeCompare(b.start));
  const confirmed = day.filter((b) => b.status === 'confirmed');
  return {
    date,
    schedule: day,
    confirmedCount: confirmed.length,
    pendingCount: day.length - confirmed.length,
    depositsCollectedCents: confirmed.reduce((sum, b) => sum + b.depositCents, 0),
    balanceDueCents: confirmed.reduce((sum, b) => sum + b.priceCents - b.depositCents, 0),
  };
}

export class BookingError extends Error {}
