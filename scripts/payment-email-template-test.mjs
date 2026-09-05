import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const dir = mkdtempSync(path.join(tmpdir(), "naranerdem-payment-email-"));
const bundle = path.join(dir, "payment-reminder.mjs");
const confirmationBundle = path.join(dir, "payment-confirmed.mjs");
try {
  const result = spawnSync(path.resolve("node_modules/esbuild/bin/esbuild"), ["src/server/email/templates/payment-reminder.ts", "--bundle", "--format=esm", "--platform=node", `--outfile=${bundle}`], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  const confirmationResult = spawnSync(path.resolve("node_modules/esbuild/bin/esbuild"), ["src/server/email/templates/payment-confirmed.ts", "--bundle", "--format=esm", "--platform=node", `--outfile=${confirmationBundle}`], { encoding: "utf8" });
  if (confirmationResult.status !== 0) throw new Error(confirmationResult.stderr);
  const { paymentReminderTemplate } = await import(pathToFileURL(bundle).href);
  const { paymentConfirmedTemplate } = await import(pathToFileURL(confirmationBundle).href);
  const template = paymentReminderTemplate({ milestoneType: "initial_overdue", childName: "Тест", classLabel: "Тест анги", amountMnt: 100000,
    dueAt: "2026-09-01T11:12:00.000Z", parentClaimed: false, bankName: null, accountHolderName: null, accountNumber: null, iban: null, transferInstruction: null });
  assert.match(template.text, /суудал цуцлагдаж болзошгүй/);
  assert.match(template.text, /2026 оны 9-р сарын 1-ний 19:12 цаг/);
  assert.doesNotMatch(template.text, /Sep|AM|PM|автоматаар цуцлагдаагүй/);
  const initial = paymentReminderTemplate({ milestoneType: "initial_reminder", childName: "Тест", classLabel: "Тест анги", amountMnt: 100000,
    dueAt: "2026-09-01T11:12:00.000Z", parentClaimed: false, bankName: null, accountHolderName: null, accountNumber: null, iban: null, transferInstruction: null });
  assert.match(initial.text, /Төлбөрийн хугацаа ойртож байна\./);
  assert.doesNotMatch(initial.text, /Эхний төлбөр/);
  const later = paymentReminderTemplate({ milestoneType: "later_reminder", childName: "Тест", classLabel: "Тест анги", amountMnt: 100000,
    dueAt: "2026-09-01T11:12:00.000Z", parentClaimed: false, bankName: null, accountHolderName: null, accountNumber: null, iban: null, transferInstruction: null });
  assert.match(later.text, /Дараагийн төлбөрийн хугацаа ойртож байна\./);
  const confirmation = paymentConfirmedTemplate({
    children: [
      { childName: "Тест Нэг", classLabel: "1-р шат · Мягмар 09:00–10:20", receivedAmountMnt: 600000, totalPaidAmountMnt: 600000,
        remainingAmountMnt: 600000, nextPaymentAmountMnt: 600000, nextPaymentDueAt: "2026-10-15T04:00:00.000Z", seatConfirmed: true },
      { childName: "Тест Хоёр", classLabel: "2-р шат · Лхагва 15:00–16:20", receivedAmountMnt: 200000, totalPaidAmountMnt: 200000,
        remainingAmountMnt: 1000000, nextPaymentAmountMnt: null, nextPaymentDueAt: null, seatConfirmed: false },
    ],
  });
  assert.match(confirmation.text, /Тест Нэг/);
  assert.match(confirmation.text, /Тест Хоёр/);
  assert.match(confirmation.text, /Хүлээн авсан төлбөр: 600,000 ₮/);
  assert.match(confirmation.text, /Үлдсэн төлбөр: 600,000 ₮/);
  assert.match(confirmation.text, /Дараагийн төлбөр: 600,000 ₮/);
  assert.match(confirmation.text, /Төлөх хугацаа: 2026-10-15/);
  assert.match(confirmation.text, /Суудал баталгаажсан\./);
  assert.match(confirmation.text, /Суудал хараахан баталгаажаагүй байна\./);
  assert.doesNotMatch(confirmation.text, /verify-email|token=/i, "ordinary payment confirmation contains no capability link");
  console.log("ok payment reminder wording and Mongolia-local deadline formatting");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
