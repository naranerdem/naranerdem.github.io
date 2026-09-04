import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("..", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

const [verification, transactional, parentService, staffCommunication, parentPage, payments] = await Promise.all([
  read("src/server/auth/email-verification.ts"),
  read("src/server/email/registration-transactional.ts"),
  read("src/server/services/parent-access.ts"),
  read("src/server/staff/parent-communication.ts"),
  read("src/pages/parent.astro"),
  read("src/pages/staff/payments.astro"),
]);

assert.match(verification, /sendParentAccessEmail/, "system-email access links use the durable challenge path");
assert.match(verification, /eventType === "enrollment_confirmed"/, "only designated system email events establish parent access");
assert.match(verification, /verified_at = COALESCE/, "email-channel access records the existing verified-email state");
assert.match(transactional, /sendEnrollmentConfirmationEmail/, "canonical enrollment has a dedicated transactional message");
assert.match(transactional, /enrollment_confirmed/, "confirmation email has a durable outbox event");
assert.match(transactional, /remainingPaymentDueAt/, "partial balances and their deadline are included in the current summary");
assert.match(parentService, /canonical_guardian_account_id/, "parent records use canonical guardian linkage, not fuzzy matching");
assert.match(parentService, /status: row\.childStatus === "cancelled"/, "cancelled state remains truthful in the parent projection");
assert.match(parentPage, /\/api\/parent\/status/, "the parent page is read-only and session-backed");
assert.match(staffCommunication, /parent_manual_message_generated/, "manual-message generation is audited");
assert.doesNotMatch(staffCommunication, /verifyEmailToken|sendParentAccessEmail/, "manual messages cannot issue a verifying access link");
assert.match(payments, /И-мэйл дахин илгээх/, "contact actions stay inside opened staff detail");
assert.match(payments, /Мессеж үүсгэх/, "manual copy helper is available in opened staff detail");
assert.match(payments, /Мессежийн урьдчилсан харагдац/, "manual messages are previewed before a separate copy action");
assert.match(payments, /И-мэйл илгээхээр дараалалд орлоо/, "staff resend feedback reflects queueing rather than claiming delivery");

console.log("ok parent access foundation boundaries");
