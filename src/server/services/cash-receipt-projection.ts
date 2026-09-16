import type { D1Database } from "../env";

export interface ChildCashReceiptProjection {
  cashAllocatedMnt: number;
  cashReceivedMnt: number;
  attributableExcessMnt: number;
}

// A receipt can be allocated across several children. Its unallocated
// remainder is attributable to a child only when every active allocation on
// that receipt belongs to that one child; otherwise it remains unassigned.
// This is the same ownership boundary used when historical award residuals
// become child credit.
export async function cashReceiptProjectionsForChildren(database: D1Database, childIds: string[]) {
  const ids = [...new Set(childIds)];
  if (!ids.length) return new Map<string, ChildCashReceiptProjection>();
  const rows = await database.prepare(`WITH active_allocation AS (
      SELECT payment_allocation.received_payment_id AS receiptId,
        payment_installment.registration_draft_child_id AS childId,
        payment_allocation.allocated_amount_mnt AS allocatedAmountMnt
      FROM payment_allocation
      INNER JOIN payment_installment ON payment_installment.id = payment_allocation.payment_installment_id
      LEFT JOIN payment_confirmation ON payment_confirmation.received_payment_id = payment_allocation.received_payment_id
      WHERE payment_confirmation.status IS NULL OR payment_confirmation.status != 'undone'
    ), receipt_total AS (
      SELECT receiptId, SUM(allocatedAmountMnt) AS allocatedAmountMnt,
        COUNT(DISTINCT childId) AS childCount
      FROM active_allocation GROUP BY receiptId
    ), child_receipt AS (
      SELECT receiptId, childId, SUM(allocatedAmountMnt) AS allocatedAmountMnt
      FROM active_allocation GROUP BY receiptId, childId
    )
    SELECT child_receipt.childId,
      COALESCE(SUM(child_receipt.allocatedAmountMnt), 0) AS cashAllocatedMnt,
      COALESCE(SUM(CASE WHEN receipt_total.childCount = 1
        THEN MAX(0, received_payment.received_amount_mnt - receipt_total.allocatedAmountMnt)
        ELSE 0 END), 0) AS attributableExcessMnt
    FROM child_receipt
    INNER JOIN receipt_total ON receipt_total.receiptId = child_receipt.receiptId
    INNER JOIN received_payment ON received_payment.id = child_receipt.receiptId
    WHERE child_receipt.childId IN (${ids.map(() => "?").join(", ")})
    GROUP BY child_receipt.childId`).bind(...ids).all<{
      childId: string; cashAllocatedMnt: number; attributableExcessMnt: number;
    }>();
  const result = new Map<string, ChildCashReceiptProjection>();
  for (const row of rows.results) {
    const cashAllocatedMnt = Number(row.cashAllocatedMnt);
    const attributableExcessMnt = Number(row.attributableExcessMnt);
    result.set(row.childId, {
      cashAllocatedMnt,
      attributableExcessMnt,
      cashReceivedMnt: cashAllocatedMnt + attributableExcessMnt,
    });
  }
  return result;
}
