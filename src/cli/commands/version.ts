import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface PackageJson {
  version: string;
}

export function runVersion(): void {
  const pkgPath = resolve(__dirname, "..", "..", "..", "package.json");
  const pkg: PackageJson = JSON.parse(readFileSync(pkgPath, "utf-8"));

  const nodeVersion = process.version;
  let pythonVersion = "(not found)";
  let claudeVersion = "(not found)";
  try {
    pythonVersion = execSync("python3 --version", {
      encoding: "utf-8",
      timeout: 3000,
    }).trim();
  } catch {
    // python3 not on PATH — leave as "(not found)"
  }
  try {
    claudeVersion = execSync("claude --version", {
      encoding: "utf-8",
      timeout: 5000,
    }).trim();
  } catch {
    // claude not on PATH — leave as "(not found)"
  }

  console.log(`claude-pmax-harness v${pkg.version}`);
  console.log(`  node:   ${nodeVersion}`);
  console.log(`  python: ${pythonVersion}`);
  console.log(`  claude: ${claudeVersion}`);
}
