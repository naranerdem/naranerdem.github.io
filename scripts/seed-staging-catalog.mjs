import { spawnSync } from "node:child_process";

const command = process.platform === "win32" ? "npx.cmd" : "npx";
const result = spawnSync(
  command,
  [
    "wrangler",
    "d1",
    "execute",
    "DB",
    "--env",
    "staging",
    "--remote",
    "--file",
    "scripts/staging-catalog-fixtures.sql",
  ],
  { encoding: "utf8", stdio: "inherit" },
);

process.exit(result.status ?? 1);
