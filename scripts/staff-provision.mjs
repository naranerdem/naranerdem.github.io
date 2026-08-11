import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const allowedRoles = new Set(["admin", "teacher", "accountant"]);

function option(name) {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? "";
}

function quote(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return String(value);
  return `'${String(value).replaceAll("'", "''")}'`;
}

function normalizeEmail(value) {
  return value.normalize("NFKC").trim().toLowerCase();
}

const environment = option("env");
const email = normalizeEmail(option("email"));
const displayName = option("name").normalize("NFKC").trim();
const role = option("role");
const productionConfirmed = process.argv.includes("--confirm-production");

if (!new Set(["staging", "production"]).has(environment)) {
  throw new Error("Choose an explicit environment with --env=staging or --env=production.");
}
if (environment === "production" && !productionConfirmed) {
  throw new Error("Production provisioning requires --confirm-production.");
}
if (environment === "staging" && productionConfirmed) {
  throw new Error("Do not use --confirm-production with staging.");
}
if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  throw new Error("Provide a valid --email address.");
}
if (!displayName || displayName.length > 120) {
  throw new Error("Provide a nonempty --name up to 120 characters.");
}
if (!allowedRoles.has(role)) {
  throw new Error("Choose --role=admin, --role=teacher, or --role=accountant.");
}
if (environment === "staging" && !email.endsWith("@example.invalid")) {
  throw new Error("Staging staff fixtures must use an @example.invalid intended address.");
}

const now = new Date().toISOString();
const accountId = randomUUID();
const isTest = environment === "staging" ? 1 : 0;
const testRunId = isTest ? "staging-staff-fixture" : null;
const auditStem = createHash("sha256").update(`${environment}/${email}`).digest("hex").slice(0, 32);
const sql = `
PRAGMA foreign_keys = ON;

INSERT INTO staff_account (
  id, email_normalized, display_name, status, is_test, test_run_id, created_at, updated_at
) SELECT
  ${quote(accountId)}, ${quote(email)}, ${quote(displayName)}, 'active',
  ${isTest}, ${quote(testRunId)}, ${quote(now)}, ${quote(now)}
WHERE NOT EXISTS (
  SELECT 1 FROM staff_account WHERE email_normalized = ${quote(email)}
);

INSERT OR IGNORE INTO staff_account_role (
  staff_account_id, role_code, assigned_by_staff_account_id, assigned_at
)
SELECT id, ${quote(role)}, NULL, ${quote(now)}
FROM staff_account
WHERE email_normalized = ${quote(email)};

INSERT OR IGNORE INTO audit_event (
  id, occurred_at, actor_type, actor_ref, action, subject_type, subject_id,
  metadata_json, environment, is_test, test_run_id, created_at
)
SELECT
  ${quote(`staff-create-${auditStem}`)}, ${quote(now)}, 'system', NULL,
  'staff_account_created', 'staff_account', id,
  ${quote(JSON.stringify({ environment }))}, ${quote(environment)},
  ${isTest}, ${quote(testRunId)}, ${quote(now)}
FROM staff_account
WHERE id = ${quote(accountId)};

INSERT OR IGNORE INTO audit_event (
  id, occurred_at, actor_type, actor_ref, action, subject_type, subject_id,
  metadata_json, environment, is_test, test_run_id, created_at
)
SELECT
  ${quote(`staff-role-${auditStem}-${role}`)}, ${quote(now)}, 'system', NULL,
  'staff_role_assigned', 'staff_account', id,
  ${quote(JSON.stringify({ role, environment }))}, ${quote(environment)},
  ${isTest}, ${quote(testRunId)}, ${quote(now)}
FROM staff_account
WHERE email_normalized = ${quote(email)};
`;

const tempDir = mkdtempSync(path.join(tmpdir(), "naranerdem-staff-provision-"));
const sqlPath = path.join(tempDir, "provision.sql");
writeFileSync(sqlPath, sql, { encoding: "utf8", mode: 0o600 });

try {
  const wrangler = path.resolve("node_modules/wrangler/wrangler-dist/cli.js");
  const args = [wrangler, "d1", "execute", "DB", "--env", environment === "staging" ? "staging" : ""];
  args.push("--remote", "--file", sqlPath);
  const result = spawnSync(process.execPath, args, { encoding: "utf8", stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
  console.log(`Staff provisioning completed for ${environment} role ${role}.`);
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
