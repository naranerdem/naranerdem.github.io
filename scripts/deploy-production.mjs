import { spawnSync } from "node:child_process";

if (!process.argv.includes("--confirm-production")) {
  console.error("Refusing production deployment. Re-run with: npm run deploy:cloudflare -- --confirm-production");
  process.exitCode = 1;
} else {
  const command = process.platform === "win32" ? "npx.cmd" : "npx";
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const build = spawnSync(npm, ["run", "build"], { stdio: "inherit" });
  if (build.status === 0) {
    const deploy = spawnSync(command, ["wrangler", "deploy"], { stdio: "inherit" });
    process.exitCode = deploy.status ?? 1;
  } else {
    process.exitCode = build.status ?? 1;
  }
}
