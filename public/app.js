const $ = (id) => document.getElementById(id);
const money = (c, cur) => `${(c / 100).toFixed(2)} ${cur}`;
const state = { config: null, service: null, start: null };

async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body;
}

function setStatus(msg, ok = false) {
  $('status').textContent = msg;
  $('status').className = ok ? 'ok' : '';
}

function renderServices() {
  const { services, currency } = state.config;
  $('services').innerHTML = '';
  for (const s of services) {
    const b = document.createElement('button');
    b.className = 'card' + (state.service?.id === s.id ? ' selected' : '');
    b.innerHTML = `<strong></strong><span>${s.durationMin} min · ${money(s.priceCents, currency)}</span>
      <small>Deposit ${money(s.depositCents, currency)}</small>`;
    b.querySelector('strong').textContent = s.name;
    b.onclick = () => { state.service = s; state.start = null; renderServices(); loadSlots(); };
    $('services').append(b);
  }
}

async function loadSlots() {
  renderSummary();
  if (!state.service) return;
  const { slots } = await api(`/api/slots?serviceId=${state.service.id}&date=${$('date').value}`);
  $('slots').innerHTML = slots.length ? '' : '<p class="muted">No free times this day.</p>';
  for (const t of slots) {
    const b = document.createElement('button');
    b.textContent = t;
    b.className = state.start === t ? 'selected' : '';
    b.onclick = () => { state.start = t; loadSlots(); };
    $('slots').append(b);
  }
}

function renderSummary() {
  const s = state.service;
  $('summary').textContent = s && state.start
    ? `${s.name} on ${$('date').value} at ${state.start}. Pay ${money(s.depositCents, state.config.currency)} now, the rest at your visit.`
    : 'Select a service and time.';
}

/** Creates the pending booking + PayPal order on our server. */
async function createOrder() {
  const form = $('details');
  if (!state.service || !state.start) throw new Error('Pick a service and time first');
  if (!form.reportValidity()) throw new Error('Fill in your details');
  const data = Object.fromEntries(new FormData(form));
  const { orderId } = await api('/api/bookings', {
    method: 'POST',
    body: JSON.stringify({ ...data, serviceId: state.service.id, date: $('date').value, start: state.start }),
  });
  return { orderId };
}

async function capture(orderId) {
  const { booking } = await api(`/api/orders/${orderId}/capture`, { method: 'POST' });
  setStatus(`Confirmed! Reference ${booking.id}. A confirmation email is on its way.`, true);
  state.start = null;
  loadSlots();
}

/** PayPal JS SDK v6: one integration renders PayPal (and other eligible methods) and opens a popup. */
async function setupPayPal(sdkUrl) {
  await new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = sdkUrl; s.onload = resolve; s.onerror = reject;
    document.head.append(s);
  });
  const { clientToken } = await api('/api/paypal/client-token');
  const sdk = await window.paypal.createInstance({ clientToken, components: ['paypal-payments'], pageType: 'checkout' });
  const eligible = await sdk.findEligibleMethods({ currencyCode: state.config.currency });
  if (!eligible.isEligible('paypal')) return setStatus('PayPal is not available on this device.');

  const session = sdk.createPayPalOneTimePaymentSession({
    onApprove: ({ orderId }) => capture(orderId).catch((e) => setStatus(e.message)),
    onCancel: () => setStatus('Payment cancelled. Your slot is held for a few minutes.'),
    onError: (e) => setStatus(`Payment error: ${e.message || e}`),
  });
  const btn = $('paypal-button');
  btn.hidden = false;
  btn.addEventListener('click', async () => {
    setStatus('');
    try {
      await session.start({ presentationMode: 'auto' }, createOrder());
    } catch (e) { setStatus(e.message); }
  });
}

function setupDemo() {
  const btn = $('demo-pay');
  btn.hidden = false;
  btn.onclick = async () => {
    setStatus('');
    try {
      const { orderId } = await createOrder();
      await capture(orderId);
    } catch (e) { setStatus(e.message); }
  };
}

async function init() {
  state.config = await api('/api/config');
  document.title = `Book – ${state.config.name}`;
  document.documentElement.style.setProperty('--brand', state.config.brandColor);
  $('biz-name').textContent = state.config.name;
  $('biz-tagline').textContent = state.config.tagline || '';
  const today = new Date();
  $('date').value = new Date(today - today.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  $('date').min = $('date').value;
  $('date').onchange = () => { state.start = null; loadSlots(); };
  renderServices();
  if (state.config.demo) setupDemo();
  else setupPayPal(state.config.sdkUrl).catch((e) => setStatus(`Could not load PayPal: ${e.message}`));
}

init();
