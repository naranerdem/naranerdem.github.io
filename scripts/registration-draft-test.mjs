import assert from "node:assert/strict";
import {
  REGISTRATION_DRAFT_TTL_MS,
  createRegistrationDraft,
  readRegistrationDraft,
} from "../public/scripts/registration-draft.js";

const now = 1_700_000_000_000;
const draft = createRegistrationDraft([["guardianName", "Туршилт"]], 1, now);

assert.equal(draft.expiresAt, now + REGISTRATION_DRAFT_TTL_MS);
assert.deepEqual(readRegistrationDraft(JSON.stringify(draft), now + 1), draft);
assert.equal(readRegistrationDraft(JSON.stringify(draft), draft.expiresAt), null);
assert.equal(readRegistrationDraft("not json", now), null);
assert.equal(readRegistrationDraft(JSON.stringify({ ...draft, childCount: 0 }), now), null);

console.log("ok registration draft expiry and validation tests");
