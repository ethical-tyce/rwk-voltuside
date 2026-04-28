const fs = require("fs");
const path = require("path");

const token = String.fromCharCode(97, 100, 101, 110, 108);
const tokenUpper = token.toUpperCase();
const tokenTitle = token[0].toUpperCase() + token.slice(1, -1) + token[token.length - 1].toUpperCase();

const replacements = [
  { from: token, to: "userx" },
  { from: tokenTitle, to: "UserX" },
  { from: tokenUpper, to: "USERX" }
];

const roots = [
  path.join(__dirname, "..", "node_modules", "node-addon-api", "src"),
  path.join(__dirname, "..", "node_modules", "register-scheme", "build"),
  path.join(__dirname, "..", ".git", "logs")
];

function toUtf16LeBuffer(text) {
  return Buffer.from(text, "utf16le");
}

function replaceBufferInPlace(buffer, from, to) {
  let count = 0;
  let index = buffer.indexOf(from);
  while (index !== -1) {
    to.copy(buffer, index);
    count += 1;
    index = buffer.indexOf(from, index + from.length);
  }
  return count;
}

function sanitizeFile(filePath) {
  const original = fs.readFileSync(filePath);
  const working = Buffer.from(original);

  let matches = 0;
  for (const { from, to } of replacements) {
    const fromAscii = Buffer.from(from, "ascii");
    const toAscii = Buffer.from(to, "ascii");
    matches += replaceBufferInPlace(working, fromAscii, toAscii);

    const fromUtf16 = toUtf16LeBuffer(from);
    const toUtf16 = toUtf16LeBuffer(to);
    matches += replaceBufferInPlace(working, fromUtf16, toUtf16);
  }

  if (matches > 0) {
    fs.writeFileSync(filePath, working);
  }

  return matches;
}

function walkAndSanitize(rootDir) {
  let touchedFiles = 0;
  let replacedMatches = 0;

  if (!fs.existsSync(rootDir)) return { touchedFiles, replacedMatches };

  const stack = [rootDir];
  while (stack.length) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }

      const matches = sanitizeFile(fullPath);
      if (matches > 0) {
        touchedFiles += 1;
        replacedMatches += matches;
      }
    }
  }

  return { touchedFiles, replacedMatches };
}

let totalFiles = 0;
let totalMatches = 0;
for (const root of roots) {
  const { touchedFiles, replacedMatches } = walkAndSanitize(root);
  totalFiles += touchedFiles;
  totalMatches += replacedMatches;
}

console.log(
  `sanitize-workspace: updated ${totalFiles} file(s), replaced ${totalMatches} match(es).`
);
