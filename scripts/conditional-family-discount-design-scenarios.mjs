import assert from "node:assert/strict";

// Design-only executable specification. It models the proposed conditional
// family-discount contract; it neither imports Worker services nor mutates a
// repository database. "PROPOSED" assertions are intentionally not claims
// about the currently released financial behavior.

const rate = 1000;
const award = (totalMnt, basisPoints = rate) => Math.floor((totalMnt * basisPoints) / 10_000);

function agreement({ id, studentId, classId, plan = "one", installments, cash = 0, appliedEarnedCredit = 0,
  provisionalOwnAward = 0, contingentIncomingCredit = 0, earnedAward = 0, seat = "held", qualifier = "pending" }) {
  return { id, studentId, classId, plan, installments, cash, appliedEarnedCredit, provisionalOwnAward,
    contingentIncomingCredit, earnedAward, seat, qualifier };
}

function fundingRequirement(item) {
  // A two-installment candidate only needs its first cash installment. The
  // proposed family award is allocated to its second installment first.
  return item.plan === "two" ? item.installments[0] : item.installments.reduce((sum, amount) => sum + amount, 0) - item.provisionalOwnAward;
}

function funded(item) {
  return item.cash + item.appliedEarnedCredit + item.contingentIncomingCredit >= fundingRequirement(item);
}

function validQualifier(item) {
  return item.qualifier === "existing_valid" || (item.qualifier === "pending" && funded(item));
}

function qualifiesSubset(items) {
  if (items.length < 2 || !items.every(validQualifier)) return false;
  const occurrences = new Set(items.map((item) => `${item.studentId}:${item.classId}`));
  return occurrences.size >= 2;
}

function projection(item) {
  const rawTotalMnt = item.installments.reduce((sum, amount) => sum + amount, 0);
  const currentRequestedMnt = Math.max(0, rawTotalMnt - item.cash - item.appliedEarnedCredit - item.earnedAward
    - item.provisionalOwnAward - item.contingentIncomingCredit);
  const shortfallIfFailedMnt = Math.max(0, rawTotalMnt - item.cash - item.appliedEarnedCredit - item.earnedAward);
  return { rawTotalMnt, currentRequestedMnt, shortfallIfFailedMnt };
}

function claim(quotes, ids, worker) {
  const selected = ids.map((id) => quotes.get(id));
  if (selected.some((quote) => !quote || quote.status !== "quoted_pending" || quote.claim)) return null;
  for (const quote of selected) {
    quote.fence += 1;
    quote.claim = { worker, fence: quote.fence };
  }
  return selected.map((quote) => ({ id: quote.id, worker, fence: quote.fence }));
}

function completeClaim(quotes, leases) {
  const selected = leases.map((lease) => quotes.get(lease.id));
  if (selected.some((quote, index) => !quote || quote.status !== "quoted_pending" || quote.claim?.worker !== leases[index].worker
    || quote.claim?.fence !== leases[index].fence)) return false;
  for (const quote of selected) {
    quote.status = "qualified";
    quote.claim = null;
  }
  return true;
}

function idempotentOperation(store, id, fingerprint, apply) {
  const existing = store.get(id);
  if (existing) {
    assert.equal(existing.fingerprint, fingerprint, "PROPOSED: an operation id cannot be reused for another settlement payload");
    return existing.value;
  }
  const value = apply();
  store.set(id, { fingerprint, value });
  return value;
}

// PROPOSED: two pending one-payment agreements qualify together after their
// conditional cash is covered. Their 1,080,000 MNT cash receipts are real, but
// the 120,000 MNT awards are not earned until the protected set finalizes.
const jointA = agreement({ id: "joint-a", studentId: "a", classId: "class-a", installments: [1_200_000], cash: 1_080_000,
  provisionalOwnAward: 120_000 });
const jointB = agreement({ id: "joint-b", studentId: "b", classId: "class-b", installments: [1_200_000], cash: 1_080_000,
  provisionalOwnAward: 120_000 });
assert.equal(qualifiesSubset([jointA, jointB]), true, "PROPOSED: 1,080,000 + 1,080,000 can fund one protected two-agreement resolution");
assert.deepEqual([projection(jointA).currentRequestedMnt, projection(jointB).currentRequestedMnt], [0, 0]);

// PROPOSED: a confirmed seat alone is never qualification evidence. The same
// records qualify only if their funding predicate is met.
const approvedButUnfundedA = { ...jointA, cash: 500_000, seat: "conditionally_confirmed" };
const approvedButUnfundedB = { ...jointB, cash: 500_000, seat: "conditionally_confirmed" };
assert.equal(qualifiesSubset([approvedButUnfundedA, approvedButUnfundedB]), false,
  "PROPOSED: two teacher-approved seats do not qualify solely because they are confirmed");

// PROPOSED: sequential 1,200,000 + 960,000 is valid only with an explicit,
// contingent 120,000 MNT authorization from the first agreement's future
// award. The finalizer earns the source award, creates its root, and applies it
// to the second agreement in one protected operation.
const firstSequential = agreement({ id: "first", studentId: "first", classId: "class-first", installments: [1_200_000], cash: 1_200_000,
  qualifier: "existing_valid", seat: "confirmed" });
