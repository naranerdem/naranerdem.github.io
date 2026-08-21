export const PUBLIC_FONT_STORAGE_KEY = "naranerdem.public-font";

export function normalizePublicFont(font) {
  return font === "serif" || font === "sans" ? font : null;
}

export function applyPublicFont(font, cache = true) {
  const value = normalizePublicFont(font) || "sans";
  document.documentElement.dataset.publicFont = value;
  if (cache) {
    try { localStorage.setItem(PUBLIC_FONT_STORAGE_KEY, value); } catch {}
  }
}

export async function loadPublicFont() {
  try {
    const response = await fetch("/api/public-site", { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error("Public site settings are unavailable.");
    applyPublicFont((await response.json()).publicSiteFont);
  } catch {
    if (!normalizePublicFont(document.documentElement.dataset.publicFont)) applyPublicFont("sans", false);
  }
}
