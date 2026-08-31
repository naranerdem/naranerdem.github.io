import { spawnSync } from "node:child_process";

if (!process.argv.includes("--confirm-production")) {
  console.error("Refusing production migration. Re-run with: npm run migrate:cloudflare -- --confirm-production");
  process.exitCode = 1;
} else {
  const command = process.platform === "win32" ? "npx.cmd" : "npx";
  const result = spawnSync(command, ["wrangler", "d1", "migrations", "apply", "DB", "--remote"], { stdio: "inherit" });
  process.exitCode = result.status ?? 1;
}
