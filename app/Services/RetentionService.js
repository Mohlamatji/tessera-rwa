import { getDb } from '../../config/database.js';
import retention from '../../config/retention.js';
import { AuditLog } from '../Models/AuditLog.js';

export const RetentionService = {
  run() {
    const db = getDb(), day = (n) => `-${n} days`;
    const wiped = db.prepare(
      `UPDATE users SET full_name_enc = NULL, dob_enc = NULL, country = NULL, id_number_hash = 'erased:' || id, deleted_at = datetime('now')
       WHERE deleted_at IS NULL AND id IN (
         SELECT user_id FROM kyc_decisions GROUP BY user_id
         HAVING SUM(decision = 'approved') = 0 AND MAX(created_at) < datetime('now', ?))`,
    ).run(day(retention.rejected_kyc_pii_days)).changes;
    const challenges = db.prepare("DELETE FROM auth_challenges WHERE created_at < datetime('now', ?)").run(day(retention.expired_challenges_days)).changes;
    const hits = db.prepare("DELETE FROM rate_limit_hits WHERE created_at < datetime('now', ?)").run(day(retention.rate_limit_hits_days)).changes;
    AuditLog.append('retention', 'retention.run', null, null);
    return { rejected_applicants_wiped: wiped, challenges_deleted: challenges, rate_limit_rows_deleted: hits };
  },
};
