import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  availableSlots, bookingRefFromWebhook, confirmBooking, createBooking, daySummary, depositCents, BookingError,
} from '../src/booking.js';
import { createStore } from '../src/store.js';
import { fakePayPal } from '../src/paypal.js';
import { createApp } from '../src/app.js';

const business = {
  name: 'Test Salon', email: 'salon@example.com', currency: 'USD',
  depositPercent: 25, minDepositCents: 1000, slotMinutes: 30, holdMinutes: 15,
  hours: { mon: ['09:00', '12:00'], tue: ['09:00', '12:00'], wed: null, thu: null, fri: null, sat: null, sun: null },
  services: [
    { id: 'cut', name: 'Cut', priceCents: 6000, durationMin: 60 },
    { id: 'brow', name: 'Brow', priceCents: 2000, durationMin: 30 },
  ],
};
const cut = business.services[0];
const MONDAY = '2030-01-07';
const now = new Date(2030, 0, 1, 8, 0); // a week before, so no slots are "in the past"
const input = { serviceId: 'cut', date: MONDAY, start: '09:00', name: 'Ann', email: 'ann@example.com' };

test('deposit is a percentage, floored at the minimum and capped at the price', () => {
  assert.equal(depositCents(6000, business), 1500);
  assert.equal(depositCents(2000, business), 1000);
  assert.equal(depositCents(800, business), 800);
});

test('slots respect opening hours, service length and closed days', () => {
  assert.deepEqual(availableSlots({ business, service: cut, date: MONDAY, bookings: [], now }),
    ['09:00', '09:30', '10:00', '10:30', '11:00']);
  assert.deepEqual(availableSlots({ business, service: cut, date: '2030-01-09', bookings: [], now }), []);
});

test('confirmed and freshly-pending bookings block overlapping slots; stale pending ones do not', () => {
  const confirmed = { date: MONDAY, start: '10:00', durationMin: 60, status: 'confirmed', createdAt: now.toISOString() };
  assert.deepEqual(availableSlots({ business, service: cut, date: MONDAY, bookings: [confirmed], now }), ['09:00', '11:00']);

  const pending = { ...confirmed, status: 'pending' };
  const later = new Date(now.getTime() + 16 * 60000);
  assert.equal(availableSlots({ business, service: cut, date: MONDAY, bookings: [pending], now }).length, 2);
  assert.equal(availableSlots({ business, service: cut, date: MONDAY, bookings: [pending], now: later }).length, 5);
});

test('past times today are not offered', () => {
  const at930 = new Date(2030, 0, 7, 9, 30);
  assert.deepEqual(availableSlots({ business, service: cut, date: MONDAY, bookings: [], now: at930 }), ['10:00', '10:30', '11:00']);
});

test('createBooking validates input and rejects double booking', () => {
  const b = createBooking({ business, bookings: [], input, id: 'b1', now });
  assert.equal(b.status, 'pending');
  assert.equal(b.depositCents, 1500);
  assert.throws(() => createBooking({ business, bookings: [b], input, id: 'b2', now }), BookingError);
  assert.throws(() => createBooking({ business, bookings: [], input: { ...input, email: 'nope' }, id: 'b3', now }), /email/);
  assert.throws(() => createBooking({ business, bookings: [], input: { ...input, serviceId: 'x' }, id: 'b4', now }), /service/);
});

test('confirmBooking is idempotent and checks the captured amount', () => {
  const b = createBooking({ business, bookings: [], input, id: 'b1', now });
  const first = confirmBooking(b, { captureId: 'C1', amountValue: '15.00' });
  assert.equal(first.changed, true);
  assert.equal(first.booking.status, 'confirmed');
  assert.equal(confirmBooking(first.booking, { captureId: 'C1', amountValue: '15.00' }).changed, false);
  assert.throws(() => confirmBooking(b, { captureId: 'C1', amountValue: '1.00' }), /does not match/);
});

test('webhook parsing only accepts completed captures', () => {
  assert.equal(bookingRefFromWebhook({ event_type: 'CHECKOUT.ORDER.APPROVED' }), null);
  const ref = bookingRefFromWebhook({
    event_type: 'PAYMENT.CAPTURE.COMPLETED',
    resource: { id: 'C9', custom_id: 'b1', amount: { value: '15.00' }, supplementary_data: { related_ids: { order_id: 'O1' } } },
  });
  assert.deepEqual(ref, { bookingId: 'b1', orderId: 'O1', captureId: 'C9', amountValue: '15.00' });
});

test('daySummary totals deposits and balances for confirmed bookings', () => {
  const s = daySummary([
    { date: MONDAY, start: '10:00', status: 'confirmed', priceCents: 6000, depositCents: 1500 },
    { date: MONDAY, start: '09:00', status: 'pending', priceCents: 2000, depositCents: 1000 },
    { date: '2030-01-08', start: '09:00', status: 'confirmed', priceCents: 6000, depositCents: 1500 },
  ], MONDAY);
  assert.deepEqual(s.schedule.map((b) => b.start), ['09:00', '10:00']);
  assert.equal(s.confirmedCount, 1);
  assert.equal(s.depositsCollectedCents, 1500);
  assert.equal(s.balanceDueCents, 4500);
});

test('end-to-end: book -> capture -> webhook confirms once and sends two emails', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-test-'));
  const sent = [];
  const app = createApp({
    business, store: createStore(dir), paypal: fakePayPal(),
    sendMail: async (m) => { sent.push(m); return 'ok'; }, log: () => {},
  });
  const { bookingId, orderId } = await app.startBooking(input);
  assert.ok(!app.slots('cut', MONDAY).includes('09:00'), 'pending slot is held');

  const booking = await app.captureDeposit(orderId);
  assert.equal(booking.status, 'confirmed');
  assert.equal(booking.emailsSent, true);

  const res = await app.handleWebhook({}, {
    event_type: 'PAYMENT.CAPTURE.COMPLETED',
    resource: { id: booking.captureId, custom_id: bookingId, amount: { value: '15.00' } },
  });
  assert.deepEqual(res, { bookingId, status: 'confirmed' });
  assert.deepEqual(sent.map((m) => m.to), ['ann@example.com', 'salon@example.com']);
  fs.rmSync(dir, { recursive: true, force: true });
});
