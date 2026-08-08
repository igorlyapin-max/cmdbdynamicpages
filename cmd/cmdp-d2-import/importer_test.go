package main

import (
	"bytes"
	"encoding/json"
	"io"
	"strings"
	"testing"
)

func TestImportD2NormalizesGraph(t *testing.T) {
	input := []byte(`cluster: {
  label: Cluster
  alpha: {
    label: Alpha
    shape: circle
    link: "/cmdbuild/ui/#alpha"
  }
  beta: Beta
}
cluster.alpha -> cluster.beta: connects
`)

	result := importD2(input, 20)

	if len(result.Source.Errors) != 0 {
		t.Fatalf("unexpected source errors: %#v", result.Source.Errors)
	}
	if result.Version != 4 || result.Source.Format != "d2" || result.Source.SHA256 == "" {
		t.Fatalf("unexpected source contract: %#v", result.Source)
	}
	if got := len(result.Elements.Nodes); got != 2 {
		t.Fatalf("nodes = %d, want 2", got)
	}
	if got := len(result.Elements.Groups); got != 1 {
		t.Fatalf("groups = %d, want 1", got)
	}
	if got := len(result.Elements.Edges); got != 1 {
		t.Fatalf("edges = %d, want 1", got)
	}
	if got := len(result.Elements.Hierarchies); got != 2 {
		t.Fatalf("hierarchies = %d, want 2", got)
	}
	for _, hierarchy := range result.Elements.Hierarchies {
		if hierarchy.ID == "" {
			t.Fatalf("hierarchy id is empty: %#v", hierarchy)
		}
	}
	if result.Elements.Edges[0].Direction != "->" {
		t.Fatalf("edge direction = %q, want ->", result.Elements.Edges[0].Direction)
	}
	if result.Elements.Nodes[0].Parent != "cluster" {
		t.Fatalf("node parent = %q, want cluster", result.Elements.Nodes[0].Parent)
	}
	if result.Elements.Groups[0].SuggestedRole != "composite" || result.Elements.Groups[0].SelectedRole != "" {
		t.Fatalf("unexpected group semantics: %#v", result.Elements.Groups[0])
	}
	if len(result.Template.NodeMappings) != 1 || result.Template.NodeMappings[0].From != "nodes" {
		t.Fatalf("unexpected node template hints: %#v", result.Template.NodeMappings)
	}
	if len(result.Template.HierarchyMappings) != 1 || result.Template.HierarchyMappings[0].From != "hierarchies" {
		t.Fatalf("unexpected hierarchy template hints: %#v", result.Template.HierarchyMappings)
	}
}

func TestImportD2ExtractsUsedClassesAndKeepsStructuralGroupsUntyped(t *testing.T) {
	input := []byte(`classes: {
  vlan: {
    style: {
      fill: "#F5F7FA"
      stroke: "#607D8B"
      stroke-width: 2
      border-radius: 12
    }
  }
	  unused: {
	    shape: cloud
	  }
	}
dmz: "DMZ" {
  vlan1540: "VLAN-1540\n192.168.10.152/29" {
    class: vlan
    gateway: "Gateway"
  }
}
`)

	result := importD2(input, 20)
	if len(result.Source.Errors) != 0 {
		t.Fatalf("unexpected source errors: %#v", result.Source.Errors)
	}
	if result.Version != 4 {
		t.Fatalf("version = %d, want 4", result.Version)
	}
	if len(result.Classes) != 1 {
		t.Fatalf("classes = %#v, want only the used vlan definition", result.Classes)
	}
	class := result.Classes[0]
	if class.Key != "vlan" || class.UsageCount != 1 {
		t.Fatalf("unexpected class usage: %#v", class)
	}
	if len(class.SampleElementKeys) != 1 || class.SampleElementKeys[0] != "dmz.vlan1540" {
		t.Fatalf("unexpected class samples: %#v", class.SampleElementKeys)
	}
	style, ok := class.Definition["style"].(map[string]any)
	if !ok || style["fill"] != "#F5F7FA" || style["stroke-width"] != "2" {
		t.Fatalf("unexpected class definition: %#v", class.Definition)
	}
	if class.Range == nil || class.Range.Start.Line != 2 {
		t.Fatalf("unexpected class source range: %#v", class.Range)
	}

	dmz := findGroupByID(t, result.Elements.Groups, "dmz")
	if len(dmz.Path) != 1 || dmz.Path[0] != "dmz" {
		t.Fatalf("dmz path segments = %#v", dmz.Path)
	}
	if len(dmz.ClassKeys) != 0 {
		t.Fatalf("structural dmz class keys = %#v, want empty", dmz.ClassKeys)
	}
	vlan := findGroupByID(t, result.Elements.Groups, "dmz.vlan1540")
	if len(vlan.Path) != 2 || vlan.Path[0] != "dmz" || vlan.Path[1] != "vlan1540" {
		t.Fatalf("vlan path segments = %#v", vlan.Path)
	}
	if len(vlan.ClassKeys) != 1 || vlan.ClassKeys[0] != "vlan" {
		t.Fatalf("typed vlan class keys = %#v, want [vlan]", vlan.ClassKeys)
	}
	if vlan.Style["fill"] != "#F5F7FA" {
		t.Fatalf("typed vlan did not receive class style: %#v", vlan.Style)
	}

	encoded, err := json.Marshal(dmz)
	if err != nil {
		t.Fatalf("marshal dmz group: %v", err)
	}
	if !bytes.Contains(encoded, []byte(`"classKeys":[]`)) {
		t.Fatalf("untyped group must expose an empty classKeys array: %s", encoded)
	}
}

