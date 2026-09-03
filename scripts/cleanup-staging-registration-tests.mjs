import { spawnSync } from "node:child_process";
import path from "node:path";

const args = new Set(process.argv.slice(2));
const runArgument = process.argv.slice(2).find((value) => value.startsWith("--test-run-id="));
const nonTestArgument = process.argv.slice(2).find((value) => value.startsWith("--non-test-rehearsal-id="));
const testRunId = runArgument?.slice("--test-run-id=".length) ?? "";
const nonTestRehearsalId = nonTestArgument?.slice("--non-test-rehearsal-id=".length) ?? "";
const confirmed = args.has("--confirm");

if (Boolean(testRunId) === Boolean(nonTestRehearsalId)) {
  throw new Error("Use exactly one of --test-run-id=registration:<draft-uuid> or --non-test-rehearsal-id=non-test:<uuid>.");
}
if (testRunId && !/^registration:[0-9a-f-]{36}$/.test(testRunId)) {
  throw new Error("Use --test-run-id=registration:<draft-uuid> to scope cleanup to one staging test registration.");
}
if (nonTestRehearsalId && !/^non-test:[0-9a-f-]{36}$/.test(nonTestRehearsalId)) {
  throw new Error("Use --non-test-rehearsal-id=non-test:<uuid> for one explicitly tagged synthetic staging rehearsal.");
}
if (args.has("--env=production") || args.has("--production")) {
  throw new Error("This cleanup command refuses production.");
}

const wrangler = path.resolve("node_modules/wrangler/wrangler-dist/cli.js");
const rehearsalMarker = `STAGING NON-TEST REHEARSAL ${nonTestRehearsalId}`;
const nonTestDraftScope = `registration_draft.id IN (
  SELECT registration_draft.id
  FROM registration_draft
  INNER JOIN registration_draft_child ON registration_draft_child.registration_draft_id = registration_draft.id
  INNER JOIN class_session ON class_session.id = COALESCE(
    registration_draft_child.selected_class_session_id,
    registration_draft_child.preferred_waitlist_class_session_id
  )
  INNER JOIN activity_offering ON activity_offering.id = class_session.activity_offering_id
  INNER JOIN academic_year ON academic_year.id = class_session.academic_year_id
  WHERE registration_draft.is_test = 0
    AND registration_draft.test_run_id IS NULL
    AND registration_draft.normalized_email LIKE '%@example.test'
    AND class_session.is_test = 0 AND class_session.test_run_id IS NULL
    AND activity_offering.is_test = 0 AND activity_offering.test_run_id IS NULL
    AND academic_year.is_test = 0 AND academic_year.test_run_id IS NULL
    AND academic_year.public_label = '${rehearsalMarker}'
    AND activity_offering.title = '${rehearsalMarker}'
    AND class_session.display_label = '${rehearsalMarker}'
)`;
const scoped = (table, draftColumn = "registration_draft_id") => testRunId
  ? `${table}.is_test = 1 AND ${table}.test_run_id = '${testRunId}'`
  : `${draftColumn} IN (SELECT id FROM registration_draft WHERE ${nonTestDraftScope})`;
const childScoped = (table, childColumn = "registration_draft_child_id") => testRunId
  ? `${table}.is_test = 1 AND ${table}.test_run_id = '${testRunId}'`
  : `${childColumn} IN (
    SELECT registration_draft_child.id FROM registration_draft_child
    WHERE registration_draft_child.registration_draft_id IN (SELECT id FROM registration_draft WHERE ${nonTestDraftScope})
  )`;
const requestScoped = (table, requestColumn = "payment_request_id") => testRunId
  ? `${table}.is_test = 1 AND ${table}.test_run_id = '${testRunId}'`
  : `${requestColumn} IN (
    SELECT payment_request.id FROM payment_request
    WHERE ${scoped("payment_request")}
  )`;
const installmentScoped = (table, installmentColumn = "payment_installment_id") => testRunId
  ? `${table}.is_test = 1 AND ${table}.test_run_id = '${testRunId}'`
  : `${installmentColumn} IN (
    SELECT payment_installment.id FROM payment_installment
    WHERE ${requestScoped("payment_installment")}
  )`;
