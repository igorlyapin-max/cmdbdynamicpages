#!/usr/bin/env node

let source = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { source += chunk; });
process.stdin.on('end', () => {
  if (source.includes('@')) {
    process.stderr.write('D2 imports are not allowed.\n');
    process.exitCode = 2;
    return;
  }
  const composite = source.includes('users:');
  const containerClass = source.includes('container-class');
  const markdownFrame = source.includes('markdown-frame');
  process.stdout.write(JSON.stringify({
    version: 3,
    source: { parserVersion: 'test-stub', lossless: false },
    template: { title: 'Imported network' },
    elements: {
      nodes: markdownFrame ? [
        { key: 'markdown_node', label: 'Markdown frame preview', kind: 'text', classKeys: ['external_system'], style: { fill: '#EFF6FF', stroke: '#1D4ED8', 'stroke-width': '2', 'stroke-dash': '7', 'border-radius': '8' } }
      ] : composite ? [
        { key: 'users.operator', label: 'Operator', parentKey: 'users', classKeys: ['workstation'], styleHints: { classes: ['workstation'] } },
        { key: 'users.administrator', label: 'Administrator', parentKey: 'users', classKeys: ['workstation'], styleHints: { classes: ['workstation'] } }
      ] : [
        { key: 'router', label: 'Router', kind: 'router', classKeys: ['router'] },
        { key: 'switch', label: 'Switch', kind: 'switch', classKeys: ['switch'] }
      ],
      edges: composite || markdownFrame ? [] : [{ key: 'router_switch', sourceKey: 'router', targetKey: 'switch', label: 'uplink', direction: 'forward' }],
      groups: composite ? [{
        key: 'users',
        label: 'Users',
        childrenKeys: ['users.operator', 'users.administrator'],
        classKeys: containerClass ? ['application_group'] : [],
        suggestedRole: 'composite',
        semanticReason: 'leaf shapes',
        styleHints: { style: { fill: '#FAFAFA', 'stroke-dash': '4' } }
      }] : [],
      hierarchies: composite ? [
        { key: 'contains_operator', parentKey: 'users', childKey: 'users.operator', label: 'contains' },
        { key: 'contains_administrator', parentKey: 'users', childKey: 'users.administrator', label: 'contains' }
      ] : []
    },
    classes: markdownFrame ? [
      { key: 'external_system', definition: { style: { fill: '#EFF6FF', stroke: '#1D4ED8', 'stroke-width': '2', 'stroke-dash': '7', 'border-radius': '8' } }, usageCount: 1, sampleElementKeys: ['markdown_node'] }
    ] : composite ? (containerClass ? [
      { key: 'application_group', definition: { style: { fill: '#FFFFFF' } }, usageCount: 1, sampleElementKeys: ['users'] },
      { key: 'workstation', definition: { style: { fill: '#FFFFFF' } }, usageCount: 2, sampleElementKeys: ['users.operator', 'users.administrator'] }
    ] : [
      { key: 'workstation', definition: { style: { fill: '#FFFFFF' } }, usageCount: 2, sampleElementKeys: ['users.operator', 'users.administrator'] }
    ]) : [
      { key: 'router', definition: {}, usageCount: 1, sampleElementKeys: ['router'] },
      { key: 'switch', definition: {}, usageCount: 1, sampleElementKeys: ['switch'] }
    ],
    warnings: []
  }));
});
