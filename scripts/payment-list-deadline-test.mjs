import assert from "node:assert/strict";
import { applicablePaymentDueAt, isPaymentOverdue } from "../src/scripts/payment-deadline.js";

const now = "2026-09-29T00:00:00.000Z";
const initialOverdue = {
  expectedAmountMnt: 650000,
  allocatedAmountMnt: 0,
  paymentDueAt: "2026-09-10T11:41:15.603Z",
  nextScheduledInstallment: { amountMnt: 650000, allocatedAmountMnt: 0, dueAt: "2027-01-25" },
};
assert.equal(applicablePaymentDueAt(initialOverdue), initialOverdue.paymentDueAt,
  "an unpaid initial installment remains the applicable obligation even when a later installment has a future date");
assert.equal(isPaymentOverdue(initialOverdue, now), true, "the unpaid initial installment is overdue at the fixed clock");

const partialWithFutureLater = {
  expectedAmountMnt: 650000,
  allocatedAmountMnt: 650000,
  paymentDueAt: "2026-09-10T11:41:15.603Z",
  nextScheduledInstallment: { amountMnt: 650000, allocatedAmountMnt: 0, dueAt: "2027-01-25" },
};
assert.equal(applicablePaymentDueAt(partialWithFutureLater), "2027-01-25",
  "a settled initial installment uses the next unpaid installment's date");
assert.equal(isPaymentOverdue(partialWithFutureLater, now), false,
  "a confirmed partial enrollment with a future next installment is not overdue merely because its initial receipt is old");

const customDeadline = { ...initialOverdue, remainingPaymentDueAt: "2026-10-10T15:59:00.000Z" };
assert.equal(applicablePaymentDueAt(customDeadline), customDeadline.remainingPaymentDueAt,
  "a supported remaining-balance deadline extension overrides the initial due date");
assert.equal(isPaymentOverdue(customDeadline, now), false, "an active extension is preserved by the display rule");

console.log("ok payment list selects the first applicable unpaid obligation without replacing supported deadline extensions");
