import fs from 'node:fs';
import path from 'node:path';

/**
 * Idempotent schema management. schema.sqlite.sql is all CREATE ... IF NOT EXISTS, so applying it
 * on every start is safe; additive column changes for upgrades go in MIGRATIONS (each guarded by a
 * column-exists check) so an existing database is upgraded in place without losing data.
 */
const MIGRATIONS = [
  // { table: 'kyc_decisions', column: 'example', ddl: 'ALTER TABLE kyc_decisions ADD COLUMN example TEXT' },
];

export const Migrator = {
  run(db, root) {
    db.exec(fs.readFileSync(path.join(root, 'database', 'schema.sqlite.sql'), 'utf8'));
    for (const m of MIGRATIONS) {
      const cols = db.prepare(`PRAGMA table_info(${m.table})`).all().map((c) => c.name);
      if (!cols.includes(m.column)) db.exec(m.ddl);
    }
  },
};
