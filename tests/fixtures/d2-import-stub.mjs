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
  const serverGroup = source.includes('servers:');
  const containerClass = source.includes('container-class');
  const markdownFrame = source.includes('markdown-frame');
  const reverseEdge = source.includes('switch -> router: reverse');
  const sameRoleEdges = source.includes('same-role-edges');
  const multipleRelationClasses = source.includes('multiple-relation-classes');
  process.stdout.write(JSON.stringify({
    version: 4,
    source: { parserVersion: 'test-stub', lossless: false },
    template: { title: 'Imported network' },
    elements: {
      nodes: markdownFrame ? [
        { key: 'markdown_node', pathSegments: ['markdown_node'], label: 'Markdown frame preview', kind: 'text', classKeys: ['external_system'], style: { fill: '#EFF6FF', stroke: '#1D4ED8', 'stroke-width': '2', 'stroke-dash': '7', 'border-radius': '8' } }
      ] : composite ? [
        { key: 'users.operator', pathSegments: ['users', 'operator'], label: 'Operator', parentKey: 'users', classKeys: ['workstation'], styleHints: { classes: ['workstation'] } },
        { key: 'users.administrator', pathSegments: ['users', 'administrator'], label: 'Administrator', parentKey: 'users', classKeys: ['workstation'], styleHints: { classes: ['workstation'] } }
      ] : serverGroup ? [
        { key: 'servers.first', pathSegments: ['servers', 'first'], label: 'Server A', parentKey: 'servers', classKeys: ['server'], styleHints: { classes: ['server'] } },
        { key: 'servers.second', pathSegments: ['servers', 'second'], label: 'Server B', parentKey: 'servers', classKeys: ['server'], styleHints: { classes: ['server'] } }
      ] : sameRoleEdges || multipleRelationClasses ? [
        { key: 'application_a', pathSegments: ['application_a'], label: 'Application A', kind: 'application', classKeys: ['application'] },
        { key: 'application_b', pathSegments: ['application_b'], label: 'Application B', kind: 'application', classKeys: ['application'] }
      ] : [
        { key: 'router', pathSegments: ['router'], label: 'Router', kind: 'router', classKeys: ['router'] },
        { key: 'switch', pathSegments: ['switch'], label: 'Switch', kind: 'switch', classKeys: ['switch'] }
      ],
      edges: composite || serverGroup || markdownFrame ? [] : multipleRelationClasses ? [
        { key: 'application_a_b_acl', sourceKey: 'application_a', targetKey: 'application_b', sourcePathSegments: ['application_a'], targetPathSegments: ['application_b'], label: 'TCP 443', direction: 'forward', classKeys: ['acl_intrasystem'] },
        { key: 'application_a_b_dependency', sourceKey: 'application_a', targetKey: 'application_b', sourcePathSegments: ['application_a'], targetPathSegments: ['application_b'], label: 'depends on', direction: 'forward', classKeys: ['application_dependency'] }
      ] : sameRoleEdges ? [
        { key: 'application_a_b_1', sourceKey: 'application_a', targetKey: 'application_b', sourcePathSegments: ['application_a'], targetPathSegments: ['application_b'], label: 'TCP 443', direction: 'forward', classKeys: ['acl_intrasystem'] },
        { key: 'application_a_b_2', sourceKey: 'application_a', targetKey: 'application_b', sourcePathSegments: ['application_a'], targetPathSegments: ['application_b'], label: 'UDP 443', direction: 'forward', classKeys: ['acl_intrasystem'] }
      ] : [
        { key: 'router_switch', sourceKey: 'router', targetKey: 'switch', sourcePathSegments: ['router'], targetPathSegments: ['switch'], label: 'uplink', direction: 'forward', classKeys: ['network_link'] },
        ...(reverseEdge ? [{ key: 'switch_router', sourceKey: 'switch', targetKey: 'router', sourcePathSegments: ['switch'], targetPathSegments: ['router'], label: 'reverse', direction: 'forward', classKeys: ['network_link'] }] : [])
      ],
      groups: composite ? [{
        key: 'users',
        pathSegments: ['users'],
        label: 'Users',
        childrenKeys: ['users.operator', 'users.administrator'],
        classKeys: containerClass ? ['application_group'] : [],
        suggestedRole: 'composite',
        semanticReason: 'leaf shapes',
        styleHints: { style: { fill: '#FAFAFA', 'stroke-dash': '4' } }
      }] : serverGroup ? [{
        key: 'servers',
        pathSegments: ['servers'],
        label: 'Servers',
        childrenKeys: ['servers.first', 'servers.second'],
        classKeys: [],
        suggestedRole: 'composite',
        semanticReason: 'leaf shapes',
        styleHints: { style: { fill: '#FAFAFA', 'stroke-dash': '4' } }
      }] : [],
      hierarchies: composite ? [
        { key: 'contains_operator', parentKey: 'users', childKey: 'users.operator', parentPathSegments: ['users'], childPathSegments: ['users', 'operator'], label: 'contains' },
        { key: 'contains_administrator', parentKey: 'users', childKey: 'users.administrator', parentPathSegments: ['users'], childPathSegments: ['users', 'administrator'], label: 'contains' }
      ] : serverGroup ? [
        { key: 'contains_first', parentKey: 'servers', childKey: 'servers.first', parentPathSegments: ['servers'], childPathSegments: ['servers', 'first'], label: 'contains' },
        { key: 'contains_second', parentKey: 'servers', childKey: 'servers.second', parentPathSegments: ['servers'], childPathSegments: ['servers', 'second'], label: 'contains' }
      ] : []
    },
    classes: markdownFrame ? [
      { key: 'external_system', definition: { style: { fill: '#EFF6FF', stroke: '#1D4ED8', 'stroke-width': '2', 'stroke-dash': '7', 'border-radius': '8' } }, usageCount: 1, sampleElementKeys: ['markdown_node'] }
    ] : composite ? (containerClass ? [
      { key: 'application_group', definition: { style: { fill: '#FFFFFF' } }, usageCount: 1, sampleElementKeys: ['users'] },
      { key: 'workstation', definition: { style: { fill: '#FFFFFF' } }, usageCount: 2, sampleElementKeys: ['users.operator', 'users.administrator'] }
    ] : [
      { key: 'workstation', definition: { style: { fill: '#FFFFFF' } }, usageCount: 2, sampleElementKeys: ['users.operator', 'users.administrator'] }
    ]) : serverGroup ? [
      { key: 'server', definition: { style: { fill: '#FFFFFF' } }, usageCount: 2, sampleElementKeys: ['servers.first', 'servers.second'] }
    ] : multipleRelationClasses ? [
      { key: 'application', notes: 'Dynamic Application objects.\nendpoint-field: Description\nendpoint-operator: equals', definition: {}, usageCount: 2, sampleElementKeys: ['application_a', 'application_b'] },
      { key: 'acl_intrasystem', notes: 'Dedicated ACL result for connections inside the target system.\nsource-operator: equals\ntarget-operator: equals', definition: { style: { stroke: '#D97706' } }, usageCount: 1, sampleElementKeys: ['application_a_b_acl'] },
      { key: 'application_dependency', notes: 'Dedicated dependency result for application links.', definition: { style: { stroke: '#2563EB' } }, usageCount: 1, sampleElementKeys: ['application_a_b_dependency'] }
    ] : sameRoleEdges ? [
      { key: 'application', notes: 'Dynamic Application objects.\nendpoint-field: Description\nendpoint-operator: equals', definition: {}, usageCount: 2, sampleElementKeys: ['application_a', 'application_b'] },
      { key: 'acl_intrasystem', notes: 'Dedicated ACL result for connections inside the target system.\nsource-operator: equals\ntarget-operator: equals', definition: { style: { stroke: '#D97706' } }, usageCount: 2, sampleElementKeys: ['application_a_b_1', 'application_a_b_2'] }
    ] : [
      { key: 'router', definition: {}, usageCount: 1, sampleElementKeys: ['router'] },
      { key: 'switch', definition: {}, usageCount: 1, sampleElementKeys: ['switch'] },
      { key: 'network_link', notes: 'Use one dedicated deterministic connection result.', definition: { style: { stroke: '#2563EB' } }, usageCount: reverseEdge ? 2 : 1, sampleElementKeys: reverseEdge ? ['router_switch', 'switch_router'] : ['router_switch'] }
    ],
    warnings: []
  }));
});
