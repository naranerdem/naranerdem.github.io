import type { D1Database } from "../env";

export interface RegistrationProvenance {
  isTest: number;
  testRunId: string | null;
}

export interface ActiveReferralCode {
  id: string;
  code: string;
  enrollmentId: string;
  studentId: string;
}

const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function normalizeReferralCode(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.normalize("NFKC").trim().toUpperCase().replace(/\s+/g, "");
}

export function validReferralCode(value: string): boolean {
  return /^[A-Z2-9-]{6,24}$/.test(value);
}

function generatedReferralCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(7));
  return `NE-${[...bytes].map((value) => alphabet[value % alphabet.length]).join("")}`;
}

export async function activeReferralCodes(
  database: D1Database,
  rawCodes: string[],
  provenance: RegistrationProvenance,
): Promise<Map<string, ActiveReferralCode>> {
  const codes = [...new Set(rawCodes.map(normalizeReferralCode).filter(Boolean))];
  if (!codes.length) return new Map();
  if (codes.some((code) => !validReferralCode(code))) return new Map();
  const placeholders = codes.map(() => "?").join(", ");
  const result = await database.prepare(`SELECT enrollment_referral_code.id, enrollment_referral_code.code,
    enrollment_referral_code.enrollment_id AS enrollmentId, enrollment_referral_code.student_id AS studentId
    FROM enrollment_referral_code
    INNER JOIN enrollment ON enrollment.id = enrollment_referral_code.enrollment_id
    WHERE enrollment_referral_code.code IN (${placeholders})
      AND enrollment_referral_code.status = 'active'
      AND enrollment.status = 'confirmed'
      AND enrollment_referral_code.is_test = ?
      AND enrollment.is_test = ?`).bind(...codes, provenance.isTest, provenance.isTest)
    .all<ActiveReferralCode>();
  return new Map(result.results.map((row) => [normalizeReferralCode(row.code), row]));
}

export async function ensureEnrollmentReferralCode(
  database: D1Database,
  enrollmentId: string,
  studentId: string,
  provenance: RegistrationProvenance,
  now: string,
): Promise<string> {
  const current = await database.prepare(`SELECT code FROM enrollment_referral_code
    WHERE enrollment_id = ? AND status = 'active'`).bind(enrollmentId).first<{ code: string }>();
  if (current) return current.code;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const code = generatedReferralCode();
    const inserted = await database.prepare(`INSERT OR IGNORE INTO enrollment_referral_code (
      id, enrollment_id, student_id, code, status, activated_at, is_test, test_run_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`)
      .bind(crypto.randomUUID(), enrollmentId, studentId, code, now, provenance.isTest, provenance.testRunId, now, now).run();
    if ((inserted.meta?.changes ?? 0) === 1) return code;
    const raced = await database.prepare(`SELECT code FROM enrollment_referral_code
      WHERE enrollment_id = ? AND status = 'active'`).bind(enrollmentId).first<{ code: string }>();
    if (raced) return raced.code;
  }
  throw new Error("Referral code could not be allocated.");
}