func TestImportD2ExtractsClassNotesAsRoleGuidance(t *testing.T) {
	input := []byte(`classes: {
  application: {
    Notes: |md
      CMDB application object. It is a connection endpoint.
    |
  }
  unused: { shape: cloud }
}
app: Application { class: application }
`)

	result := importD2(input, 20)
	if len(result.Source.Errors) != 0 {
		t.Fatalf("unexpected source errors: %#v", result.Source.Errors)
	}
	if len(result.Classes) != 1 || result.Classes[0].Key != "application" {
		t.Fatalf("unexpected classes: %#v", result.Classes)
	}
	if got := result.Classes[0].Notes; got != "CMDB application object. It is a connection endpoint." {
		t.Fatalf("notes = %q", got)
	}
}

func TestImportD2PreservesNodeNotesAsPlacementGuidance(t *testing.T) {
	input := []byte(`classes: {
  application: { shape: rectangle }
}
apps: {
  api: "Application" {
    class: application
    Notes: |md
      binding-result: Applications for virtual servers
      stage-policy: terminal-only
    |
  }
}
`)

	result := importD2(input, 20)
	if len(result.Source.Errors) != 0 {
		t.Fatalf("unexpected source errors: %#v", result.Source.Errors)
	}
	api := findNodeByID(t, result.Elements.Nodes, "apps.api")
	if got := api.Notes; got != "binding-result: Applications for virtual servers\nstage-policy: terminal-only" {
		t.Fatalf("node notes = %q", got)
	}
}

func TestImportD2PreservesStaticTemplateContainerAndNotes(t *testing.T) {
	input := []byte(`vars: {
  data: {
    cmdp: {
      import: {
        static: { legend: true }
      }
    }
  }
}
legend: "Типы ACL-связей" {
  Notes: |md
    Весь блок статический и показывается на каждой диаграмме.
  |
  external: "Внешняя связь"
  internal: "Внутренняя связь"
  external -> internal: "пример"
}
`)

	result := importD2(input, 20)
	if len(result.Source.Errors) != 0 {
		t.Fatalf("unexpected source errors: %#v", result.Source.Errors)
	}
	legend := findGroupByID(t, result.Elements.Groups, "legend")
	if !legend.Static {
		t.Fatalf("legend must be marked static: %#v", legend)
	}
	if got := legend.Notes; got != "Весь блок статический и показывается на каждой диаграмме." {
		t.Fatalf("legend notes = %q", got)
	}
	if len(legend.Children) != 2 || legend.Children[0] != "legend.external" || legend.Children[1] != "legend.internal" {
		t.Fatalf("legend children = %#v", legend.Children)
	}
}

