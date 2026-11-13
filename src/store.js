// Tiny JSON-file store. Good enough for one salon; swap for SQLite/Postgres if you outgrow it.
import fs from 'node:fs';
import path from 'node:path';

export function createStore(dataDir) {
  const file = path.join(dataDir, 'bookings.json');
  fs.mkdirSync(dataDir, { recursive: true });

  const all = () => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : []);
  const save = (list) => {
    fs.writeFileSync(file + '.tmp', JSON.stringify(list, null, 2));
    fs.renameSync(file + '.tmp', file);
  };

  return {
    all,
    get: (id) => all().find((b) => b.id === id) || null,
    findByOrder: (orderId) => all().find((b) => b.orderId === orderId) || null,
    put(booking) {
      const list = all();
      const i = list.findIndex((b) => b.id === booking.id);
      if (i === -1) list.push(booking);
      else list[i] = booking;
      save(list);
      return booking;
    },
  };
}
