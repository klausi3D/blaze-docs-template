import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

if (!existsSync(path.join(rootDir, "dist"))) {
  runCommand(process.execPath, [path.join(rootDir, "tools", "build.mjs")], "build");
}

runCommand(
  process.execPath,
  [
    path.join(rootDir, "node_modules", "eslint", "bin", "eslint.js"),
    "--max-warnings=0",
    "src/assets/**/*.js",
    "tools/**/*.mjs",
  ],
  "lint",
);
runCommand(process.execPath, [path.join(rootDir, "tools", "typecheck.mjs")], "typecheck");
runCommand(process.execPath, [path.join(rootDir, "tools", "broken-link-check.mjs")], "broken-link-check");

console.log("All tests passed.");

function runCommand(command, args, label) {
  console.log(`Running ${label}...`);
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}
