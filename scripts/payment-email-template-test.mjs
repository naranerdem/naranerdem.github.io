import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const dir = mkdtempSync(path.join(tmpdir(), "naranerdem-payment-email-"));
const bundle = path.join(dir, "payment-reminder.mjs");
try {
  const result = spawnSync(path.resolve("node_modules/esbuild/bin/esbuild"), ["src/server/email/templates/payment-reminder.ts", "--bundle", "--format=esm", "--platform=node", `--outfile=${bundle}`], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  const { paymentReminderTemplate } = await import(pathToFileURL(bundle).href);
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
  console.log("ok payment reminder wording and Mongolia-local deadline formatting");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
