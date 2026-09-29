/**
 * Select the current unpaid obligation for a staff payment-list row. The
 * queue row represents the initial installment, while later installments are
 * attached separately; choosing the first outstanding one keeps warnings and
 * grouping aligned with the financial schedule.
 */
export function applicablePaymentDueAt(item) {
  const initialOutstanding = Math.max(0, Number(item?.expectedAmountMnt || 0) - Number(item?.allocatedAmountMnt || 0));
  if (initialOutstanding > 0) return item?.remainingPaymentDueAt || item?.paymentDueAt || "";
  const later = item?.nextScheduledInstallment;
  if (later && Math.max(0, Number(later.amountMnt || 0) - Number(later.allocatedAmountMnt || 0)) > 0) return later.dueAt || "";
  return item?.remainingPaymentDueAt || item?.paymentDueAt || "";
}

export function isPaymentOverdue(item, now) {
  const dueAt = applicablePaymentDueAt(item);
  return Boolean(dueAt) && new Date(dueAt).getTime() < new Date(now).getTime();
}
