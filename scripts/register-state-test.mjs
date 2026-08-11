import assert from "node:assert/strict";
import {
  applyStageRecommendation,
  classSelectionIssue,
  initialStageSelection,
  stageFromSearch,
  userStageSelection,
} from "../public/scripts/registration-state.js";

assert.equal(stageFromSearch("?stage=2"), "stage_2");
assert.equal(stageFromSearch("?stage=4"), "");
assert.equal(stageFromSearch("?stage=stage_2"), "");

const urlSelection = initialStageSelection("?stage=2");
assert.deepEqual(urlSelection, { value: "stage_2", source: "url" });
assert.deepEqual(applyStageRecommendation(urlSelection, "stage_3"), urlSelection);

const recommended = applyStageRecommendation(initialStageSelection(""), "stage_3");
assert.deepEqual(recommended, { value: "stage_3", source: "recommendation" });

const manual = userStageSelection("stage_1");
assert.deepEqual(applyStageRecommendation(manual, "stage_3"), manual);
assert.deepEqual(applyStageRecommendation(manual, ""), manual);

const emptyCatalogIssue = classSelectionIssue({
  catalogState: "available",
  stage: "stage_1",
  sessions: [],
  selectedClassId: "",
});
assert.deepEqual(emptyCatalogIssue, { code: "no_sessions", focusTarget: "class-status" });
assert.notEqual(emptyCatalogIssue.focusTarget, "stage");

const openSession = { id: "class-open", availability: "available" };
assert.deepEqual(
  classSelectionIssue({ catalogState: "available", stage: "stage_1", sessions: [openSession], selectedClassId: "" }),
  { code: "class_required", focusTarget: "class-options" },
);
assert.equal(
  classSelectionIssue({ catalogState: "available", stage: "stage_1", sessions: [openSession], selectedClassId: "class-open" }),
  null,
);

assert.deepEqual(
  classSelectionIssue({
    catalogState: "available",
    stage: "stage_1",
    sessions: [{ id: "class-full", availability: "full" }],
    selectedClassId: "",
  }),
  { code: "no_available_class", focusTarget: "class-status" },
);

console.log("ok registration state and empty-catalog regression tests");
