// Runs the whole booking flow offline with simulated PayPal and prints what happens at each step.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config, loadBusiness } from './config.js';
import { createStore } from './store.js';
import { fakePayPal } from './paypal.js';
import { createMailer } from './email.js';
import { createApp } from './app.js';
import { formatMoney } from './booking.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deposit-booking-'));
const business = loadBusiness();
const app = createApp({
  business,
  store: createStore(tmp),
  paypal: fakePayPal(),
  sendMail: createMailer({ smtpUrl: '', mailFrom: config.mailFrom, outboxDir: path.join(config.root, 'outbox') }),
  log: (m) => console.log('   ·', m),
});

// Next Tuesday, so the salon is open regardless of when you run this.
const d = new Date();
d.setDate(d.getDate() + ((9 - d.getDay()) % 7 || 7));
const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

console.log(`\n${business.name} — demo run (PayPal simulated)\n`);
console.log('1) Services and deposits');
for (const s of app.publicConfig().services) {
  console.log(`   ${s.name.padEnd(20)} ${formatMoney(s.priceCents).padStart(7)}  deposit ${formatMoney(s.depositCents)}`);
}

const slots = app.slots('cut', date);
console.log(`\n2) Free "Haircut & Style" slots on ${date}: ${slots.slice(0, 6).join(', ')} …`);

console.log(`\n3) Customer books ${slots[0]} -> pending booking + PayPal order`);
const { bookingId, orderId } = await app.startBooking({ serviceId: 'cut', date, start: slots[0], name: 'Jamie Rivera', email: 'jamie@example.com', phone: '555-0100' });
console.log(`   booking ${bookingId} (pending), order ${orderId}`);
console.log(`   ${slots[0]} still offered to others? ${app.slots('cut', date).includes(slots[0]) ? 'yes' : 'no (held)'}`);

console.log('\n4) Customer approves in popup -> server captures deposit');
await app.captureDeposit(orderId);

console.log('\n5) PayPal webhook PAYMENT.CAPTURE.COMPLETED arrives (duplicate-safe)');
console.log('  ', await app.handleWebhook({}, {
  event_type: 'PAYMENT.CAPTURE.COMPLETED',
  resource: { id: `CAP-${orderId}`, custom_id: bookingId, amount: { value: '16.25' }, supplementary_data: { related_ids: { order_id: orderId } } },
}));

console.log('\n6) Second customer starts a booking but never pays (stays pending)');
await app.startBooking({ serviceId: 'brow', date, start: '14:00', name: 'Sam Lee', email: 'sam@example.com' });

const day = app.adminDay(date);
console.log(`\n7) Admin daily schedule for ${date}`);
for (const b of day.schedule) console.log(`   ${b.start}  ${b.status.padEnd(9)} ${b.name.padEnd(14)} ${b.serviceName}`);
console.log(`   confirmed ${day.confirmedCount}, pending ${day.pendingCount}, deposits ${formatMoney(day.depositsCollectedCents)}, balance due ${formatMoney(day.balanceDueCents)}\n`);

fs.rmSync(tmp, { recursive: true, force: true });
