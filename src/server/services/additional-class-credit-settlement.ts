import type { D1Database } from "../env";

/**
 * Projects the cash a teacher must collect for a pending additional admission.
 * A reservation is deliberately not an application or an installment payment.
 */
export interface AdditionalClassCashSettlement {
  admissionId: string;
  reservedCreditMnt: number;
  cashRequiredMnt: number;
}

export interface AdditionalClassCashSettlementInput {
  registrationDraftChildId: string;
  paymentInstallmentId: string;
  effectiveAmountMnt: number;
  allocatedAmountMnt: number;
}

// The payment queue needs this projection for many visible rows. Keep the
// single-row helper below for write-time callers, but resolve list rows in one
// scoped query rather than probing every ordinary payment for a reservation.
export async function pendingAdditionalClassCashSettlements(
  database: D1Database,
  inputs: AdditionalClassCashSettlementInput[],
): Promise<Map<string, AdditionalClassCashSettlement>> {
  const requested = [...new Map(inputs.map((input) => [input.paymentInstallmentId, input])).values()]
    .filter((input) => Math.max(0, input.effectiveAmountMnt - input.allocatedAmountMnt) > 0);
  if (!requested.length) return new Map();
  const rows = await database.prepare(`WITH requested(registrationDraftChildId, paymentInstallmentId) AS (
      VALUES ${requested.map(() => "(?, ?)").join(", ")}
    )
    SELECT requested.registrationDraftChildId, requested.paymentInstallmentId,
      admission.id AS admissionId,
      admission.proposed_existing_credit_mnt + admission.proposed_source_award_credit_mnt AS proposedCreditMnt,
      COALESCE(SUM(reservation.amount_mnt), 0) AS reservedCreditMnt
    FROM requested
    INNER JOIN additional_class_credit_reservation AS reservation
      ON reservation.target_payment_installment_id = requested.paymentInstallmentId
      AND reservation.status = 'pending'
    INNER JOIN additional_class_admission AS admission ON admission.id = reservation.admission_id
    INNER JOIN enrollment AS source_enrollment ON source_enrollment.id = admission.source_enrollment_id
    INNER JOIN registration_draft_child AS source_child ON source_child.id = admission.source_registration_draft_child_id
    INNER JOIN registration_draft_child AS target_child ON target_child.id = admission.target_registration_draft_child_id
    LEFT JOIN child_credit_entry AS existing_root ON existing_root.id = reservation.source_credit_entry_id
    WHERE admission.target_registration_draft_child_id = requested.registrationDraftChildId
      AND admission.status = 'pending_confirmation'
      AND source_enrollment.status = 'confirmed' AND source_enrollment.transferred_out_at IS NULL
      AND source_enrollment.student_id = admission.canonical_student_id
      AND source_child.status != 'cancelled' AND target_child.status != 'cancelled'
      AND (reservation.reservation_kind != 'existing_credit'
        OR (existing_root.id IS NOT NULL AND existing_root.reserved_amount_mnt >= reservation.amount_mnt))
    GROUP BY requested.registrationDraftChildId, requested.paymentInstallmentId, admission.id
    HAVING reservedCreditMnt = proposedCreditMnt AND reservedCreditMnt > 0`)
    .bind(...requested.flatMap((input) => [input.registrationDraftChildId, input.paymentInstallmentId]))
    .all<{ registrationDraftChildId: string; paymentInstallmentId: string; admissionId: string; reservedCreditMnt: number }>();
  const byInstallment = new Map<string, AdditionalClassCashSettlement>();
  const requestedByInstallment = new Map(requested.map((input) => [input.paymentInstallmentId, input]));
  for (const row of rows.results) {
    if (byInstallment.has(row.paymentInstallmentId)) continue;
    const input = requestedByInstallment.get(row.paymentInstallmentId);
    if (!input) continue;
    const reservedCreditMnt = Number(row.reservedCreditMnt);
    const outstandingMnt = Math.max(0, input.effectiveAmountMnt - input.allocatedAmountMnt);
    if (!Number.isSafeInteger(reservedCreditMnt) || reservedCreditMnt <= 0 || reservedCreditMnt > outstandingMnt) continue;
    byInstallment.set(row.paymentInstallmentId, {
      admissionId: row.admissionId,
      reservedCreditMnt,
      cashRequiredMnt: outstandingMnt - reservedCreditMnt,
    });
  }
  return byInstallment;
}

export async function pendingAdditionalClassCashSettlement(
  database: D1Database,
  input: AdditionalClassCashSettlementInput,
): Promise<AdditionalClassCashSettlement | null> {
  return (await pendingAdditionalClassCashSettlements(database, [input])).get(input.paymentInstallmentId) ?? null;
}
