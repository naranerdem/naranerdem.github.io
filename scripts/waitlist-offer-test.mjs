import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const dir = mkdtempSync(path.join(tmpdir(), "naranerdem-waitlist-offer-"));
const dbPath = path.join(dir, "test.sqlite3");
const esbuild = path.resolve("node_modules/esbuild/bin/esbuild");
const bundle = path.join(dir, "waitlist-offers.mjs");
const result = spawnSync(esbuild, ["src/server/services/waitlist-offers.ts", "--bundle", "--format=esm", "--platform=node", `--outfile=${bundle}`], { encoding: "utf8" });
if (result.status !== 0) throw new Error(result.stderr);

function quote(value) { if (value == null) return "NULL"; if (typeof value === "number") return String(value); return `'${String(value).replaceAll("'", "''")}'`; }
function bind(sql, values) { let index = 0; return sql.replaceAll("?", () => quote(values[index++])); }
function sqlite(sql, json = false) { const result = spawnSync("sqlite3", [json ? "-json" : "", dbPath].filter(Boolean), { input: `PRAGMA foreign_keys=ON;\n${sql}`, encoding: "utf8" }); if (result.status !== 0) throw new Error(`${result.stderr}\n${sql}`); return result.stdout.trim(); }
class Statement { constructor(db, sql) { this.db = db; this.sql = sql; this.values = []; } bind(...values) { this.values = values; return this; } async all() { const out = sqlite(`${bind(this.sql, this.values)};`, true); return { success: true, results: out ? JSON.parse(out) : [] }; } async first() { return (await this.all()).results[0] ?? null; } async run() { const out = sqlite(`${bind(this.sql, this.values)}; SELECT changes() AS changes;`, true); const rows = out ? JSON.parse(out) : []; return { success: true, results: [], meta: { changes: Number(rows.at(-1)?.changes ?? 0) } }; } }
class D1 { prepare(sql) { return new Statement(this, sql); } async batch(statements) { const sql = statements.map((statement, index) => `${bind(statement.sql, statement.values)}; INSERT INTO _changes VALUES (${index}, changes());`).join("\n"); const out = sqlite(`CREATE TEMP TABLE _changes (idx INTEGER, changes INTEGER); BEGIN IMMEDIATE; ${sql} COMMIT; SELECT * FROM _changes ORDER BY idx;`, true); return (out ? JSON.parse(out) : []).map((row) => ({ success: true, results: [], meta: { changes: Number(row.changes) } })); } }

function now(minutes = 0) { return new Date(Date.UTC(2026, 7, 23, 8, minutes)).toISOString(); }
function seed(database, id, createdAt) {
  const draft = `draft-${id}`; const child = `child-${id}`; const entry = `entry-${id}`;
  database.prepare(`INSERT INTO registration_draft (id, access_token_hash, academic_year_id, guardian_full_name, guardian_relationship, primary_phone, email, normalized_email, facebook_name, home_address, payment_plan_code, parent_rules_version, student_rules_version, status, expires_at, is_test, test_run_id, created_at, updated_at) VALUES (?, ?, 'year', ?, 'Ээж', '99000000', ?, ?, 'FB', 'Хаяг', 'per_child', 'p', 's', 'waitlisted', ?, 1, 'waitlist-test', ?, ?)`)
    .bind(draft, `${id}`.padEnd(64, "a"), `Асран ${id}`, `${id}@example.test`, `${id}@example.test`, now(10000), createdAt, createdAt).run();
  database.prepare(`INSERT INTO registration_draft_child (id, registration_draft_id, position, surname, given_name, gender, date_of_birth, current_grade, returning_status, selected_stage_code, preferred_waitlist_class_session_id, status, is_test, test_run_id, created_at, updated_at) VALUES (?, ?, 0, 'Тест', ?, 'not_specified', '2015-01-01', '5', 'new', 'stage_1', 'class', 'waitlisted', 1, 'waitlist-test', ?, ?)`)
    .bind(child, draft, `Хүүхэд ${id}`, createdAt, createdAt).run();
  database.prepare(`INSERT INTO registration_draft_waitlist_entry (id, registration_draft_child_id, class_session_id, status, is_test, test_run_id, created_at, updated_at) VALUES (?, ?, 'class', 'active', 1, 'waitlist-test', ?, ?)`)
    .bind(entry, child, createdAt, createdAt).run();
  return { draft, child, entry };
}