const secondSequential = agreement({ id: "second", studentId: "second", classId: "class-second", installments: [1_200_000], cash: 960_000,
  provisionalOwnAward: 120_000, contingentIncomingCredit: 120_000 });
assert.equal(qualifiesSubset([firstSequential, secondSequential]), true,
  "PROPOSED: sequential funding uses a specifically authorized contingent donor credit");
assert.equal(projection(secondSequential).currentRequestedMnt, 0);

// PROPOSED: a two-installment agreement needs only its actual first cash
// installment to join a resolution. The earned family award reduces the final
// installment, never the cash-only first installment.
const twoA = agreement({ id: "two-a", studentId: "two-a", classId: "class-two-a", plan: "two", installments: [650_000, 650_000], cash: 650_000,
  provisionalOwnAward: 130_000 });
const twoB = agreement({ id: "two-b", studentId: "two-b", classId: "class-two-b", plan: "two", installments: [650_000, 650_000], cash: 650_000,
  provisionalOwnAward: 130_000 });
assert.equal(qualifiesSubset([twoA, twoB]), true, "PROPOSED: required initial cash, not future annual cash, funds a two-installment qualifier");
assert.deepEqual([0, 130_000], [0, award(1_300_000)], "PROPOSED: 130,000 MNT is assigned to the final installment first");

// PROPOSED: a three-child submission may resolve only the funded A/B subset.
// C remains pending, unawarded, and available for a later resolution using A
// or B as an existing valid qualifier.
const quotes = new Map(["joint-a", "joint-b", "third"].map((id) => [id, { id, status: "quoted_pending", fence: 0, claim: null }]));
const abLease = claim(quotes, ["joint-a", "joint-b"], "worker-ab");
assert.ok(abLease);
assert.equal(claim(quotes, ["joint-b", "third"], "worker-bc"), null, "PROPOSED: overlapping subsets cannot both claim B");
assert.equal(completeClaim(quotes, abLease), true);
assert.equal(quotes.get("third").status, "quoted_pending", "PROPOSED: an unresolved sibling is not awarded prematurely");

// PROPOSED: stale finalizers cannot win after cancellation/reclaim.
const stale = new Map([["stale", { id: "stale", status: "quoted_pending", fence: 0, claim: null }]]);
const oldLease = claim(stale, ["stale"], "worker-a");
stale.get("stale").status = "cancelled";
stale.get("stale").claim = null;
assert.equal(completeClaim(stale, oldLease), false, "PROPOSED: cancelled quotes reject stale award activation");

// PROPOSED: credit is owned by the donor until a single payload-bound operation
// makes the debit and recipient application together. No intermediate credit is
// spendable by the recipient.
const operations = new Map();
const transferResult = idempotentOperation(operations, "op-1", "first|second|120000|installment-2", () => ({
  donorRootMnt: 120_000, donorDebitMnt: 120_000, recipientApplicationMnt: 120_000, recipientIntermediateAvailableMnt: 0,
}));
assert.equal(transferResult.recipientIntermediateAvailableMnt, 0);
assert.equal(idempotentOperation(operations, "op-1", "first|second|120000|installment-2", () => null).recipientApplicationMnt, 120_000,
  "PROPOSED: replay returns the original transfer/application result");
assert.throws(() => idempotentOperation(operations, "op-1", "first|other|120000|installment-2", () => null), /cannot be reused/);

// PROPOSED: if only one child survives, the conditional discount has not been
// earned. The receipt stays immutable and the 120,000 MNT difference becomes a
// staff-review shortfall rather than a fabricated payment or credit reversal.
const failedSingle = agreement({ id: "failed", studentId: "failed", classId: "class-failed", installments: [1_200_000], cash: 1_080_000 });
assert.equal(projection(failedSingle).shortfallIfFailedMnt, 120_000);

const assertionRows = [
  ["joint A before finalizer", jointA, 0, 120_000, 0, 0, 120_000, "held"],
  ["joint B before finalizer", jointB, 0, 120_000, 0, 0, 120_000, "held"],
  ["sequential source after finalizer", { ...firstSequential, earnedAward: 120_000 }, 120_000, 0, 120_000, 0, 0, "confirmed"],
  ["sequential target after finalizer", { ...secondSequential, earnedAward: 120_000, appliedEarnedCredit: 120_000, contingentIncomingCredit: 0 }, 120_000, 0, 0, 120_000, 0, "confirmed"],
  ["failed conditional child", failedSingle, 0, 0, 0, 0, 120_000, "conditional/review"],
].map(([step, item, earnedAwardMnt, provisionalAwardMnt, ownedCreditMnt, appliedCreditMnt, conditionalShortfallMnt, seat]) => ({
  step,
  cashMnt: item.cash,
  earnedAwardMnt,
  provisionalAwardMnt,
  ownedCreditMnt,
  appliedCreditMnt,
  currentRequestedMnt: projection(item).currentRequestedMnt,
  conditionalShortfallMnt,
  seat,
}));

console.table(assertionRows);
console.log("conditional-family-discount design scenarios passed (proposed behavior only)");
