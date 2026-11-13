import crypto from 'node:crypto';
import { getDb } from '../../config/database.js';

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const GENESIS = '0'.repeat(64);

/**
 * Append-only, hash-chained audit log. Each entry commits to the previous entry's hash, so editing
 * or deleting any row breaks every hash after it. AuditAnchor.sol then publishes Merkle roots of
 * these hashes on-chain, so even a rewrite-and-rehash by the operator is detectable.
 * Entries carry only opaque ids and actions - never personal data.
 */
export const AuditLog = {
  hashOf(prev, e) {
    return sha([prev, e.id, e.actor, e.action, e.subject_table ?? '', e.subject_id ?? '', e.created_at].join('|'));
  },

  append(actor, action, subjectTable = null, subjectId = null, ip = null) {
    const db = getDb();
    const created_at = new Date().toISOString().replace('T', ' ').slice(0, 19);
    db.exec('BEGIN IMMEDIATE');
    try {
      const last = db.prepare('SELECT entry_hash FROM audit_log ORDER BY id DESC LIMIT 1').get();
      const prev = last?.entry_hash ?? GENESIS;
      const { lastInsertRowid } = db.prepare(
        'INSERT INTO audit_log (actor, action, subject_table, subject_id, ip_address, prev_hash, entry_hash, created_at) VALUES (?,?,?,?,?,?,?,?)',
      ).run(actor, action, subjectTable, subjectId === null ? null : String(subjectId), ip, prev, 'pending', created_at);
      const id = Number(lastInsertRowid);
      const hash = AuditLog.hashOf(prev, { id, actor, action, subject_table: subjectTable, subject_id: subjectId === null ? null : String(subjectId), created_at });
      db.prepare('UPDATE audit_log SET entry_hash = ? WHERE id = ?').run(hash, id);
      db.exec('COMMIT');
      return id;
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  },

  list(limit = 100) {
    return getDb().prepare('SELECT id, actor, action, subject_table, subject_id, entry_hash, created_at FROM audit_log ORDER BY id DESC LIMIT ?').all(limit);
  },

  find(id) { return getDb().prepare('SELECT * FROM audit_log WHERE id = ?').get(id) ?? null; },

  /** @returns {{intact:boolean, entries:number, first_bad_id:number|null}} */
  verifyChain() {
    let prev = GENESIS, n = 0;
    for (const r of getDb().prepare('SELECT * FROM audit_log ORDER BY id ASC').all()) {
      n++;
      if (r.prev_hash !== prev || AuditLog.hashOf(prev, r) !== r.entry_hash) return { intact: false, entries: n, first_bad_id: r.id };
      prev = r.entry_hash;
    }
    return { intact: true, entries: n, first_bad_id: null };
  },

  /** Entries with id > afterId, oldest first (the next batch to anchor). */
  since(afterId) { return getDb().prepare('SELECT id, entry_hash FROM audit_log WHERE id > ? ORDER BY id ASC').all(afterId); },
  range(from, to) { return getDb().prepare('SELECT id, entry_hash FROM audit_log WHERE id BETWEEN ? AND ? ORDER BY id ASC').all(from, to); },
  forSubject(table, id) {
    return getDb().prepare('SELECT * FROM audit_log WHERE subject_table = ? AND subject_id = ? ORDER BY id ASC').all(table, String(id));
  },
};
