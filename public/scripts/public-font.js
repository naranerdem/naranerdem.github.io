export function applyPublicFont(font) {
  document.documentElement.dataset.publicFont = font === "serif" ? "serif" : "sans";
}

export async function loadPublicFont() {
  try {
    const response = await fetch("/api/public-site", { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error("Public site settings are unavailable.");
    applyPublicFont((await response.json()).publicSiteFont);
  } catch {
    applyPublicFont("sans");
  }
}
