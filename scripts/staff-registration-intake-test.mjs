import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const page = readFileSync("src/pages/staff/registration-intake.astro", "utf8");
const payments = readFileSync("src/pages/staff/payments.astro", "utf8");
const router = readFileSync("src/server/api/router.ts", "utf8");
const submission = readFileSync("src/server/services/registration-submission.ts", "utf8");
const registrationContent = readFileSync("src/content/registration.ts", "utf8");
const styles = readFileSync("src/styles/global.css", "utf8");

assert.match(payments, /href="\/staff\/registration-intake\/"/, "the existing payment workspace links to staff-assisted intake");
assert.match(page, /Цаасан маягт[\s\S]*Утсаар[\s\S]*Биечлэн/, "the intake channel choices are explicit");
assert.match(page, /Эцэг эх \/ асран хамгаалагч бүртгэлийн нөхцөлийг зөвшөөрсөн\.[\s\S]*Хүүхэд бүртгүүлэхээ мэдэж, зөвшөөрсөн\./, "both staff-recorded acknowledgements are required");
assert.match(page, /Төлбөрийн мэдээллийг и-мэйлээр илгээх/, "receipt delivery is explicit rather than implicit");
assert.match(page, /Сонгоогүй бол одоо и-мэйл илгээхгүй боловч төлбөрийн хугацааны сануулга хэвийн ажиллана\./, "receipt opt-out explains that ordinary payment reminders can still be sent");
assert.match(page, /Заавал бөглөнө/, "required intake fields have an explicit non-color indicator");
assert.match(page, /required-marker/, "required labels show the shared visual indicator");
assert.doesNotMatch(page, /staff-intake-required-note/, "the form does not repeat the visible required-field legend");
assert.match(page, /Хэлбэр<span class="required-marker"/, "required markers are directly attached to field labels");
assert.match(page, /зөвшөөрсөн\.<span class="required-marker"/, "required acknowledgement markers stay attached to the acknowledgement text");
assert.doesNotMatch(page, /Хэлбэр\s+<span class="required-marker"/, "required labels do not insert visible spacing before their marker");
assert.match(page, /guardianRelationshipOptions\.map/, "staff intake uses the shared guardian relationship choices");
assert.match(page, /currentGradeOptions\.map/, "staff intake uses the shared school-grade choices");
assert.match(registrationContent, /guardianRelationshipOptions = \["Ээж", "Аав", "Асран хамгаалагч", "Өвөө \/ эмээ", "Бусад"\]/, "the public relationship source includes grandparent and other");
assert.match(registrationContent, /gradeOptions: currentGradeOptions/, "public registration uses the same grade source");
assert.match(submission, /guardianRelationshipOptions\.includes/, "shared guardian values are validated server-side");
assert.match(submission, /currentGradeOptions\.some/, "shared school-grade values are validated server-side");
assert.match(page, /<option value="not_specified" selected>Тодруулаагүй/, "unspecified gender is an actual staff-intake selection rather than an empty placeholder");
assert.match(submission, /new Set\(\["female", "male", "not_specified"\]\)/, "the established unspecified gender value is accepted by the shared service");
assert.match(page, /renderPublicProse/, "the exact current rules use the public read-only renderer");
assert.doesNotMatch(page, /href="\/staff\/info\/"/, "staff intake rules do not lead to the authorized rule editor");
const rulesRender = page.slice(page.indexOf('q(target).innerHTML'), page.indexOf('show("intake-app")'));
assert.match(rulesRender, /<summary>\$\{escape\(rule\.title\)\}<\/summary>/, "read-only rules show their public title only");
assert.doesNotMatch(rulesRender, /rule\.versionId/, "read-only rule headings do not expose internal revision identifiers");
assert.doesNotMatch(payments, /Утас, цаасан маягт эсвэл биечлэн авсан бүртгэл/, "the payment-list intake link has no permanent explanatory subtitle");
assert.match(page, /Idempotency-Key/, "the staff form uses an idempotency key");
assert.doesNotMatch(page, /turnstile|TURNSTILE/i, "authenticated staff intake does not render a public Turnstile widget");
assert.match(page, /\/staff\/payments\/\$\{anchor\}/, "success returns to the existing payment list with its new registration anchor");
assert.match(router, /path === "\/api\/staff\/registration-intake"[\s\S]*?"registration\.manage"/, "staff intake is server-side protected by the existing registration-management capability");
assert.match(router, /staffAssisted: \{[\s\S]*?staffAccountId: principal\.staffAccountId/, "the authenticated actor is passed to the normal creation service");
assert.match(router, /if \(payload\.sendReceipt === true && draft\.created\) \{[\s\S]*?sendRegistrationReceipt\(env, draft\.draftId\)/, "an explicit checked receipt option queues the existing idempotent receipt exactly through its normal path");
assert.doesNotMatch(router, /if \(payload\.sendReceipt !== true[\s\S]*?sendRegistrationReceipt\(env, draft\.draftId\)/, "an unchecked receipt option does not enqueue an immediate receipt");
assert.match(submission, /registration\.created_by_staff/, "staff-assisted source is preserved in audit history");
assert.match(submission, /intakeChannel[\s\S]*guardianAcknowledged[\s\S]*childAcknowledged[\s\S]*receiptRequested/, "structured intake provenance includes channel, acknowledgements, and email choice");
assert.match(submission, /acquireAllRequestedSeatsSql/, "staff-assisted intake reuses the shared atomic capacity acquisition");
assert.doesNotMatch(readFileSync("src/server/staff/payment-reminders.ts", "utf8"), /receiptRequested|registration\.created_by_staff/, "the immediate receipt preference does not suppress ordinary payment reminders");

function assertOrder(...needles) {
  const positions = needles.map((needle) => page.indexOf(needle));
  assert(positions.every((position) => position >= 0), `all fields must exist: ${needles.join(", ")}`);
  for (let index = 1; index < positions.length; index += 1) {
    assert(positions[index - 1] < positions[index], `fields must remain in DOM order: ${needles.join(" -> ")}`);
  }
}

assertOrder(
  'name="guardianName"',
  'name="guardianRelationship"',
  'name="guardianEmail"',
  'name="guardianPhone"',
  'name="guardianFacebook"',
  'name="guardianSecondaryPhone"',
  'name="guardianAddress"',
);
assertOrder(
  'name="surname"',
  'name="givenName"',
  'name="dateOfBirth"',
  'name="gender"',
  'name="currentGrade"',
  'name="currentSchool"',
  'name="stage"',
  'name="classSessionId"',
  'name="paymentPlanCode"',
  'name="codeInput"',
  'name="returningStatus"',
  'id="previous-stage-field"',
);
assertOrder(
  'id="intake-rules-label"',
  'class="staff-intake-consent-separator"',
  'id="guardian-rule-link"',
  'name="parentRulesAcknowledged"',
  'id="student-rule-link"',
  'name="studentRulesAcknowledged"',
  'name="sendReceipt"',
  'class="staff-intake-email-help staff-wide"',
  'id="intake-submit"',
);
assert.match(page, /\["guardian", "#guardian-rule-link"\], \["student", "#student-rule-link"\]/, "the active guardian and student rules render into their matching DOM positions");
assert.equal((page.match(/staff-intake-consent-separator/g) || []).length, 2, "full-width separators frame the consent group without changing its DOM order");
const firstConsentSeparator = page.indexOf('class="staff-intake-consent-separator"');
const secondConsentSeparator = page.indexOf('class="staff-intake-consent-separator"', firstConsentSeparator + 1);
assert(firstConsentSeparator < page.indexOf('id="guardian-rule-link"'), "the first separator precedes the parent rule");
assert(secondConsentSeparator > page.indexOf('name="studentRulesAcknowledged"') && secondConsentSeparator < page.indexOf('name="sendReceipt"'), "the second separator follows the child acknowledgement");
assert.doesNotMatch(page, /<h2>Журам, зөвшөөрөл<\/h2>/, "the consent grouping heading is screen-reader-only rather than visible");
assert.match(styles, /\.staff-intake-consent-separator \{[\s\S]*?border-top: 1px solid var\(--line\)/, "the consent separator is a single full-width horizontal line");
assert.match(page, /event\.target\.name === "returningStatus"\) q\("#previous-stage-field"\)\.hidden = selected\("returningStatus"\) !== "returning"/, "previous-study selection only reveals the final reserved field");
assert.match(styles, /@media \(max-width: 38rem\) \{[\s\S]*?\.staff-registration-intake \{\s*grid-template-columns: minmax\(0, 1fr\);/, "the staff intake form uses its DOM order as a one-column phone layout");

console.log("ok staff-assisted registration intake surface");
