import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./cleanup-staging-registration-tests.mjs", import.meta.url), "utf8");

function position(statement) {
  const index = source.indexOf(statement);
  assert.notEqual(index, -1, `expected cleanup statement: ${statement}`);
  return index;
}

assert.match(source, /\^registration:\[0-9a-f-\]\{36\}\$/);
assert.match(source, /\^non-test:\[0-9a-f-\]\{36\}\$/);
assert.match(source, /refuses production/);
assert.match(source, /STAGING NON-TEST REHEARSAL/);
assert.match(source, /COALESCE\(\s*registration_draft_child\.selected_class_session_id,\s*registration_draft_child\.preferred_waitlist_class_session_id\s*\)/);

assert.ok(
  position('DELETE FROM payment_notification_milestone WHERE ${scoped("payment_notification_milestone")};')
    < position('DELETE FROM payment_installment WHERE ${requestScoped("payment_installment")};'),
  "notification milestones must be deleted before installments",
);
assert.ok(
  position('DELETE FROM registration_draft_referral WHERE ${childScoped("registration_draft_referral")};')
    < position('DELETE FROM registration_draft WHERE ${scoped("registration_draft", "id")};'),
  "draft referral captures must be deleted before drafts",
);
assert.ok(
  position('DELETE FROM discount_award WHERE ${childScoped("discount_award", "registration_draft_child_id")};')
    < position('DELETE FROM registration_draft WHERE ${scoped("registration_draft", "id")};'),
  "discount awards must be deleted before their draft children and draft parents",
);
assert.ok(
  position('DELETE FROM email_verification_challenge WHERE ${scoped("email_verification_challenge")};')
    < position('DELETE FROM registration_draft WHERE ${scoped("registration_draft", "id")};'),
  "email challenges must be deleted before drafts",
);
assert.ok(
  position('DELETE FROM payment_confirmation WHERE ${requestScoped("payment_confirmation")};')
    < position('DELETE FROM received_payment WHERE ${requestScoped("received_payment")};'),
  "payment confirmations must be deleted before received payments",
);
assert.ok(
  position('DELETE FROM enrollment_referral_code WHERE ${scoped("enrollment_referral_code")};')
    < position('DELETE FROM enrollment WHERE ${scoped("enrollment")};'),
  "canonical referral codes must be deleted before their promoted enrollment",
);
assert.ok(
  position('DELETE FROM enrollment WHERE ${scoped("enrollment")};')
    < position('DELETE FROM pre_registration WHERE ${scoped("pre_registration")};'),
  "promoted enrollment must be removed before its application-child cascade",
);
assert.match(source, /DELETE FROM student\s+WHERE \$\{scoped\("student"\)\}/, "test students remain guarded by the exact test-run scope");
assert.match(source, /DELETE FROM guardian_account\s+WHERE \$\{scoped\("guardian_account"\)\}/, "test guardians remain guarded by the exact test-run scope");
assert.doesNotMatch(source, /DELETE FROM audit_event/);

console.log("staging registration cleanup regression checks passed");
