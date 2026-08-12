export const stageLabel = (stage) => ({
  stage_1: "1-р шат",
  stage_2: "2-р шат",
  stage_3: "3-р шат",
})[stage] || stage;

export const escape = (value) => String(value ?? "").replace(/[&<>\"]/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;",
})[character]);

export function fillSelect(node, values, selected, label) {
  node.innerHTML = values.map((value) => {
    const id = value.id ?? value;
    return `<option value="${escape(id)}" ${String(id) === String(selected) ? "selected" : ""}>${escape(label(value))}</option>`;
  }).join("");
}

export function formatDate(date) {
  if (!date) return "";
  const value = new Date(`${date}T00:00:00Z`);
  return `${value.getUTCMonth() + 1}-р сарын ${value.getUTCDate()}`;
}

export async function getOverview() {
  const response = await fetch("/api/staff/program-calendar", {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error("өгөгдөл unavailable");
  return response.json();
}

export async function postOverviewAction(action, payload = {}) {
  const response = await fetch("/api/staff/program-calendar", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ action, ...payload }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.error?.message || "Хадгалж чадсангүй.");
  }
}

export async function hasSetupAccess() {
  const response = await fetch("/api/staff/session", { credentials: "same-origin" });
  if (!response.ok) return false;
  const session = await response.json();
  const capabilities = session.capabilities || [];
  return Boolean(session.authenticated && capabilities.includes("program.manage") && capabilities.includes("calendar.manage"));
}

export function currentYearId(data, selectedId) {
  const years = data.years || [];
  return years.some((year) => year.id === selectedId)
    ? selectedId
    : (years.find((year) => year.isCurrent)?.id || years[0]?.id || "");
}
