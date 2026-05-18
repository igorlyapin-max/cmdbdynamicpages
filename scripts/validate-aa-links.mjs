import fs from 'node:fs';
import path from 'node:path';

const aaDir = path.resolve('aa');
const files = fs.readdirSync(aaDir)
  .filter((name) => name.endsWith('.md'))
  .map((name) => path.join(aaDir, name));

const errors = [];

for (const file of files) {
  const text = fs.readFileSync(file, 'utf8');
  const links = Array.from(text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)).map((match) => match[1]);
  for (const rawLink of links) {
    const link = rawLink.trim();
    if (!link || link.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(link)) continue;
    const target = link.split('#')[0];
    if (!target || !/\.(md|yaml|yml|json)$/i.test(target)) continue;
    const targetPath = path.resolve(path.dirname(file), target);
    if (!fs.existsSync(targetPath)) {
      errors.push(`${path.relative(process.cwd(), file)} has broken link: ${link}`);
    }
  }
}

if (errors.length) {
  for (const error of errors) {
    console.error(`ERR ${error}`);
  }
  process.exit(1);
}

console.log(`OK ${path.relative(process.cwd(), aaDir)} links checked in ${files.length} files`);
