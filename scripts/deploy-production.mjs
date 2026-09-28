import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const REQUIRED_PUBLIC_RATE_LIMIT_BINDINGS = [
  "PUBLIC_REGISTRATION_NORMAL_RATE_LIMITER",
  "PUBLIC_REGISTRATION_HEIGHTENED_RATE_LIMITER",
  "PUBLIC_DYNAMIC_NORMAL_RATE_LIMITER",
  "PUBLIC_DYNAMIC_HEIGHTENED_RATE_LIMITER",
  "PUBLIC_MESSAGE_NORMAL_RATE_LIMITER",
  "PUBLIC_MESSAGE_HEIGHTENED_RATE_LIMITER",
];

function assertPublicRateLimitBindings() {
  let config;
  try {
    config = JSON.parse(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
  } catch (error) {
    throw new Error(`Unable to read the production Wrangler configuration: ${error instanceof Error ? error.message : "unknown error"}`);
  }
  const configured = new Set((config.ratelimits ?? []).map((binding) => binding?.name));
  const missing = REQUIRED_PUBLIC_RATE_LIMIT_BINDINGS.filter((name) => !configured.has(name));
  if (missing.length) throw new Error(`Refusing production deployment: missing public rate-limit binding(s): ${missing.join(", ")}.`);
}

if (!process.argv.includes("--confirm-production")) {
  console.error("Refusing production deployment. Re-run with: npm run deploy:cloudflare -- --confirm-production");
  process.exitCode = 1;
} else {
  try {
    assertPublicRateLimitBindings();
    const command = process.platform === "win32" ? "npx.cmd" : "npx";
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    const build = spawnSync(npm, ["run", "build"], { stdio: "inherit" });
    if (build.status === 0) {
      const deploy = spawnSync(command, ["wrangler", "deploy"], { stdio: "inherit" });
      process.exitCode = deploy.status ?? 1;
    } else {
      process.exitCode = build.status ?? 1;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Refusing production deployment due to an invalid rate-limit configuration.");
    process.exitCode = 1;
  }
}
