// Removes the admin password set in the admin panel and logs out all admin sessions.
// Afterwards ADMIN_PASSWORD (or the generated password in data/admin_password.txt) works again.
//   docker compose exec -u node ofa npm run reset-admin-password
//   npm run reset-admin-password
const path = require('path');
const sqlite3 = require('sqlite3');
require('dotenv').config();

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const db = new sqlite3.Database(path.join(DATA_DIR, 'annotations.db'), sqlite3.OPEN_READWRITE, (err) => {
  if (err) { console.error('Cannot open database:', err.message); process.exit(1); }
});

db.serialize(() => {
  db.run(`DELETE FROM settings WHERE key = 'admin_password_hash'`, function(err) {
    if (err) { console.error(err.message); process.exit(1); }
    console.log(this.changes ? 'Custom admin password removed.' : 'No custom admin password was set.');
  });
  db.run('DELETE FROM sessions', () => {
    console.log(process.env.ADMIN_PASSWORD && process.env.ADMIN_PASSWORD !== 'CHANGE_ME'
      ? 'Log in with ADMIN_PASSWORD from the environment.'
      : `Log in with the password from ${path.join(DATA_DIR, 'admin_password.txt')} (created on next server start if missing).`);
    db.close();
  });
});
