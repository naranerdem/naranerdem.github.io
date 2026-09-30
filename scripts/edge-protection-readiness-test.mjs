import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const config = JSON.parse(readFileSync("wrangler.jsonc", "utf8"));
const registration = readFileSync("src/pages/register.astro", "utf8");
const router = readFileSync("src/server/api/router.ts", "utf8");
const guide = readFileSync("docs/edge-protection.md", "utf8");

assert.equal(config.workers_dev, false, "production disables the stable workers.dev endpoint through source-controlled deployment configuration");
assert.equal(config.preview_urls, false, "production explicitly declines future preview URLs");
assert.equal(config.env.staging.workers_dev, true, "staging keeps its isolated workers.dev test origin");
assert.match(registration, /const result = await response\.json\(\)\.catch\(\(\) => null\);/, "a non-JSON edge block does not throw before the submission error branch");
assert.match(registration, /const edgeRateLimited = response\.status === 429 && !result\?\.error;/, "an edge 429 receives a clear retry message without clearing the draft");
assert.match(registration, /Таны оруулсан мэдээлэл хэвээр хадгалагдана\./, "the form explicitly says that an edge block preserves entered data");
assert.match(registration, /if \(!submissionIdempotencyKey\) submissionIdempotencyKey = secureUuidV4\(\)/, "retries retain one idempotency key");
assert.match(router, /replayRegistrationAfterProtectionRejection[\s\S]*?replayRegistrationDraftByIdempotencyKey[\s\S]*?emailSent: false/, "a committed registration can be replayed without a duplicate message when protection rejects the retry");
assert.match(guide, /20 requests[\s\S]*?10 seconds[\s\S]*?Block[\s\S]*?10 seconds/, "the activation guide records the exact Free-plan rule parameters");
assert.match(guide, /\/api\/staff\/\*/, "the guide explicitly excludes staff APIs");
assert.match(guide, /workers_dev[\s\S]*?preview_urls/, "the guide explains the alternate production URL controls");

console.log("ok edge protection readiness");
