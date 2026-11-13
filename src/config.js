import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
if (fs.existsSync(path.join(root, '.env'))) process.loadEnvFile(path.join(root, '.env'));

const env = process.env;
const demo = process.argv.includes('--demo') || env.DEMO === 'true' || !env.PAYPAL_CLIENT_ID;

export const config = {
  root,
  demo,
  port: Number(env.PORT || 3000),
  baseUrl: env.BASE_URL || `http://localhost:${env.PORT || 3000}`,
  adminPassword: env.ADMIN_PASSWORD || 'admin',
  dataDir: path.resolve(root, env.DATA_DIR || 'data'),
  businessFile: path.resolve(root, env.BUSINESS_FILE || 'business.json'),
  paypal: {
    clientId: env.PAYPAL_CLIENT_ID || '',
    clientSecret: env.PAYPAL_CLIENT_SECRET || '',
    webhookId: env.PAYPAL_WEBHOOK_ID || '',
    live: env.PAYPAL_ENV === 'live',
  },
  smtpUrl: env.SMTP_URL || '',
  mailFrom: env.MAIL_FROM || 'bookings@localhost',
};

export function loadBusiness(file = config.businessFile) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
