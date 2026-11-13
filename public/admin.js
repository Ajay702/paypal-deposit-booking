const $ = (id) => document.getElementById(id);
const money = (c) => (c / 100).toFixed(2);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const get = (p) => fetch(p, { credentials: 'same-origin' }).then((r) => r.json());

function row(cells) {
  return `<tr>${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`;
}
const badge = (b) => `<span class="badge ${b.status}">${b.status}</span>`;
const customer = (b) => `${esc(b.name)}<br><small>${esc(b.email)} ${esc(b.phone)}</small>`;

async function loadDay() {
  const d = await get(`/api/admin/day?date=${$('date').value}`);
  $('stats').innerHTML = `
    <div><strong>${d.confirmedCount}</strong>confirmed</div>
    <div><strong>${d.pendingCount}</strong>pending</div>
    <div><strong>${money(d.depositsCollectedCents)}</strong>deposits collected</div>
    <div><strong>${money(d.balanceDueCents)}</strong>balance due in store</div>`;
  $('day').innerHTML = d.schedule.map((b) =>
    row([esc(b.start), customer(b), `${esc(b.serviceName)} (${b.durationMin}m)`, money(b.depositCents), badge(b)])
  ).join('') || row(['<span class="muted">Nothing booked</span>', '', '', '', '']);
}

async function loadAll() {
  const { bookings } = await get('/api/admin/bookings');
  $('all').innerHTML = bookings.map((b) =>
    row([esc(b.date), esc(b.start), customer(b), esc(b.serviceName), money(b.depositCents), badge(b), `<small>${esc(b.captureId || b.orderId)}</small>`])
  ).join('');
}

const today = new Date();
$('date').value = new Date(today - today.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
$('date').onchange = loadDay;
loadDay();
loadAll();
setInterval(() => { loadDay(); loadAll(); }, 15000);
