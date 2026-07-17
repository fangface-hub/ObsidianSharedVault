#!/usr/bin/env node

import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, "..");

const manifest = JSON.parse(fs.readFileSync(path.join(rootDir, "manifest.json"), "utf-8"));
const version = manifest.version;

let previousTag = null;
try {
  const tags = execSync("git tag --sort=-v:refname", { cwd: rootDir, encoding: "utf-8" })
    .trim()
    .split("\n")
    .filter((tag) => tag);

  if (tags.length > 0) {
    const currentTagIndex = tags.findIndex((tag) => tag === version);
    if (currentTagIndex >= 0 && currentTagIndex < tags.length - 1) {
      previousTag = tags[currentTagIndex + 1];
    } else if (tags.length > 0 && tags[0] !== version) {
      previousTag = tags[0];
    }
  }
} catch {
  previousTag = null;
}

let commits = [];
try {
  let command = "git log --oneline --no-decorate";

  if (previousTag) {
    command += ` ${previousTag}..HEAD`;
  }

  const output = execSync(command, { cwd: rootDir, encoding: "utf-8" })
    .trim()
    .split("\n")
    .filter((line) => line);

  commits = output.map((line) => {
    const match = line.match(/^[a-f0-9]+ (.+)$/);
    return match ? match[1] : line;
  });
} catch {
  commits = [];
}

const categories = {
  Added: [],
  Fixed: [],
  Changed: [],
  Removed: [],
  Other: []
};

commits.forEach((commit) => {
  const msg = commit.toLowerCase();
  if (msg.includes("add") || msg.includes("new") || msg.includes("feature")) {
    categories.Added.push(commit);
  } else if (msg.includes("fix") || msg.includes("bug")) {
    categories.Fixed.push(commit);
  } else if (msg.includes("chang") || msg.includes("update") || msg.includes("modify")) {
    categories.Changed.push(commit);
  } else if (msg.includes("remov") || msg.includes("delete")) {
    categories.Removed.push(commit);
  } else {
    categories.Other.push(commit);
  }
});

const date = new Date().toISOString().split("T")[0];
let releaseNotes = `## Version ${version} - ${date}\n\n`;

let hasSections = false;
for (const [category, items] of Object.entries(categories)) {
  if (items.length > 0) {
    hasSections = true;
    releaseNotes += `### ${category}\n\n`;
    items.forEach((item) => {
      const capitalizedItem = item.charAt(0).toUpperCase() + item.slice(1);
      releaseNotes += `- ${capitalizedItem}\n`;
    });
    releaseNotes += "\n";
  }
}

if (!hasSections && commits.length > 0) {
  releaseNotes += "### Changes\n\n";
  commits.forEach((item) => {
    const capitalizedItem = item.charAt(0).toUpperCase() + item.slice(1);
    releaseNotes += `- ${capitalizedItem}\n`;
  });
  releaseNotes += "\n";
}

if (commits.length === 0) {
  releaseNotes += "### Release\n\n- Version bump and release artifacts\n\n";
}

releaseNotes += "### Verification\n\nThis release includes artifact attestations for provenance verification. Learn more about [artifact attestations](https://docs.github.com/en/actions/security-for-github-actions/using-artifact-attestations/).\n";

console.log(releaseNotes);
process.exit(0);