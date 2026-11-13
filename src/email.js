// Confirmation emails. With SMTP_URL set they are sent; otherwise they are written to outbox/ as .eml files.
import fs from 'node:fs';
import path from 'node:path';
import { formatMoney } from './booking.js';

export function confirmationEmails(booking, business) {
  const money = (c) => `${formatMoney(c)} ${booking.currency}`;
  const when = `${booking.date} at ${booking.start}`;
  const balance = booking.priceCents - booking.depositCents;
  return [
    {
      to: booking.email,
      subject: `Booking confirmed: ${booking.serviceName} on ${when}`,
      text: [
        `Hi ${booking.name},`,
        '',
        `You're booked at ${business.name} for ${booking.serviceName} on ${when} (${booking.durationMin} min).`,
        `Deposit paid: ${money(booking.depositCents)}. Balance due at your visit: ${money(balance)}.`,
        '',
        `Booking reference: ${booking.id}`,
        `Need to change something? Reply to this email or contact ${business.email}.`,
      ].join('\n'),
    },
    {
      to: business.email,
      subject: `New booking: ${booking.name} - ${booking.serviceName} ${when}`,
      text: [
        `Customer: ${booking.name} <${booking.email}> ${booking.phone}`,
        `Service: ${booking.serviceName} (${booking.durationMin} min)`,
        `When: ${when}`,
        `Deposit captured: ${money(booking.depositCents)} (PayPal capture ${booking.captureId})`,
        `Balance due: ${money(balance)}`,
      ].join('\n'),
    },
  ];
}

export function createMailer({ smtpUrl, mailFrom, outboxDir }) {
  let transport;
  return async function send(msg) {
    if (smtpUrl) {
      if (!transport) {
        const { default: nodemailer } = await import('nodemailer');
        transport = nodemailer.createTransport(smtpUrl);
      }
      await transport.sendMail({ from: mailFrom, ...msg });
      return `sent to ${msg.to}`;
    }
    fs.mkdirSync(outboxDir, { recursive: true });
    const file = path.join(outboxDir, `${Date.now()}-${msg.to.replace(/[^a-z0-9@.]/gi, '_')}.eml`);
    fs.writeFileSync(file, `From: ${mailFrom}\nTo: ${msg.to}\nSubject: ${msg.subject}\n\n${msg.text}\n`);
    return `written to ${path.relative(process.cwd(), file)}`;
  };
}
