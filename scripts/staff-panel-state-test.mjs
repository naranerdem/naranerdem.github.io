import assert from "node:assert/strict";
import { createPaymentDetailSelectionState, createStaffPanelState, selectAdditionalClassPlan, selectAdditionalClassTarget, supportedAdditionalClassPlans } from "../src/scripts/staff-panel-state.js";

const panels = createStaffPanelState();
const firstAdditional = panels.open("child-a", "additional");
const transfer = panels.open("child-a", "transfer");
const latestAdditional = panels.open("child-a", "additional");
assert.equal(panels.isCurrent(firstAdditional), false, "A -> B -> A rejects the first stale A response");
assert.equal(panels.isCurrent(transfer), false, "switching away rejects the stale B response");
assert.equal(panels.isCurrent(latestAdditional), true, "the latest A response owns the visible panel");

panels.close("child-a", "additional");
assert.equal(panels.isCurrent(latestAdditional), false, "closing while loading invalidates its request");
const reopened = panels.open("child-a", "additional");
assert.equal(panels.isCurrent(reopened), true, "reopening creates a usable new request instance");

panels.close("child-a");
assert.equal(panels.active("child-a"), "", "outer-record collapse clears the active subpanel");
const afterRefresh = panels.open("child-a", "info");
assert.equal(panels.isCurrent(reopened), false, "a refresh/reopen cannot revive an old panel response");
assert.equal(panels.isCurrent(afterRefresh), true, "the newest record/panel instance remains interactive");

const targetA = { id: "target-a", paymentOptions: [{ code: "single" }, { code: "two_installment", totalAmountMnt: 1100000 }] };
const targetB = { id: "target-b", paymentOptions: [{ code: "two_installment", totalAmountMnt: 1300000 }] };
const selectedA = selectAdditionalClassTarget({ targetClassSessionId: "old", paymentPlanCode: "single", proposeBaseDiscount: true }, [targetA, targetB], "target-a");
assert.deepEqual(selectedA, {
  targetClassSessionId: "target-a", paymentPlanCode: "", proposeBaseDiscount: true,
  policyUpdatedAt: "", proposedSourceAwardMnt: 0, proposedTargetAwardMnt: 0,
}, "a target with multiple authoritative plans requires an explicit choice and clears a stale proposal snapshot");
const selectedB = selectAdditionalClassTarget({ ...selectedA, preview: { stale: true }, createIdempotencyKey: "old-operation" }, [targetA, targetB], "target-b");
assert.equal(selectedB.targetClassSessionId, "target-b", "a subsequent target selection owns the new target");
assert.equal(selectedB.paymentPlanCode, "two_installment", "the new target receives its own supported plan rather than a stale selection");
assert.equal("preview" in selectedB, false, "changing target removes the prior preview from the new selection");
assert.equal("createIdempotencyKey" in selectedB, false, "changing target cannot reuse a prior admission operation");
assert.deepEqual(supportedAdditionalClassPlans(targetA).map((plan) => plan.code), ["single", "two_installment"], "each target exposes every authoritative supported agreement");
assert.equal(selectAdditionalClassPlan(selectedB, targetB, "single").paymentPlanCode, "", "an unsupported plan cannot survive a target/plan change");
assert.equal(selectAdditionalClassPlan(selectedB, targetB, "two_installment").paymentPlanCode, "two_installment", "the supported plan remains selectable");

const sourceItem = { registrationDraftChildId: "source-child", installmentId: "source-initial" };
const targetItem = { registrationDraftChildId: "target-child", installmentId: "target-initial" };
const details = createPaymentDetailSelectionState("source-child");
assert.equal(details.onRefresh([sourceItem, targetItem]), "source-initial", "the return URL opens its requested record only on the initial refresh");
details.select(targetItem.installmentId);
assert.equal(details.onRefresh([sourceItem, targetItem]), "target-initial", "a later refresh preserves the teacher's target selection when source and target share one child");
details.close(targetItem.installmentId);
assert.equal(details.onRefresh([sourceItem, targetItem]), "", "an explicit close remains respected by a later refresh");

console.log("ok staff panel race state");
