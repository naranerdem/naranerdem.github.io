import { createHash, randomUUID } from "node:crypto";

export const PRIVATE_OPERATIONAL_CONFIG_SCHEMA_VERSION = 1;

function expect(value, message) {
  if (!value) throw new Error(`Invalid private operational configuration: ${message}`);
}

function exactKeys(value, expected, label) {
  expect(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  const actual = Object.keys(value).sort(); const wanted = [...expected].sort();
  expect(actual.length === wanted.length && actual.every((key, index) => key === wanted[index]), `${label} has unsupported or missing fields`);
}

function nullableText(value, label, max) {
  expect(value === null || (typeof value === "string" && value.length <= max), `${label} is invalid`);
  return value === "" ? null : value;
}

function requiredText(value, label, max) {
  expect(typeof value === "string" && value.trim().length > 0 && value.length <= max, `${label} is invalid`);
  return value;
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function validatePrivateOperationalConfigBundle(bundle) {
  exactKeys(bundle, ["schema_version", "exported_at", "source_environment", "center_information", "course_rules", "payment_collection"], "bundle");
  expect(bundle.schema_version === PRIVATE_OPERATIONAL_CONFIG_SCHEMA_VERSION, `unsupported schema_version ${String(bundle.schema_version)}`);
  expect(typeof bundle.exported_at === "string" && new Date(bundle.exported_at).toISOString() === bundle.exported_at, "exported_at is invalid");
  expect(["staging", "production"].includes(bundle.source_environment), "source_environment is invalid");
  exactKeys(bundle.center_information, ["phone", "public_email", "facebook_page_url", "physical_address", "homepage_intro", "about_center_text", "teacher_bio"], "center_information");
  nullableText(bundle.center_information.phone, "center phone", 80);
  nullableText(bundle.center_information.public_email, "center public email", 200);
  nullableText(bundle.center_information.facebook_page_url, "center Facebook URL", 500);
  nullableText(bundle.center_information.physical_address, "center address", 500);
  nullableText(bundle.center_information.homepage_intro, "center intro", 1000);
  nullableText(bundle.center_information.about_center_text, "center description", 6000);
  nullableText(bundle.center_information.teacher_bio, "teacher bio", 4000);
  exactKeys(bundle.payment_collection, ["bank_name", "account_holder_name", "account_number", "iban", "transfer_instruction"], "payment_collection");
  nullableText(bundle.payment_collection.bank_name, "bank name", 160);
  nullableText(bundle.payment_collection.account_holder_name, "account holder", 160);
  nullableText(bundle.payment_collection.account_number, "account number", 160);
  nullableText(bundle.payment_collection.iban, "IBAN", 100);
  nullableText(bundle.payment_collection.transfer_instruction, "transfer instruction", 1000);
  expect(Array.isArray(bundle.course_rules) && bundle.course_rules.length === 2, "course_rules must contain exactly two current rules");
  const codes = new Set();
  for (const rule of bundle.course_rules) {
    exactKeys(rule, ["code", "title", "body_text", "body_hash"], "course rule");
    expect(["guardian", "student"].includes(rule.code) && !codes.has(rule.code), "course rule code is invalid");
    codes.add(rule.code);
    requiredText(rule.title, "course rule title", 160);
    requiredText(rule.body_text, "course rule body", 12000);
    expect(typeof rule.body_hash === "string" && /^[a-f0-9]{64}$/.test(rule.body_hash) && rule.body_hash === sha256(rule.body_text), "course rule hash is invalid");
  }
  return bundle;
}

function comparable(value) {
  return JSON.stringify(value);
}

export function createPrivateOperationalConfigBundle({ centerInformation, courseRules, paymentCollection }, sourceEnvironment, exportedAt = new Date().toISOString()) {
  return validatePrivateOperationalConfigBundle({
    schema_version: PRIVATE_OPERATIONAL_CONFIG_SCHEMA_VERSION,
    exported_at: exportedAt,
    source_environment: sourceEnvironment,
    center_information: centerInformation,
    course_rules: [...courseRules].sort((left, right) => left.code.localeCompare(right.code)),
    payment_collection: paymentCollection,
  });
}

export function buildPrivateOperationalConfigImportPlan(bundle, target) {
  validatePrivateOperationalConfigBundle(bundle);
  expect(target?.centerInformation?.updated_at, "target center information is missing");
  expect(target?.paymentCollection?.updated_at, "target payment collection is missing");
  const targetRules = new Map(target.courseRules?.map((rule) => [rule.code, rule]));
  expect(targetRules.size === 2 && targetRules.has("guardian") && targetRules.has("student"), "target rules are incomplete");
  const centerFields = ["phone", "public_email", "facebook_page_url", "physical_address", "homepage_intro", "about_center_text", "teacher_bio"];
  const paymentFields = ["bank_name", "account_holder_name", "account_number", "iban", "transfer_instruction"];
  const center = { action: comparable(bundle.center_information) === comparable(Object.fromEntries(centerFields.map((field) => [field, target.centerInformation[field] ?? null]))) ? "unchanged" : "update", value: bundle.center_information, target: target.centerInformation };
  const payment = { action: comparable(bundle.payment_collection) === comparable(Object.fromEntries(paymentFields.map((field) => [field, target.paymentCollection[field] ?? null]))) ? "unchanged" : "update", value: bundle.payment_collection, target: target.paymentCollection };
  const rules = bundle.course_rules.map((rule) => {
    const current = targetRules.get(rule.code);
    return { action: current.body_hash === rule.body_hash && current.title === rule.title ? "unchanged" : "update", rule, target: current };
  });
  return { center, payment, rules };
}

function quote(value) {
  if (value === null || value === undefined) return "NULL";
  return `'${String(value).replaceAll("'", "''")}'`;
}

function guardedAuditSql(condition, id, action, subjectType, subjectId, metadata, timestamp) {
  const columns = "id, occurred_at, actor_type, actor_ref, action, subject_type, subject_id, metadata_json, environment, is_test, test_run_id, created_at";
  const values = `${quote(id)}, ${quote(timestamp)}, 'system', NULL, ${quote(action)}, ${quote(subjectType)}, ${quote(subjectId)}, ${quote(JSON.stringify(metadata))}, 'production', 0, NULL, ${quote(timestamp)}`;
  const rejected = `${quote(id)}, ${quote(timestamp)}, 'private_import_guard_failure', NULL, ${quote(action)}, ${quote(subjectType)}, ${quote(subjectId)}, NULL, 'production', 0, NULL, ${quote(timestamp)}`;
  return `INSERT INTO audit_event (${columns}) SELECT ${values} WHERE ${condition} UNION ALL SELECT ${rejected} WHERE NOT (${condition});`;
}

export function buildPrivateOperationalConfigImportSql(plan, timestamp = new Date().toISOString(), idFactory = randomUUID) {
  const changedRules = plan.rules.filter((entry) => entry.action === "update");
  if (plan.center.action === "unchanged" && plan.payment.action === "unchanged" && !changedRules.length) return "";
  const lines = [];
  if (plan.center.action === "update") {
    const current = plan.center.target;
    const value = plan.center.value;
    lines.push(guardedAuditSql(`EXISTS (SELECT 1 FROM public_center_information WHERE singleton = 1 AND updated_at = ${quote(current.updated_at)})`, `private-operational-center-${idFactory()}`, "private_operational_center_imported", "public_center_information", "1", { fields: Object.keys(value) }, timestamp));
    lines.push(`UPDATE public_center_information SET phone=${quote(value.phone)}, public_email=${quote(value.public_email)}, facebook_page_url=${quote(value.facebook_page_url)}, physical_address=${quote(value.physical_address)}, homepage_intro=${quote(value.homepage_intro)}, about_center_text=${quote(value.about_center_text)}, teacher_bio=${quote(value.teacher_bio)}, updated_at=${quote(timestamp)} WHERE singleton=1 AND updated_at=${quote(current.updated_at)};`);
  }
  if (plan.payment.action === "update") {
    const current = plan.payment.target;
    const value = plan.payment.value;
    lines.push(guardedAuditSql(`EXISTS (SELECT 1 FROM payment_collection_settings WHERE singleton = 1 AND updated_at = ${quote(current.updated_at)})`, `private-operational-payment-${idFactory()}`, "private_operational_payment_collection_imported", "payment_collection_settings", "1", { fields: Object.keys(value) }, timestamp));
    lines.push(`UPDATE payment_collection_settings SET bank_name=${quote(value.bank_name)}, account_holder_name=${quote(value.account_holder_name)}, account_number=${quote(value.account_number)}, iban=${quote(value.iban)}, transfer_instruction=${quote(value.transfer_instruction)}, updated_at=${quote(timestamp)} WHERE singleton=1 AND updated_at=${quote(current.updated_at)};`);
  }
  for (const entry of changedRules) {
    const { rule, target } = entry; const versionId = `private-operational-rule-${idFactory()}`;
    lines.push(guardedAuditSql(`EXISTS (SELECT 1 FROM course_rule_document document JOIN course_rule_version version ON version.id = document.current_version_id WHERE document.id = ${quote(target.id)} AND document.updated_at = ${quote(target.updated_at)} AND version.body_hash = ${quote(target.body_hash)})`, `private-operational-rule-${idFactory()}`, "private_operational_course_rule_imported", "course_rule_document", target.id, { code: rule.code, bodyHash: rule.body_hash }, timestamp));
    lines.push(`INSERT OR IGNORE INTO course_rule_version (id, course_rule_document_id, body_text, body_hash, created_at) VALUES (${quote(versionId)}, ${quote(target.id)}, ${quote(rule.body_text)}, ${quote(rule.body_hash)}, ${quote(timestamp)});`);
    lines.push(`UPDATE course_rule_document SET title=${quote(rule.title)}, current_version_id=(SELECT id FROM course_rule_version WHERE course_rule_document_id=${quote(target.id)} AND body_hash=${quote(rule.body_hash)}), updated_at=${quote(timestamp)} WHERE id=${quote(target.id)} AND updated_at=${quote(target.updated_at)};`);
  }
  return `${lines.join("\n\n")}\n`;
}

export function operationalConfigPlanSummary(plan) {
  return {
    centerInformation: plan.center.action,
    paymentCollection: plan.payment.action,
    courseRules: plan.rules.map((entry) => ({ code: entry.rule.code, action: entry.action })),
  };
}

export function privateOperationalConfigText(bundle) {
  validatePrivateOperationalConfigBundle(bundle);
  return `${JSON.stringify(bundle, null, 2)}\n`;
}
