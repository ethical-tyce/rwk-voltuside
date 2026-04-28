const fs = require("fs");
const path = require("path");

const distDir = path.join(__dirname, "..", "dist");
const token = String.fromCharCode(97, 100, 101, 110, 108);
const target = new RegExp(token, "gi");
const textExtensions = new Set([
  ".txt",
  ".md",
  ".json",
  ".js",
  ".cjs",
  ".mjs",
  ".html",
  ".css",
  ".yml",
  ".yaml",
  ".xml",
  ".nsi",
  ".nsh",
  ".ini",
  ".log"
]);

let deletedFiles = 0;
let changedFiles = 0;
let replacedMatches = 0;

function walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath);
      continue;
    }

    if (entry.name.toLowerCase() === "builder-debug.yml") {
      fs.unlinkSync(fullPath);
      deletedFiles += 1;
      continue;
    }

    const ext = path.extname(entry.name).toLowerCase();
    if (!textExtensions.has(ext)) continue;

    const content = fs.readFileSync(fullPath, "utf8");
    const matches = content.match(target);
    if (!matches) continue;

    const scrubbed = content.replace(target, "redacted");
    fs.writeFileSync(fullPath, scrubbed, "utf8");
    changedFiles += 1;
    replacedMatches += matches.length;
  }
}

if (!fs.existsSync(distDir)) {
  console.log("sanitize-dist: dist directory not found, skipped.");
  process.exit(0);
}

walk(distDir);
console.log(
  `sanitize-dist: deleted ${deletedFiles} file(s), updated ${changedFiles} file(s), replaced ${replacedMatches} match(es).`
);
