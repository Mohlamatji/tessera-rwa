import { getDb } from '../../config/database.js';

/** Sliding-window limiter backed by SQLite. Returns false when `key` exceeded `max` hits in `windowSeconds`. */
export const RateLimitService = {
  bucketKey(subject, action) { return `${action}:${subject}`; },

  allow(key, max, windowSeconds) {
    const db = getDb();
    const n = db.prepare("SELECT COUNT(*) n FROM rate_limit_hits WHERE bucket_key = ? AND created_at >= datetime('now', ?)").get(key, `-${windowSeconds} seconds`).n;
    if (n >= max) return false;
    db.prepare('INSERT INTO rate_limit_hits (bucket_key) VALUES (?)').run(key);
    return true;
  },
};