func TestImportD2RejectsUnknownOrNestedStaticTemplateContainer(t *testing.T) {
	unknown := importD2([]byte(`vars: { data: { cmdp: { import: { static: { missing: true } } } } }
legend: { node: Example }
`), 20)
	if len(unknown.Source.Errors) != 1 || unknown.Source.Errors[0].Code != "unknown_static_element_target" {
		t.Fatalf("unexpected unknown static target errors: %#v", unknown.Source.Errors)
	}
	assertEmptyElements(t, unknown.Elements)

	nested := importD2([]byte(`vars: { data: { cmdp: { import: { static: { root.child: true } } } } }
root: {
  child: { node: Example }
}
`), 20)
	if len(nested.Source.Errors) != 1 || nested.Source.Errors[0].Code != "nested_static_element_target" {
		t.Fatalf("unexpected nested static target errors: %#v", nested.Source.Errors)
	}
	assertEmptyElements(t, nested.Elements)

	nestedQuoted := importD2([]byte(`vars: { data: { cmdp: { import: { static: { "root.child": true } } } } }
root: {
  child: { node: Example }
}
`), 20)
	if len(nestedQuoted.Source.Errors) != 1 || nestedQuoted.Source.Errors[0].Code != "nested_static_element_target" {
		t.Fatalf("unexpected quoted nested static target errors: %#v", nestedQuoted.Source.Errors)
	}
	assertEmptyElements(t, nestedQuoted.Elements)
}

func TestImportD2RejectsInvalidNestedStaticElementValue(t *testing.T) {
	result := importD2([]byte(`vars: { data: { cmdp: { import: { static: { root.child: false } } } } }
root: {
  child: { node: Example }
}
`), 20)
	if len(result.Source.Errors) != 1 || result.Source.Errors[0].Code != "invalid_static_element" {
		t.Fatalf("unexpected invalid nested static element errors: %#v", result.Source.Errors)
	}
	if !strings.Contains(result.Source.Errors[0].Message, "root.child") {
		t.Fatalf("invalid nested static element error = %#v", result.Source.Errors[0])
	}
	assertEmptyElements(t, result.Elements)
}

func TestStripClassNotesIgnoresBracesInQuotedLiterals(t *testing.T) {
	input := []byte(`classes: {
  application: {
    tooltip: "A quoted closing brace } is not D2 structure"
    Notes: |md
      CMDB application object.
    |
  }
}
`)

	stripped, notes := stripClassNotes(input)

	assertStrippedClassNotes(t, input, stripped, notes, "application", "CMDB application object.")
}

func TestStripClassNotesIgnoresBracesInComments(t *testing.T) {
	input := []byte(`classes: {
  application: {
    # A comment containing } must not close the class.
    Notes: |md
      CMDB application object.
    |
  }
}
`)

	stripped, notes := stripClassNotes(input)

	assertStrippedClassNotes(t, input, stripped, notes, "application", "CMDB application object.")
}

func TestStripClassNotesIgnoresBracesInMarkdownPayload(t *testing.T) {
	input := []byte(`classes: {
  application: {
    description: |md
      This Markdown payload contains a closing brace }.
    |
    Notes: |md
      CMDB application object.
      # This is Markdown content, not a D2 comment.
    |
  }
}
`)

	stripped, notes := stripClassNotes(input)

	assertStrippedClassNotes(t, input, stripped, notes, "application", "CMDB application object.\n# This is Markdown content, not a D2 comment.")
	if !bytes.Contains(stripped, []byte("This Markdown payload contains a closing brace }.")) {
		t.Fatalf("non-Notes Markdown payload was unexpectedly removed: %q", stripped)
	}
}

func assertStrippedClassNotes(t *testing.T, input, stripped []byte, notes map[string]string, classKey, wantNote string) {
	t.Helper()
	if got := notes[classKey]; got != wantNote {
		t.Fatalf("notes[%q] = %q, want %q", classKey, got, wantNote)
	}
	if bytes.Contains(stripped, []byte("Notes:")) {
		t.Fatalf("Notes field was not stripped: %q", stripped)
	}
	if got, want := bytes.Count(stripped, []byte("\n")), bytes.Count(input, []byte("\n")); got != want {
		t.Fatalf("newline count = %d, want %d", got, want)
	}
}

