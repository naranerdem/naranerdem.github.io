export function escapePublicText(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[character] ?? character);
}

export function renderPublicProse(value: string | null | undefined): string {
  if (!value) return "";
  return value.replace(/\r\n?/g, "\n").split("\n").map((line) => line.trimEnd()).filter(Boolean).map((line) =>
    line.startsWith("## ") ? `<h2>${escapePublicText(line.slice(3))}</h2>`
      : line.startsWith("# ") ? `<h3>${escapePublicText(line.slice(2))}</h3>`
        : `<p>${escapePublicText(line)}</p>`,
  ).join("");
}
