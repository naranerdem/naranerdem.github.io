export const REGISTRATION_DRAFT_KEY = "naran-erdem-registration-draft-v1";
export const REGISTRATION_DRAFT_TTL_MS = 24 * 60 * 60 * 1000;

export function createRegistrationDraft(fields, childCount, now = Date.now()) {
  return {
    version: 1,
    savedAt: now,
    expiresAt: now + REGISTRATION_DRAFT_TTL_MS,
    childCount,
    fields,
  };
}

export function readRegistrationDraft(raw, now = Date.now()) {
  if (!raw) return null;
  try {
    const draft = JSON.parse(raw);
    if (
      draft?.version !== 1
      || !Number.isInteger(draft.childCount)
      || draft.childCount < 1
      || !Array.isArray(draft.fields)
      || typeof draft.expiresAt !== "number"
      || draft.expiresAt <= now
    ) return null;
    return draft;
  } catch {
    return null;
  }
}
