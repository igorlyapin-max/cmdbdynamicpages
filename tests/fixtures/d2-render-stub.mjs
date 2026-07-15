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
  if (source.includes('markdown-frame')) {
    process.stdout.write('<svg data-d2-version="v0.7.1"><g class="bWFya2Rvd25fbm9kZQ== external_system"><g class="shape"></g><g><foreignObject x="20" y="30" width="180" height="64"><div xmlns="http://www.w3.org/1999/xhtml" class="md">Markdown frame preview</div></foreignObject></g></g></svg>');
    return;
  }
  process.stdout.write('<svg data-d2-version="v0.7.1" onclick="alert(1)"><script>alert(1)</script><style>.group_external { fill:#9FF6FF; stroke:#f503EB; } @import url(https://evil.local/a.css)</style><style>.md { font-family: safe; }</style><g class="group_external"><rect fill="#9FF6FF" stroke="#f503EB" /></g><foreignObject x="40" y="50" width="245" height="24" onclick="alert(1)"><div xmlns="http://www.w3.org/1999/xhtml" class="md" onclick="alert(1)"><p><strong>ИС LPS</strong> <code>192.168.5.0/24</code><img src="https://evil.local/a.png"></p></div></foreignObject><text>D2 import preview</text></svg>');
});
