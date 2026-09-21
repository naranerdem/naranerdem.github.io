// Browser fixtures must never target a shared Cloudflare D1 database. Keep the
// guard beside the harnesses so an argument edit fails before fixture setup.
export function assertDisposableLocalWrangler(args, persistDir, label) {
  if (!Array.isArray(args) || args.includes("--remote") || !args.includes("--local")) {
    throw new Error(`${label} must use a disposable local Wrangler target; remote fixtures are prohibited.`);
  }
  const persistIndex = args.indexOf("--persist-to");
  if (persistIndex === -1 || args[persistIndex + 1] !== persistDir) {
    throw new Error(`${label} must use its own temporary --persist-to directory.`);
  }
}

export function failWithoutQuotaRetry(label, result) {
  const output = `${result?.stdout ?? ""}\n${result?.stderr ?? ""}`;
  if (/\b7403\b|daily row (?:read|write) limit|free tier.*limit|quota/i.test(output)) {
    throw new Error(`${label} stopped after a Cloudflare quota/access error; retries are intentionally disabled.\n${output}`);
  }
  throw new Error(`${label} failed\n${output}`);
}
