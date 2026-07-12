#!/usr/bin/env node

let source = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { source += chunk; });
process.stdin.on('end', () => {
  if (!source.trim()) {
    process.stderr.write('D2 source is empty.\n');
    process.exitCode = 2;
    return;
  }
  process.stdout.write('<svg onclick="alert(1)"><script>alert(1)</script><foreignObject><div>blocked</div></foreignObject><text>D2 import preview</text></svg>');
});
