function normalized(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLocaleLowerCase("mn");
}

/** Keep structured class details once while preserving distinct historic labels. */
export function formatClassDisplay(...parts: Array<string | null | undefined>): string {
  const result: string[] = [];
  for (const value of parts) {
    for (const piece of String(value || "").split(" · ").map((item) => item.trim()).filter(Boolean)) {
      const key = normalized(piece);
      if (result.some((existing) => {
        const existingKey = normalized(existing);
        return existingKey === key || existingKey.includes(key) || key.includes(existingKey);
      })) continue;
      result.push(piece);
    }
  }
  return result.join(" · ");
}
