import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Config } from '../app/Support/Config.js';
import { Migrator } from '../app/Support/Migrator.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let db = null;

/** Singleton SQLite connection (WAL, foreign keys on). Schema is applied/migrated on first use. */
export function getDb() {
  if (db) return db;
  const file = Config.get('db_path') || path.join(root, 'storage', 'database.sqlite');
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  Migrator.run(db, root);
  return db;
}

/** Test helper. */
export function closeDb() { if (db) { try { db.close(); } catch { /* already closed */ } db = null; } }