func TestImportD2AggregatesClassNotesAndUsageAcrossTypedEdges(t *testing.T) {
	input := []byte(`classes: {
  network_link: {
    style.stroke: "#2563EB"
    Notes: |md
      CMDB network connection generated from ACL data.
    |
  }
}
source: Source
target_a: "Target A"
target_b: "Target B"
source -> target_a: "TCP 443" {class: network_link}
source -> target_b: "UDP 53" {class: network_link}
`)

	result := importD2(input, 20)
	if len(result.Source.Errors) != 0 {
		t.Fatalf("unexpected source errors: %#v", result.Source.Errors)
	}
	if len(result.Classes) != 1 {
		t.Fatalf("classes = %#v, want only network_link", result.Classes)
	}
	class := result.Classes[0]
	if class.Key != "network_link" || class.Notes != "CMDB network connection generated from ACL data." {
		t.Fatalf("unexpected edge class metadata: %#v", class)
	}
	if class.UsageCount != 2 || len(class.SampleElementKeys) != 2 {
		t.Fatalf("unexpected edge class usage: %#v", class)
	}
	if len(result.Elements.Edges) != 2 {
		t.Fatalf("edges = %#v, want two typed edges", result.Elements.Edges)
	}

	sampledEdges := make(map[string]bool, len(class.SampleElementKeys))
	for _, key := range class.SampleElementKeys {
		sampledEdges[key] = true
	}
	for _, edge := range result.Elements.Edges {
		if len(edge.ClassKeys) != 1 || edge.ClassKeys[0] != "network_link" {
			t.Fatalf("edge class keys = %#v, want [network_link]", edge.ClassKeys)
		}
		if !sampledEdges[edge.ID] {
			t.Fatalf("edge %q missing from class samples: %#v", edge.ID, class.SampleElementKeys)
		}
	}
}

func TestImportD2ReadsExplicitConnectionDirectionPolicy(t *testing.T) {
	input := []byte(`vars: {
  data: {
    cmdp: {
      import: {
        connections: {
          acl_external: { directionPolicy: dataFields }
        }
      }
    }
  }
}
classes: {
  acl_external: { style.stroke: "#2563EB" }
}
source: Source
target: Target
source -> target: Traffic { class: acl_external }
`)

	result := importD2(input, 20)
	if len(result.Source.Errors) != 0 {
		t.Fatalf("unexpected source errors: %#v", result.Source.Errors)
	}
	if len(result.Classes) != 1 || result.Classes[0].Key != "acl_external" {
		t.Fatalf("unexpected classes: %#v", result.Classes)
	}
	if result.Classes[0].DirectionPolicy != "dataFields" {
		t.Fatalf("direction policy = %q, want dataFields", result.Classes[0].DirectionPolicy)
	}
}

func TestImportD2AggregatesClassUsageAcrossTypedNodes(t *testing.T) {
	input := []byte(`classes: {
  workstation: {
    shape: person
    style: {fill: "#E8EAF6"; stroke: "#3949AB"}
  }
  unused: {shape: cloud}
}
users: "Users" {
  operator: "Operator" {class: workstation}
  administrator: "Administrator" {class: workstation}
  visitor: "Visitor"
}
`)

	result := importD2(input, 20)
	if len(result.Source.Errors) != 0 {
		t.Fatalf("unexpected source errors: %#v", result.Source.Errors)
	}
	if len(result.Classes) != 1 {
		t.Fatalf("classes = %#v, want only workstation", result.Classes)
	}
	class := result.Classes[0]
	if class.Key != "workstation" || class.UsageCount != 2 {
		t.Fatalf("unexpected workstation usage: %#v", class)
	}
	if len(class.SampleElementKeys) != 2 || class.SampleElementKeys[0] != "users.operator" || class.SampleElementKeys[1] != "users.administrator" {
		t.Fatalf("unexpected workstation samples: %#v", class.SampleElementKeys)
	}
	if class.Definition["shape"] != "person" {
		t.Fatalf("unexpected workstation definition: %#v", class.Definition)
	}
	operator := findNodeByID(t, result.Elements.Nodes, "users.operator")
	if len(operator.ClassKeys) != 1 || operator.ClassKeys[0] != "workstation" {
		t.Fatalf("operator class keys = %#v, want [workstation]", operator.ClassKeys)
	}
	visitor := findNodeByID(t, result.Elements.Nodes, "users.visitor")
	if len(visitor.ClassKeys) != 0 {
		t.Fatalf("visitor class keys = %#v, want empty", visitor.ClassKeys)
	}
}

