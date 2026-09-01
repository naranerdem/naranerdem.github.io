import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

function config() {
  return JSON.parse(readFileSync(path.resolve("wrangler.jsonc"), "utf8"));
}

export function d1Target(environment) {
  if (!environment || !["staging", "production"].includes(environment)) throw new Error("Use --env=staging or --env=production.");
  const wrangler = config();
  const databases = environment === "staging" ? wrangler.env?.staging?.d1_databases : wrangler.d1_databases;
  const database = databases?.find((entry) => entry.binding === "DB");
  if (!database?.database_name || !database?.database_id) throw new Error(`D1 DB binding is not configured for ${environment}.`);
  return { environment, name: database.database_name, id: database.database_id };
}

function wranglerArgs(environment, suffix) {
  const args = ["wrangler", "d1", "execute", "DB", "--remote", ...suffix];
  if (environment === "staging") args.push("--env", "staging");
  return args;
}

export function queryRemoteD1(environment, sql) {
  d1Target(environment);
  const command = process.platform === "win32" ? "npx.cmd" : "npx";
  const result = spawnSync(command, wranglerArgs(environment, ["--json", "--command", sql]), {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`Could not read ${environment} private Program configuration.`);
  let parsed;
  try { parsed = JSON.parse(result.stdout); } catch { throw new Error(`Could not parse the ${environment} D1 response.`); }
  if (!Array.isArray(parsed) || parsed.some((entry) => entry.success !== true || !Array.isArray(entry.results))) throw new Error(`The ${environment} D1 query did not succeed.`);
  return parsed.flatMap((entry) => entry.results);
}

export function executeRemoteD1File(environment, file) {
  d1Target(environment);
  const command = process.platform === "win32" ? "npx.cmd" : "npx";
  const result = spawnSync(command, wranglerArgs(environment, ["--file", file, "--yes"]), {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const output = `${result.stderr || ""}\n${result.stdout || ""}`.trim().replaceAll(/\s+/g, " ");
    const diagnostic = output.length > 1000 ? `${output.slice(0, 500)} … ${output.slice(-500)}` : output;
    throw new Error(`The ${environment} private configuration import failed atomically${diagnostic ? `: ${diagnostic}` : "."}`);
  }
}

export function parseOptions(args, allowedFlags = []) {
  const options = {};
  for (const arg of args) {
    if (arg.startsWith("--env=")) options.environment = arg.slice("--env=".length);
    else if (arg.startsWith("--file=")) options.file = arg.slice("--file=".length);
    else if (arg.startsWith("--output=")) options.output = arg.slice("--output=".length);
    else if (allowedFlags.includes(arg)) options[arg.slice(2).replaceAll("-", "_")] = true;
    else throw new Error(`Unsupported option ${arg}.`);
  }
  d1Target(options.environment);
  return options;
}
