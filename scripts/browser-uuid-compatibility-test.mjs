import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { secureUuidV4, SecureIdError } from "../public/scripts/secure-id.js";

const modern = secureUuidV4({ randomUUID: () => "11111111-2222-4333-8444-555555555555" });
assert.equal(modern, "11111111-2222-4333-8444-555555555555", "modern browsers retain crypto.randomUUID");

let requested = false;
const legacy = secureUuidV4({ getRandomValues(bytes) { requested = true; bytes.set([...Array(16).keys()]); return bytes; } });
assert(requested, "older secure browsers use getRandomValues");
assert.match(legacy, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, "fallback is a canonical UUID v4 with the RFC variant");
assert.throws(() => secureUuidV4({}), SecureIdError, "missing secure randomness fails closed");

const helper = readFileSync("public/scripts/secure-id.js", "utf8");
const page = readFileSync("src/pages/register.astro", "utf8");
const intake = readFileSync("src/pages/staff/registration-intake.astro", "utf8");
assert.doesNotMatch(helper, /Math\.random|Date\.now|performance\.now/, "no predictable UUID fallback exists");
assert.match(page, /import \{ secureUuidV4 \} from "\/scripts\/secure-id\.js"/, "public registration uses the shared helper");
assert.match(intake, /import \{ secureUuidV4 \} from "\/scripts\/secure-id\.js"/, "the only other browser UUID call shares the helper");
assert.doesNotMatch(page, /crypto\.randomUUID\(/, "public registration has no direct randomUUID assumption");
assert.doesNotMatch(intake, /crypto\.randomUUID\(/, "staff intake has no direct randomUUID assumption");
assert.match(page, /if \(!submissionIdempotencyKey\) submissionIdempotencyKey = secureUuidV4\(\)/, "one logical submission keeps its idempotency key");
assert.match(page, /finishButton\.disabled = true;[\s\S]*?finishButton\.setAttribute\("aria-busy", "true"\)/, "submit synchronously enters its busy state");
assert.match(page, /if \(requestStarted\)[\s\S]*?window\.turnstile\?\.reset/, "an attempted request gets a fresh challenge while retaining the idempotency key");
assert.match(page, /Хүсэлтийн хариуг авч чадсангүй\. Бүртгэл үүссэн байж болзошгүй тул и-мэйлээ шалгана уу/, "an uncertain browser response uses noncommittal Mongolian recovery copy");
console.log("ok browser UUID compatibility and submission recovery");