func TestImportD2ReadsStructuredContainerSemanticsAndStyle(t *testing.T) {
	input := []byte(`vars: {
  data: {
    cmdp: {
      import: {
        roles: {
          users: {semantic: decorative}
        }
      }
    }
  }
}
users: Users {
  style: {fill: "#FAFAFA"; stroke-dash: 4}
  operator: Operator
  administrator: Administrator
}
`)

	result := importD2(input, 20)
	if len(result.Source.Errors) != 0 {
		t.Fatalf("unexpected source errors: %#v", result.Source.Errors)
	}
	if len(result.Elements.Groups) != 1 {
		t.Fatalf("groups = %d, want 1", len(result.Elements.Groups))
	}
	group := result.Elements.Groups[0]
	if group.SelectedRole != "decorative" {
		t.Fatalf("selected role = %q, want decorative", group.SelectedRole)
	}
	if group.Style["fill"] != "#FAFAFA" || group.Style["stroke-dash"] != "4" {
		t.Fatalf("unexpected group style: %#v", group.Style)
	}
}

func TestImportD2PromotesExplicitEmptyContainerSemantic(t *testing.T) {
	input := []byte(`vars: {
  data: {
    cmdp: {
      import: {
        roles: {
          empty_zone: {semantic: group}
        }
      }
    }
  }
}
empty_zone: {
  label: "Empty zone"
  class: ["cmdp_group"]
}
`)

	result := importD2(input, 20)
	if len(result.Source.Errors) != 0 {
		t.Fatalf("unexpected source errors: %#v", result.Source.Errors)
	}
	if len(result.Elements.Nodes) != 0 || len(result.Elements.Groups) != 1 {
		t.Fatalf("unexpected normalized elements: %#v", result.Elements)
	}
	group := result.Elements.Groups[0]
	if group.ID != "empty_zone" || group.SelectedRole != "group" || len(group.Children) != 0 {
		t.Fatalf("unexpected empty group: %#v", group)
	}
}

func TestImportD2SuggestsGroupForBoundaryCrossingConnection(t *testing.T) {
	result := importD2([]byte("zone: { server: Server }\nzone.server -> internet\n"), 20)
	if len(result.Source.Errors) != 0 {
		t.Fatalf("unexpected source errors: %#v", result.Source.Errors)
	}
	if result.Elements.Groups[0].SuggestedRole != "group" {
		t.Fatalf("suggested role = %q, want group", result.Elements.Groups[0].SuggestedRole)
	}
}

func TestImportD2RejectsInvalidOrUnknownContainerSemantics(t *testing.T) {
	invalid := importD2([]byte(`vars: {data: {cmdp: {import: {roles: {users: {semantic: unsupported}}}}}}
users: {operator: Operator}
`), 20)
	if len(invalid.Source.Errors) != 1 || invalid.Source.Errors[0].Code != "invalid_semantic_role" {
		t.Fatalf("unexpected invalid semantic errors: %#v", invalid.Source.Errors)
	}
	assertEmptyElements(t, invalid.Elements)

	unknown := importD2([]byte(`vars: {data: {cmdp: {import: {roles: {missing: {semantic: composite}}}}}}
users: {operator: Operator}
`), 20)
	if len(unknown.Source.Errors) != 1 || unknown.Source.Errors[0].Code != "unknown_semantic_role_target" {
		t.Fatalf("unexpected unknown target errors: %#v", unknown.Source.Errors)
	}
	assertEmptyElements(t, unknown.Elements)
}

func TestHierarchyIDsRemainStableWhenSiblingOrderChanges(t *testing.T) {
	first := importD2([]byte("cluster: {\n  alpha: Alpha\n  beta: Beta\n}\n"), 20)
	second := importD2([]byte("cluster: {\n  gamma: Gamma\n  beta: Beta\n  alpha: Alpha\n}\n"), 20)

	ids := make(map[string]string)
	for _, hierarchy := range first.Elements.Hierarchies {
		ids[hierarchy.Parent+"->"+hierarchy.Child] = hierarchy.ID
	}
	for _, hierarchy := range second.Elements.Hierarchies {
		key := hierarchy.Parent + "->" + hierarchy.Child
		if expected, ok := ids[key]; ok && hierarchy.ID != expected {
			t.Fatalf("hierarchy id changed for %s: %q != %q", key, hierarchy.ID, expected)
		}
	}
}

