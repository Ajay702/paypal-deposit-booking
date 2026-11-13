// Plain node:http server: static pages + JSON API + PayPal webhook.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config, loadBusiness } from './config.js';
import { createStore } from './store.js';
import { createPayPal } from './paypal.js';
import { createMailer } from './email.js';
import { createApp } from './app.js';
import { BookingError } from './booking.js';

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

export function createServer({ app, paypal, demo, adminPassword, publicDir }) {
  const json = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const readBody = (req) =>
    new Promise((resolve, reject) => {
      let data = '';
      req.on('data', (c) => {
        data += c;
        if (data.length > 1e6) req.destroy();
      });
      req.on('end', () => {
        try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new BookingError('Invalid JSON')); }
      });
    });
  const isAdmin = (req) => {
    const [, b64 = ''] = (req.headers.authorization || '').split(' ');
    const pass = Buffer.from(b64, 'base64').toString().split(':').slice(1).join(':');
    const a = Buffer.from(pass), b = Buffer.from(adminPassword);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const route = `${req.method} ${url.pathname}`;
    try {
      if (route === 'GET /api/config') {
        return json(res, 200, { ...app.publicConfig(), demo, sdkUrl: paypal.sdkUrl });
      }
      if (route === 'GET /api/paypal/client-token') {
        return json(res, 200, { clientToken: await paypal.clientToken() });
      }
      if (route === 'GET /api/slots') {
        return json(res, 200, { slots: app.slots(url.searchParams.get('serviceId'), url.searchParams.get('date') || '') });
      }
      if (route === 'POST /api/bookings') {
        return json(res, 201, await app.startBooking(await readBody(req)));
      }
      const cap = url.pathname.match(/^\/api\/orders\/([\w-]+)\/capture$/);
      if (req.method === 'POST' && cap) {
        return json(res, 200, { booking: await app.captureDeposit(cap[1]) });
      }
      if (route === 'POST /api/paypal/webhook') {
        return json(res, 200, await app.handleWebhook(req.headers, await readBody(req)));
      }
      if (url.pathname.startsWith('/api/admin/')) {
        if (!isAdmin(req)) {
          res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="admin"' });
          return res.end('Unauthorized');
        }
        if (route === 'GET /api/admin/day') return json(res, 200, app.adminDay(url.searchParams.get('date') || ''));
        if (route === 'GET /api/admin/bookings') return json(res, 200, { bookings: app.adminAll() });
      }
      if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
        if (url.pathname === '/admin' && !isAdmin(req)) {
          res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="admin"' });
          return res.end('Unauthorized');
        }
        const name = url.pathname === '/' ? 'index.html' : url.pathname === '/admin' ? 'admin.html' : url.pathname.slice(1);
        const file = path.join(publicDir, path.normalize(name));
        if (file.startsWith(publicDir) && fs.existsSync(file) && fs.statSync(file).isFile()) {
          res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
          return fs.createReadStream(file).pipe(res);
        }
      }
      json(res, 404, { error: 'Not found' });
    } catch (err) {
      if (err instanceof BookingError) return json(res, 400, { error: err.message });
      console.error(err);
      json(res, 500, { error: 'Server error' });
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const business = loadBusiness();
  const paypal = createPayPal(config);
  const app = createApp({
    business,
    store: createStore(config.dataDir),
    paypal,
    sendMail: createMailer({ smtpUrl: config.smtpUrl, mailFrom: config.mailFrom, outboxDir: path.join(config.root, 'outbox') }),
  });
  createServer({ app, paypal, demo: config.demo, adminPassword: config.adminPassword, publicDir: path.join(config.root, 'public') })
    .listen(config.port, () => {
      console.log(`${business.name} booking page: ${config.baseUrl}`);
      console.log(`Admin panel:        ${config.baseUrl}/admin  (any username, password = ADMIN_PASSWORD)`);
      console.log(config.demo ? 'DEMO MODE: PayPal is simulated, no money moves.' : `PayPal ${config.paypal.live ? 'LIVE' : 'sandbox'} mode.`);
    });
}
