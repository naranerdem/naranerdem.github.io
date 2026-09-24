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

export async function enrollmentHasQualifyingPayment(database: D1Database, enrollmentId: string): Promise<boolean> {
  const row = await database.prepare(`SELECT 1 AS value
    FROM registration_draft_child
    INNER JOIN payment_installment ON payment_installment.registration_draft_child_id = registration_draft_child.id
    LEFT JOIN payment_allocation ON payment_allocation.payment_installment_id = payment_installment.id
    LEFT JOIN payment_confirmation ON payment_confirmation.received_payment_id = payment_allocation.received_payment_id
    LEFT JOIN child_credit_entry ON child_credit_entry.payment_installment_id = payment_installment.id
      AND child_credit_entry.entry_kind = 'credit_application'
    WHERE registration_draft_child.canonical_enrollment_id = ?
      AND payment_installment.status != 'released'
      AND ((payment_allocation.id IS NOT NULL AND COALESCE(payment_confirmation.status, 'finalized') != 'undone')
        OR child_credit_entry.id IS NOT NULL)
    LIMIT 1`).bind(enrollmentId).first<{ value: number }>();
  return Boolean(row);
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
      AND enrollment.status = 'confirmed' AND enrollment.transferred_out_at IS NULL
      AND EXISTS (
        SELECT 1 FROM registration_draft_child AS qualifying_child
        INNER JOIN payment_installment AS qualifying_installment ON qualifying_installment.registration_draft_child_id = qualifying_child.id
        LEFT JOIN payment_allocation AS qualifying_allocation ON qualifying_allocation.payment_installment_id = qualifying_installment.id
        LEFT JOIN payment_confirmation AS qualifying_confirmation ON qualifying_confirmation.received_payment_id = qualifying_allocation.received_payment_id
        LEFT JOIN child_credit_entry AS qualifying_credit ON qualifying_credit.payment_installment_id = qualifying_installment.id
          AND qualifying_credit.entry_kind = 'credit_application'
        WHERE qualifying_child.canonical_enrollment_id = enrollment.id AND qualifying_installment.status != 'released'
          AND ((qualifying_allocation.id IS NOT NULL AND COALESCE(qualifying_confirmation.status, 'finalized') != 'undone') OR qualifying_credit.id IS NOT NULL)
      )
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
  const qualifying = await enrollmentHasQualifyingPayment(database, enrollmentId);
  const current = await database.prepare(`SELECT code FROM enrollment_referral_code
    WHERE enrollment_id = ? AND status = 'active'`).bind(enrollmentId).first<{ code: string }>();
  if (current && qualifying) return current.code;
  // Referral identity belongs to the child, not to every class agreement. A
  // second current enrollment reuses the child's still-valid active code;
  // transferred-out enrollment codes remain ineligible through this join.
  const existingForStudent = await database.prepare(`SELECT enrollment_referral_code.code AS code
    FROM enrollment_referral_code
    INNER JOIN enrollment ON enrollment.id = enrollment_referral_code.enrollment_id
    WHERE enrollment_referral_code.student_id = ? AND enrollment_referral_code.status = 'active'
      AND enrollment.status = 'confirmed' AND enrollment.transferred_out_at IS NULL
      AND EXISTS (
        SELECT 1 FROM registration_draft_child AS qualifying_child
        INNER JOIN payment_installment AS qualifying_installment ON qualifying_installment.registration_draft_child_id = qualifying_child.id
        LEFT JOIN payment_allocation AS qualifying_allocation ON qualifying_allocation.payment_installment_id = qualifying_installment.id
        LEFT JOIN payment_confirmation AS qualifying_confirmation ON qualifying_confirmation.received_payment_id = qualifying_allocation.received_payment_id
        LEFT JOIN child_credit_entry AS qualifying_credit ON qualifying_credit.payment_installment_id = qualifying_installment.id
          AND qualifying_credit.entry_kind = 'credit_application'
        WHERE qualifying_child.canonical_enrollment_id = enrollment.id AND qualifying_installment.status != 'released'
          AND ((qualifying_allocation.id IS NOT NULL AND COALESCE(qualifying_confirmation.status, 'finalized') != 'undone') OR qualifying_credit.id IS NOT NULL)
      )
      AND enrollment_referral_code.is_test = ? AND enrollment.is_test = ?
    ORDER BY enrollment_referral_code.activated_at ASC, enrollment_referral_code.id ASC LIMIT 1`)
    .bind(studentId, provenance.isTest, provenance.isTest).first<{ code: string }>();
  if (existingForStudent) return existingForStudent.code;
  if (!qualifying) return "";
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
