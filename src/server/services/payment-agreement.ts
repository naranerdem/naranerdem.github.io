import type { D1Database } from "../env";
import { effectiveInstallmentsForRows } from "./discounts";

export type ActivePaymentInstallment = {
  id: string;
  paymentRequestId: string;
  registrationDraftChildId: string;
  installmentNumber: number;
  installmentKind: "initial" | "later";
  amountMnt: number;
  effectiveAmountMnt: number;
  allocatedAmountMnt: number;
  cashAllocatedAmountMnt: number;
  dueAt: string;
  status: "pending" | "partially_paid" | "paid";
};

export type EffectivePaymentPlanCode = "single" | "two_installment";

/**
 * Registration intake keeps its originally selected plan as historical
 * evidence. A later, staff-reviewed agreement revision is the only thing
 * allowed to supersede that plan for current financial operations.
 */
export async function effectivePaymentPlanCodesForChildren(database: D1Database, childIds: string[]): Promise<Map<string, EffectivePaymentPlanCode>> {
  if (!childIds.length) return new Map();
  const rows = await database.prepare(`SELECT revision.registration_draft_child_id AS registrationDraftChildId,
      revision.proposed_payment_plan_code AS paymentPlanCode
    FROM enrollment_payment_agreement_revision AS revision
    WHERE revision.registration_draft_child_id IN (${childIds.map(() => "?").join(", ")})
      AND NOT EXISTS (
        SELECT 1 FROM enrollment_payment_agreement_revision AS later
        WHERE later.registration_draft_child_id = revision.registration_draft_child_id
          AND (later.revised_at > revision.revised_at OR (later.revised_at = revision.revised_at AND later.id > revision.id))
      )`).bind(...childIds).all<{ registrationDraftChildId: string; paymentPlanCode: EffectivePaymentPlanCode }>();
  return new Map(rows.results.filter((row) => row.paymentPlanCode === "single" || row.paymentPlanCode === "two_installment")
    .map((row) => [row.registrationDraftChildId, row.paymentPlanCode]));
}

/**
 * The registration-draft child is the stable owner of its payment agreement.
 * Canonical enrollment links move with transfers, while a reviewed schedule can
 * add rows later; using the child avoids dropping those active obligations.
 */
export async function activePaymentInstallmentsForChildren(database: D1Database, childIds: string[]): Promise<Map<string, ActivePaymentInstallment[]>> {
  if (!childIds.length) return new Map();
  const rows = await database.prepare(`SELECT installment.id,
      installment.payment_request_id AS paymentRequestId,
      installment.registration_draft_child_id AS registrationDraftChildId,
      installment.installment_number AS installmentNumber,
      installment.installment_kind AS installmentKind,
      installment.amount_mnt AS amountMnt,
      installment.effective_due_at AS dueAt, installment.status,
      COALESCE(SUM(CASE WHEN confirmation.status = 'undone' THEN 0 ELSE allocation.allocated_amount_mnt END), 0)
        + COALESCE((SELECT SUM(-credit.amount_mnt) FROM child_credit_entry AS credit
          WHERE credit.payment_installment_id = installment.id AND credit.entry_kind = 'credit_application'), 0) AS allocatedAmountMnt,
      COALESCE(SUM(CASE WHEN confirmation.status = 'undone' THEN 0 ELSE allocation.allocated_amount_mnt END), 0) AS cashAllocatedAmountMnt
    FROM payment_installment AS installment
    LEFT JOIN payment_allocation AS allocation ON allocation.payment_installment_id = installment.id
    LEFT JOIN payment_confirmation AS confirmation ON confirmation.received_payment_id = allocation.received_payment_id
    WHERE installment.registration_draft_child_id IN (${childIds.map(() => "?").join(", ")})
      AND installment.status != 'released'
    GROUP BY installment.id
    ORDER BY installment.registration_draft_child_id, installment.installment_number, installment.id`)
    .bind(...childIds).all<Omit<ActivePaymentInstallment, "effectiveAmountMnt">>();
  const raw = rows.results.map((row) => ({
    ...row,
    installmentNumber: Number(row.installmentNumber), amountMnt: Number(row.amountMnt),
    allocatedAmountMnt: Number(row.allocatedAmountMnt), cashAllocatedAmountMnt: Number(row.cashAllocatedAmountMnt),
  }));
  const effective = new Map((await effectiveInstallmentsForRows(database, raw.map((row) => ({
    id: row.id, registrationDraftChildId: row.registrationDraftChildId, installmentNumber: row.installmentNumber,
    amountMnt: row.amountMnt, allocatedAmountMnt: row.allocatedAmountMnt,
  })))).map((row) => [row.id, row.effectiveAmountMnt]));
  const byChild = new Map<string, ActivePaymentInstallment[]>();
  for (const row of raw) {
    const installment: ActivePaymentInstallment = { ...row,
      installmentKind: row.installmentKind as ActivePaymentInstallment["installmentKind"],
      status: row.status as ActivePaymentInstallment["status"],
      effectiveAmountMnt: Number(effective.get(row.id) ?? row.amountMnt),
    };
    byChild.set(installment.registrationDraftChildId, [...(byChild.get(installment.registrationDraftChildId) ?? []), installment]);
  }
  return byChild;
}