func TestImportD2RejectsImports(t *testing.T) {
	result := importD2([]byte("x: @other\n"), 20)

	if len(result.Source.Errors) != 1 || result.Source.Errors[0].Code != "import_not_allowed" {
		t.Fatalf("unexpected errors: %#v", result.Source.Errors)
	}
	assertEmptyElements(t, result.Elements)
}

func TestImportD2ReturnsParserErrors(t *testing.T) {
	result := importD2([]byte("x: {\n"), 20)

	if len(result.Source.Errors) == 0 || result.Source.Errors[0].Code != "parse_error" {
		t.Fatalf("unexpected errors: %#v", result.Source.Errors)
	}
	if result.Source.Errors[0].Range == nil || result.Source.Errors[0].Range.Start.Line < 1 {
		t.Fatalf("missing one-based error range: %#v", result.Source.Errors[0])
	}
	assertEmptyElements(t, result.Elements)
}

func TestImportD2EnforcesNormalizedElementLimit(t *testing.T) {
	result := importD2([]byte("a -> b\n"), 2)

	if len(result.Source.Errors) != 1 || result.Source.Errors[0].Code != "element_limit_exceeded" {
		t.Fatalf("unexpected errors: %#v", result.Source.Errors)
	}
	assertEmptyElements(t, result.Elements)
}

func TestRunCLIWritesOneJSONObject(t *testing.T) {
	var stdout bytes.Buffer
	exitCode := runCLI([]string{"--max-elements=10"}, strings.NewReader("a -> b\n"), &stdout)
	if exitCode != 0 {
		t.Fatalf("exit code = %d, want 0", exitCode)
	}

	decoder := json.NewDecoder(&stdout)
	var result importResult
	if err := decoder.Decode(&result); err != nil {
		t.Fatalf("decode result: %v", err)
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		t.Fatalf("expected exactly one JSON object, got trailing data: %v", err)
	}
	if len(result.Elements.Nodes) != 2 || len(result.Elements.Edges) != 1 {
		t.Fatalf("unexpected elements: %#v", result.Elements)
	}
}

func TestRunCLIEnforcesInputLimitAsJSON(t *testing.T) {
	var stdout bytes.Buffer
	exitCode := runCLI([]string{"--max-input-bytes=4"}, strings.NewReader("alpha"), &stdout)
	if exitCode != 0 {
		t.Fatalf("exit code = %d, want 0", exitCode)
	}

	var result importResult
	if err := json.Unmarshal(stdout.Bytes(), &result); err != nil {
		t.Fatalf("decode result: %v", err)
	}
	if !result.Source.Truncated || len(result.Source.Errors) != 1 || result.Source.Errors[0].Code != "input_limit_exceeded" {
		t.Fatalf("unexpected source result: %#v", result.Source)
	}
}

func TestRunCLIRejectsInvalidLimit(t *testing.T) {
	var stdout bytes.Buffer
	exitCode := runCLI([]string{"--max-elements=0"}, strings.NewReader("a"), &stdout)
	if exitCode != 2 {
		t.Fatalf("exit code = %d, want 2", exitCode)
	}

	var result importResult
	if err := json.Unmarshal(stdout.Bytes(), &result); err != nil {
		t.Fatalf("decode result: %v", err)
	}
	if len(result.Source.Errors) != 1 || result.Source.Errors[0].Code != "invalid_argument" {
		t.Fatalf("unexpected errors: %#v", result.Source.Errors)
	}
}

func assertEmptyElements(t *testing.T, value elements) {
	t.Helper()
	if len(value.Nodes) != 0 || len(value.Edges) != 0 || len(value.Groups) != 0 || len(value.Hierarchies) != 0 {
		t.Fatalf("expected empty elements: %#v", value)
	}
}

func findGroupByID(t *testing.T, groups []groupElement, id string) groupElement {
	t.Helper()
	for _, group := range groups {
		if group.ID == id {
			return group
		}
	}
	t.Fatalf("group %q not found in %#v", id, groups)
	return groupElement{}
}

func findNodeByID(t *testing.T, nodes []nodeElement, id string) nodeElement {
	t.Helper()
	for _, node := range nodes {
		if node.ID == id {
			return node
		}
	}
	t.Fatalf("node %q not found in %#v", id, nodes)
	return nodeElement{}
}