const countSql = `
SELECT
  (SELECT COUNT(*) FROM registration_draft WHERE ${scoped("registration_draft", "id")}) AS drafts,
  (SELECT COUNT(*) FROM registration_draft_referral WHERE ${childScoped("registration_draft_referral")}) AS referrals,
  (SELECT COUNT(*) FROM payment_notification_milestone WHERE ${scoped("payment_notification_milestone")}) AS notification_milestones,
  (SELECT COUNT(*) FROM outbound_email WHERE ${scoped("outbound_email")}) AS emails;
`;
const count = spawnSync(process.execPath, [
  wrangler, "d1", "execute", "DB", "--env", "staging", "--remote", "--command", countSql,
], { encoding: "utf8", stdio: confirmed ? "pipe" : "inherit" });
if (count.status !== 0) process.exit(count.status ?? 1);

if (!confirmed) {
  console.log("Dry run only. Add --confirm to delete this exact staging rehearsal scope.");
  process.exit(0);
}

process.stdout.write(count.stdout);
const deleteSql = `
-- Restrictive children introduced by later migrations must be removed before
-- their draft, child, installment, or request parents. Audit rows are kept.
DELETE FROM payment_notification_milestone WHERE ${scoped("payment_notification_milestone")};
DELETE FROM waitlist_seat_offer WHERE ${childScoped("waitlist_seat_offer")};
DELETE FROM registration_draft_referral WHERE ${childScoped("registration_draft_referral")};
DELETE FROM discount_award WHERE ${childScoped("discount_award", "registration_draft_child_id")};
DELETE FROM registration_data_correction WHERE ${childScoped("registration_data_correction")};
DELETE FROM payment_evidence WHERE ${scoped("payment_evidence")};
DELETE FROM payment_allocation WHERE ${installmentScoped("payment_allocation")};
DELETE FROM payment_confirmation WHERE ${requestScoped("payment_confirmation")};
DELETE FROM payment_credit WHERE ${requestScoped("payment_credit")};
DELETE FROM received_payment WHERE ${requestScoped("received_payment")};
DELETE FROM payment_installment WHERE ${requestScoped("payment_installment")};
DELETE FROM payment_request WHERE ${scoped("payment_request")};
DELETE FROM email_verification_challenge WHERE ${scoped("email_verification_challenge")};
DELETE FROM verified_email_session WHERE ${scoped("verified_email_session")};
DELETE FROM outbound_email WHERE ${scoped("outbound_email")};
DELETE FROM registration_draft WHERE ${scoped("registration_draft", "id")};
${nonTestRehearsalId ? `
DELETE FROM registration_window_offering
  WHERE registration_window_id IN (SELECT id FROM registration_window WHERE name = '${rehearsalMarker}' AND is_test = 0 AND test_run_id IS NULL);
DELETE FROM registration_window WHERE name = '${rehearsalMarker}' AND is_test = 0 AND test_run_id IS NULL;
DELETE FROM class_meeting_rule
  WHERE class_session_id IN (SELECT id FROM class_session WHERE display_label = '${rehearsalMarker}' AND is_test = 0 AND test_run_id IS NULL);
DELETE FROM offering_course_pricing
  WHERE activity_offering_id IN (SELECT id FROM activity_offering WHERE title = '${rehearsalMarker}' AND is_test = 0 AND test_run_id IS NULL);
DELETE FROM class_session WHERE display_label = '${rehearsalMarker}' AND is_test = 0 AND test_run_id IS NULL;
DELETE FROM activity_offering WHERE title = '${rehearsalMarker}' AND is_test = 0 AND test_run_id IS NULL;
DELETE FROM academic_year WHERE public_label = '${rehearsalMarker}' AND is_test = 0 AND test_run_id IS NULL;
` : ""}
`;
const cleanup = spawnSync(process.execPath, [
  wrangler, "d1", "execute", "DB", "--env", "staging", "--remote", "--command", deleteSql,
], { encoding: "utf8", stdio: "inherit" });
if (cleanup.status !== 0) process.exit(cleanup.status ?? 1);
console.log(testRunId
  ? `Deleted staging test registration ${testRunId}.`
  : `Deleted explicitly tagged non-test staging rehearsal ${nonTestRehearsalId}.`);