try {
  sqlite(readdirSync("migrations").filter((file) => /^\d{4}_.+\.sql$/.test(file)).sort().map((file) => readFileSync(path.join("migrations", file), "utf8")).join("\n"));
  const database = new D1(); const env = { APP_ENV: "staging", REGISTRATION_WRITE_ENABLED: "true", EMAIL_ENABLED: "false", AUTH_EMAIL_ENABLED: "false", STAFF_AUTH_EMAIL_ENABLED: "false", APP_ORIGIN: "https://staging.example.test", EMAIL_FROM: "test@example.test", DB: database };
  await database.prepare(`INSERT INTO academic_year (id, public_label, registration_status, is_current, is_test, test_run_id, created_at, updated_at) VALUES ('year', 'Тест', 'open', 1, 1, 'waitlist-test', ?, ?)` ).bind(now(), now()).run();
  await database.prepare(`INSERT INTO activity_offering (id, kind, title, academic_year_id, stage_code, use_academic_year_breaks, charge_mode, status, is_test, test_run_id, created_at, updated_at) VALUES ('offering', 'annual_course', 'Тест', 'year', 'stage_1', 1, 'paid', 'active', 1, 'waitlist-test', ?, ?)` ).bind(now(), now()).run();
  await database.prepare(`INSERT INTO class_session (id, academic_year_id, activity_offering_id, stage_code, display_label, weekday, start_time, end_time, capacity, status, is_test_only, is_test, test_run_id, created_at, updated_at) VALUES ('class', 'year', 'offering', 'stage_1', 'Тест анги', 'Бямба', '10:00', '11:20', 1, 'available', 1, 1, 'waitlist-test', ?, ?)` ).bind(now(), now()).run();
  await database.prepare(`INSERT INTO offering_course_pricing (activity_offering_id, one_time_amount_mnt, two_installment_enabled, created_at, updated_at) VALUES ('offering', 100000, 0, ?, ?)` ).bind(now(), now()).run();
  await database.prepare(`UPDATE payment_collection_settings SET bank_name = 'Банк', account_holder_name = 'Эзэн', account_number = '1', updated_at = ? WHERE singleton = 1`).bind(now()).run();
  const first = seed(database, "first", now()); const second = seed(database, "second", now(1));
  const { allocateWaitlistOffers, declineOrCloseWaitlistOffer, acceptWaitlistOffer, publicWaitlistOffer } = await import(pathToFileURL(bundle).href);
  const { getClassCapacityProjections } = await import(pathToFileURL(path.join(dir, "capacity.mjs")).href).catch(async () => { const p = path.join(dir, "capacity.mjs"); const r = spawnSync(esbuild, ["src/server/services/class-capacity.ts", "--bundle", "--format=esm", "--platform=node", `--outfile=${p}`], { encoding: "utf8" }); if (r.status !== 0) throw new Error(r.stderr); return import(pathToFileURL(p).href); });
  assert.equal((await getClassCapacityProjections(database, "staging", new Date(now())))[0].freeSeats, 1, "plain FIFO waitlist consumes no seat");
  const offers = await allocateWaitlistOffers(env, "class", new Date(now()));
  assert.equal(offers.length, 1); assert.equal(offers[0].offer.registrationDraftChildId, first.child);
  assert.equal((await getClassCapacityProjections(database, "staging", new Date(now())))[0].freeSeats, 0, "offer consumes one seat");
  assert.equal((await allocateWaitlistOffers(env, "class", new Date(now()))).length, 0, "allocator is idempotent");
  assert.equal((await publicWaitlistOffer(database, offers[0].token, new Date(now(2000)))).overdue, true, "overdue remains active");
  await declineOrCloseWaitlistOffer(env, offers[0].offer.id, "parent_link", null, null, new Date(now(2000)));
  const active = await database.prepare(`SELECT id FROM waitlist_seat_offer WHERE status = 'active'`).all(); assert.equal(active.results.length, 1, "decline advances one FIFO offer");
  const secondOffer = await database.prepare(`SELECT id FROM waitlist_seat_offer WHERE status = 'active'`).first();
  await acceptWaitlistOffer(env, secondOffer.id, "single", "parent_link", null, new Date(now(2001)));
  assert.equal((await acceptWaitlistOffer(env, secondOffer.id, "single", "parent_link", null, new Date(now(2002)))).idempotent, true, "accepted offer retry is idempotent");
  assert.equal(Number((await database.prepare(`SELECT COUNT(*) AS count FROM registration_capacity_hold WHERE registration_draft_child_id = ? AND status = 'active'`).bind(second.child).first()).count), 1);
  assert.equal(Number((await database.prepare(`SELECT COUNT(*) AS count FROM payment_installment WHERE registration_draft_child_id = ?`).bind(second.child).first()).count), 1);
  assert.equal((await getClassCapacityProjections(database, "staging", new Date(now(2001))))[0].freeSeats, 0, "offer to initial hold preserves capacity");
  console.log("ok waitlist offers: FIFO allocation, soft deadline, decline advance, and capacity-preserving conversion");
} finally { rmSync(dir, { recursive: true, force: true }); }
