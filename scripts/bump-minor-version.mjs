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

function bumpVersion(version, type) {
  const parts = version.split(".").map(Number);
  if (type === "major") {
    parts[0] += 1;
    parts[1] = 0;
    parts[2] = 0;
  } else if (type === "minor") {
    parts[1] += 1;
    parts[2] = 0;
  } else {
    parts[2] += 1;
  }
  return parts.join(".");
}

async function main() {
  const packageJson = await readJson(packageJsonPath);
  const manifestJson = await readJson(manifestJsonPath);
  const versionsJson = await readJson(versionsJsonPath);

  const currentVersion = packageJson.version;
  const newVersion = bumpVersion(currentVersion, "minor");

  packageJson.version = newVersion;
  manifestJson.version = newVersion;
  const minAppVersion = manifestJson.minAppVersion ?? "1.5.0";
  versionsJson[newVersion] = minAppVersion;

  await writeFile(packageJsonPath, stringifyJson(packageJson), "utf8");
  await writeFile(manifestJsonPath, stringifyJson(manifestJson), "utf8");
  await writeFile(versionsJsonPath, stringifyJson(versionsJson), "utf8");

  console.log(`Bumped minor version from ${currentVersion} to ${newVersion}.`);
  console.log("Updated package.json, manifest.json, and versions.json.");
  console.log("Note: Patch version reset to 0 (semantic versioning).");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});