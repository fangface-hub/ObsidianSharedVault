import { execSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

const packageJsonPath = path.join(rootDir, "package.json");
const manifestJsonPath = path.join(rootDir, "manifest.json");
const versionsJsonPath = path.join(rootDir, "versions.json");

function stringifyJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function readJson(filePath) {
  const raw = await readFile(filePath, "utf8");
  return JSON.parse(raw);
}

async function main() {
  execSync("npm version patch --no-git-tag-version", {
    cwd: rootDir,
    stdio: "inherit"
  });

  const packageJson = await readJson(packageJsonPath);
  const manifestJson = await readJson(manifestJsonPath);
  const versionsJson = await readJson(versionsJsonPath);

  const newVersion = packageJson.version;
  if (!newVersion) {
    throw new Error("Failed to read the new version from package.json.");
  }

  manifestJson.version = newVersion;
  const minAppVersion = manifestJson.minAppVersion ?? "1.5.0";
  versionsJson[newVersion] = minAppVersion;

  await writeFile(manifestJsonPath, stringifyJson(manifestJson), "utf8");
  await writeFile(versionsJsonPath, stringifyJson(versionsJson), "utf8");

  console.log(`Bumped patch version to ${newVersion}.`);
  console.log("Updated package.json, package-lock.json, manifest.json, and versions.json.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});