import fs from 'node:fs';
import path from 'node:path';

const maxTextFileBytes = 2 * 1024 * 1024;
const excludedDirectories = new Set(['.git', '.omk', '.kimi', '.agents', '.codex', 'dist', 'node_modules']);
const patterns = [
  { id: 'private-key', regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { id: 'aws-access-key', regex: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/ },
  { id: 'github-token', regex: /\bgh[pousr]_[A-Za-z0-9_]{36,}\b/ },
  { id: 'gitlab-token', regex: /\bglpat-[A-Za-z0-9_-]{20,}\b/ },
  { id: 'slack-token', regex: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/ },
  { id: 'jwt', regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  {
    id: 'high-entropy-secret-assignment',
    regex: /\b(?:password|passwd|pwd|secret|token|api[_-]?key|authorization)\b[^\n:=]{0,40}[:=]\s*['"]?([A-Za-z0-9+/=_-]{32,})['"]?/i
  }
];

const scanRoot = fs.realpathSync('.');

function pathIsInsideScanRoot(filePath) {
  const relativePath = path.relative(scanRoot, filePath);
  return Boolean(relativePath) && !relativePath.startsWith(`..${path.sep}`) && relativePath !== '..' && !path.isAbsolute(relativePath);
}

function scanFiles(dir = scanRoot) {
  const result = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  entries
    .sort((left, right) => left.name.localeCompare(right.name))
    .forEach((entry) => {
      const filePath = path.join(dir, entry.name);
      if (!pathIsInsideScanRoot(filePath) || entry.isSymbolicLink()) return;
      if (entry.isDirectory()) {
        if (!excludedDirectories.has(entry.name)) {
          result.push(...scanFiles(filePath));
        }
        return;
      }
      if (entry.isFile()) result.push(filePath);
    });
  return result;
}

function isText(buffer) {
  if (buffer.length > maxTextFileBytes) return false;
  return !buffer.includes(0);
}

const findings = [];

for (const file of scanFiles()) {
  const buffer = fs.readFileSync(file);
  if (!isText(buffer)) continue;
  const lines = buffer.toString('utf8').split(/\r?\n/);
  lines.forEach((line, index) => {
    patterns.forEach((pattern) => {
      if (pattern.regex.test(line)) {
        findings.push({
          file: path.relative(scanRoot, file),
          line: index + 1,
          type: pattern.id
        });
      }
    });
  });
}

if (findings.length) {
  console.error('High-confidence secret scan findings:');
  findings.forEach((finding) => {
    console.error(`${finding.file}:${finding.line} ${finding.type}`);
  });
  process.exit(1);
}

console.log('No high-confidence secrets found in scanned repository files.');
