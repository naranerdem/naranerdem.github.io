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

export async function pendingAdditionalClassCashSettlement(
  database: D1Database,
  input: {
    registrationDraftChildId: string;
    paymentInstallmentId: string;
    effectiveAmountMnt: number;
    allocatedAmountMnt: number;
  },
): Promise<AdditionalClassCashSettlement | null> {
  const row = await database.prepare(`SELECT admission.id AS admissionId,
      admission.proposed_existing_credit_mnt + admission.proposed_source_award_credit_mnt AS proposedCreditMnt,
      COALESCE(SUM(reservation.amount_mnt), 0) AS reservedCreditMnt
    FROM additional_class_admission AS admission
    INNER JOIN additional_class_credit_reservation AS reservation
      ON reservation.admission_id = admission.id AND reservation.status = 'pending'
      AND reservation.target_payment_installment_id = ?
    INNER JOIN enrollment AS source_enrollment ON source_enrollment.id = admission.source_enrollment_id
    INNER JOIN registration_draft_child AS source_child ON source_child.id = admission.source_registration_draft_child_id
    INNER JOIN registration_draft_child AS target_child ON target_child.id = admission.target_registration_draft_child_id
    LEFT JOIN child_credit_entry AS existing_root ON existing_root.id = reservation.source_credit_entry_id
    WHERE admission.target_registration_draft_child_id = ?
      AND admission.status = 'pending_confirmation'
      AND source_enrollment.status = 'confirmed' AND source_enrollment.transferred_out_at IS NULL
      AND source_enrollment.student_id = admission.canonical_student_id
      AND source_child.status != 'cancelled' AND target_child.status != 'cancelled'
      AND (reservation.reservation_kind != 'existing_credit'
        OR (existing_root.id IS NOT NULL AND existing_root.reserved_amount_mnt >= reservation.amount_mnt))
    GROUP BY admission.id
    HAVING reservedCreditMnt = proposedCreditMnt AND reservedCreditMnt > 0`)
    .bind(input.paymentInstallmentId, input.registrationDraftChildId)
    .first<{ admissionId: string; reservedCreditMnt: number }>();
  if (!row) return null;
  const reservedCreditMnt = Number(row.reservedCreditMnt);
  const outstandingMnt = Math.max(0, input.effectiveAmountMnt - input.allocatedAmountMnt);
  if (!Number.isSafeInteger(reservedCreditMnt) || reservedCreditMnt <= 0 || reservedCreditMnt > outstandingMnt) return null;
  return { admissionId: row.admissionId, reservedCreditMnt, cashRequiredMnt: outstandingMnt - reservedCreditMnt };
}
