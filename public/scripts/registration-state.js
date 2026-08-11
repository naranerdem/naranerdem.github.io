export const stageCodes = new Set(["stage_1", "stage_2", "stage_3"]);

export function stageFromSearch(search) {
  const value = new URLSearchParams(search).get("stage");
  return value && /^[123]$/.test(value) ? `stage_${value}` : "";
}

export function initialStageSelection(search) {
  const value = stageFromSearch(search);
  return { value, source: value ? "url" : "none" };
}

export function userStageSelection(value) {
  return { value: stageCodes.has(value) ? value : "", source: "user" };
}

export function applyStageRecommendation(selection, recommendation) {
  if (selection.source === "user" || selection.source === "url") return selection;
  if (stageCodes.has(recommendation)) return { value: recommendation, source: "recommendation" };
  if (selection.source === "recommendation") return { value: "", source: "none" };
  return selection;
}

export function classSelectionIssue({ catalogState, stage, sessions, selectedClassId }) {
  if (catalogState === "loading") return { code: "catalog_loading", focusTarget: "class-status" };
  if (catalogState !== "available") return { code: "catalog_unavailable", focusTarget: "class-status" };
  if (!stageCodes.has(stage)) return { code: "stage_required", focusTarget: "stage" };
  if (sessions.length === 0) return { code: "no_sessions", focusTarget: "class-status" };

  const availableSessions = sessions.filter((session) => session.availability === "available");
  if (availableSessions.length === 0) return { code: "no_available_class", focusTarget: "class-status" };
  if (!availableSessions.some((session) => session.id === selectedClassId)) {
    return { code: "class_required", focusTarget: "class-options" };
  }

  return null;
}
