/**
 * South African ID number validation. Cheap, deterministic, and runs before any paid bureau call:
 * 13 digits, Luhn checksum, a real YYMMDD date, and (optionally) agreement with the date of birth
 * the user declared. A mismatch between the ID's embedded DOB and the declared DOB is a classic
 * synthetic-identity signal.
 */
export const SaId = {
  inspect(rawId, declaredDob = null, now = new Date()) {
    const id = String(rawId ?? '').replace(/\s+/g, '');
    const fail = (reason) => ({ valid: false, reason, dob: null, gender: null, citizen: null });
    if (!/^\d{13}$/.test(id)) return fail('ID number must be exactly 13 digits.');
    if (!SaId.luhn(id)) return fail('ID number failed its checksum digit.');

    const yy = Number(id.slice(0, 2)), mm = Number(id.slice(2, 4)), dd = Number(id.slice(4, 6));
    // YY is ambiguous across centuries: assume the most recent past date.
    const year = yy + (yy > now.getUTCFullYear() % 100 ? 1900 : 2000);
    const d = new Date(Date.UTC(year, mm - 1, dd));
    if (mm < 1 || mm > 12 || d.getUTCFullYear() !== year || d.getUTCMonth() !== mm - 1 || d.getUTCDate() !== dd) {
      return fail('ID number does not contain a valid date of birth.');
    }
    const dob = d.toISOString().slice(0, 10);
    if (declaredDob && declaredDob !== dob) return { ...fail('Declared date of birth does not match the ID number.'), dob };
    return { valid: true, reason: null, dob, gender: Number(id.slice(6, 10)) >= 5000 ? 'M' : 'F', citizen: id[10] === '0' };
  },

  luhn(digits) {
    let sum = 0, alt = false;
    for (let i = digits.length - 1; i >= 0; i--) {
      let n = Number(digits[i]);
      if (alt) { n *= 2; if (n > 9) n -= 9; }
      sum += n; alt = !alt;
    }
    return sum % 10 === 0;
  },

  /** Compute a valid ID number for a DOB/gender (used by tests and the demo seeder). */
  make(dob, serial = 5009, citizen = 0) {
    const [y, m, d] = dob.split('-');
    const body = `${y.slice(2)}${m}${d}${String(serial).padStart(4, '0')}${citizen}8`;
    for (let c = 0; c <= 9; c++) if (SaId.luhn(body + c)) return body + c;
    throw new Error('unreachable');
  },
};
