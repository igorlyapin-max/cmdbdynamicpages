package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"

	"oss.terrastruct.com/d2/d2ast"
	"oss.terrastruct.com/d2/d2compiler"
	"oss.terrastruct.com/d2/d2graph"
	"oss.terrastruct.com/d2/d2ir"
	"oss.terrastruct.com/d2/d2parser"
)

const sourcePath = "stdin.d2"

const classUsageSampleLimit = 5

type importResult struct {
	Version  int               `json:"version"`
	Source   sourceInfo        `json:"source"`
	Template templateHints     `json:"template"`
	Classes  []classDefinition `json:"classes"`
	Elements elements          `json:"elements"`
	Warnings []string          `json:"warnings"`
}

type sourceInfo struct {
	Format    string        `json:"format"`
	Parser    string        `json:"parser"`
	Name      string        `json:"name"`
	Bytes     int           `json:"bytes"`
	SHA256    string        `json:"sha256"`
	Truncated bool          `json:"truncated,omitempty"`
	Errors    []sourceError `json:"errors"`
}

type sourceError struct {
	Code    string       `json:"code"`
	Message string       `json:"message"`
	Range   *sourceRange `json:"range,omitempty"`
}

type sourceRange struct {
	Start sourcePosition `json:"start"`
	End   sourcePosition `json:"end"`
}

type sourcePosition struct {
	Line   int `json:"line"`
	Column int `json:"column"`
	Byte   int `json:"byte"`
}

type elements struct {
	Nodes       []nodeElement      `json:"nodes"`
	Edges       []edgeElement      `json:"edges"`
	Groups      []groupElement     `json:"groups"`
	Hierarchies []hierarchyElement `json:"hierarchies"`
}

type nodeElement struct {
	ID        string            `json:"id"`
	Label     string            `json:"label"`
	Shape     string            `json:"shape,omitempty"`
	ClassKeys []string          `json:"classKeys"`
	Style     map[string]string `json:"style,omitempty"`
	Group     string            `json:"group,omitempty"`
	Parent    string            `json:"parent,omitempty"`
	Href      string            `json:"href,omitempty"`
	Tooltip   string            `json:"tooltip,omitempty"`
	Board     string            `json:"board,omitempty"`
	Path      []string          `json:"pathSegments"`
	Range     *sourceRange      `json:"range,omitempty"`
}

type edgeElement struct {
	ID          string            `json:"id"`
	Source      string            `json:"source"`
	Target      string            `json:"target"`
	Label       string            `json:"label"`
	Kind        string            `json:"kind"`
	Direction   string            `json:"direction"`
	SourceArrow bool              `json:"sourceArrow"`
	TargetArrow bool              `json:"targetArrow"`
	ClassKeys   []string          `json:"classKeys"`
	Style       map[string]string `json:"style,omitempty"`
	Href        string            `json:"href,omitempty"`
	Tooltip     string            `json:"tooltip,omitempty"`
	Board       string            `json:"board,omitempty"`
	SourcePath  []string          `json:"sourcePathSegments"`
	TargetPath  []string          `json:"targetPathSegments"`
	Range       *sourceRange      `json:"range,omitempty"`
}

type groupElement struct {
	ID             string            `json:"id"`
	Label          string            `json:"label"`
	Shape          string            `json:"shape,omitempty"`
	ClassKeys      []string          `json:"classKeys"`
	Style          map[string]string `json:"style,omitempty"`
	Parent         string            `json:"parent,omitempty"`
	Children       []string          `json:"children"`
	SuggestedRole  string            `json:"suggestedRole"`
	SelectedRole   string            `json:"selectedRole,omitempty"`
	SemanticReason string            `json:"semanticReason,omitempty"`
	Href           string            `json:"href,omitempty"`
	Tooltip        string            `json:"tooltip,omitempty"`
	Board          string            `json:"board,omitempty"`
	Path           []string          `json:"pathSegments"`
	Range          *sourceRange      `json:"range,omitempty"`
}

type hierarchyElement struct {
	ID         string       `json:"id"`
	Parent     string       `json:"parent"`
	Child      string       `json:"child"`
	Label      string       `json:"label"`
	Board      string       `json:"board,omitempty"`
	ParentPath []string     `json:"parentPathSegments"`
	ChildPath  []string     `json:"childPathSegments"`
	Range      *sourceRange `json:"range,omitempty"`
}

// classDefinition is a reusable D2 visual/template role, never a CMDBuild class identity.
type classDefinition struct {
	Key               string         `json:"key"`
	Notes             string         `json:"notes,omitempty"`
	DirectionPolicy   string         `json:"directionPolicy,omitempty"`
	Definition        map[string]any `json:"definition"`
	UsageCount        int            `json:"usageCount"`
	SampleElementKeys []string       `json:"sampleElementKeys"`
	Range             *sourceRange   `json:"range,omitempty"`
}

type templateHints struct {
	NodeMappings      []mappingHint `json:"nodeMappings"`
	EdgeMappings      []mappingHint `json:"edgeMappings"`
	GroupMappings     []mappingHint `json:"groupMappings"`
	HierarchyMappings []mappingHint `json:"hierarchyMappings"`
}

type mappingHint struct {
	From          string            `json:"from"`
	Type          string            `json:"type,omitempty"`
	LabelTemplate string            `json:"labelTemplate,omitempty"`
	Fields        map[string]string `json:"fields"`
}

type graphVisit struct {
	graph *d2graph.Graph
	board string
}

type semanticRoleEntry struct {
	Role  string
	Range *sourceRange
}

type semanticRoleIndex map[string]semanticRoleEntry

type connectionPolicyEntry struct {
	Policy string
	Range  *sourceRange
}

type connectionPolicyIndex map[string]connectionPolicyEntry

type classUsage struct {
	count   int
	samples []string
	seen    map[string]struct{}
}

func newImportResult(input []byte) importResult {
	result := importResult{
		Version: 4,
		Source: sourceInfo{
			Format: "d2",
			Parser: "d2-v0.7.1",
			Name:   "stdin",
			Bytes:  len(input),
			Errors: make([]sourceError, 0),
		},
		Template: templateHints{
			NodeMappings:      make([]mappingHint, 0),
			EdgeMappings:      make([]mappingHint, 0),
			GroupMappings:     make([]mappingHint, 0),
			HierarchyMappings: make([]mappingHint, 0),
		},
		Classes: make([]classDefinition, 0),
		Elements: elements{
			Nodes:       make([]nodeElement, 0),
			Edges:       make([]edgeElement, 0),
			Groups:      make([]groupElement, 0),
			Hierarchies: make([]hierarchyElement, 0),
		},
		Warnings: make([]string, 0),
	}
	if input != nil {
		sum := sha256.Sum256(input)
		result.Source.SHA256 = hex.EncodeToString(sum[:])
	}
	return result
}

func importD2(input []byte, maxElements int) importResult {
	result := newImportResult(input)
	compilerInput, notesByClass := stripClassNotes(input)

	ast, err := d2parser.Parse(sourcePath, bytes.NewReader(compilerInput), nil)
	if err != nil {
		result.Source.Errors = append(result.Source.Errors, errorsFromD2(err, "parse_error")...)
		return result
	}

	imports := findImports(ast)
	if len(imports) != 0 {
		for _, item := range imports {
			result.Source.Errors = append(result.Source.Errors, sourceError{
				Code:    "import_not_allowed",
				Message: "D2 @imports are not allowed; stdin must be self-contained",
				Range:   rangeFromD2(item.GetRange()),
			})
		}
		return result
	}

	ir, _, err := d2ir.Compile(ast, &d2ir.CompileOptions{FS: nil})
	if err != nil {
		result.Source.Errors = append(result.Source.Errors, errorsFromD2(err, "metadata_compile_error")...)
		return result
	}

	semanticRoles, semanticErrors := extractSemanticRoleIndex(ir)
	if len(semanticErrors) != 0 {
		result.Source.Errors = append(result.Source.Errors, semanticErrors...)
		return result
	}
	connectionPolicies, policyErrors := extractConnectionPolicyIndex(ir)
	if len(policyErrors) != 0 {
		result.Source.Errors = append(result.Source.Errors, policyErrors...)
		return result
	}

	graph, _, err := d2compiler.Compile(sourcePath, bytes.NewReader(compilerInput), &d2compiler.CompileOptions{FS: nil})
	if err != nil {
		result.Source.Errors = append(result.Source.Errors, errorsFromD2(err, "compile_error")...)
		return result
	}

	visits := collectGraphs(graph)
	if semanticErrors = validateSemanticRoleTargets(visits, semanticRoles); len(semanticErrors) != 0 {
		result.Source.Errors = append(result.Source.Errors, semanticErrors...)
		return result
	}
	elementCount := countNormalizedElements(visits, maxElements)
	if elementCount > maxElements {
		result.Source.Errors = append(result.Source.Errors, sourceError{
			Code:    "element_limit_exceeded",
			Message: fmt.Sprintf("normalized D2 element count exceeds the configured limit of %d", maxElements),
		})
		return result
	}

	result.Elements = normalizeElements(visits, semanticRoles)
	if policyErrors = validateConnectionPolicyTargets(result.Elements, connectionPolicies); len(policyErrors) != 0 {
		result.Source.Errors = append(result.Source.Errors, policyErrors...)
		return result
	}
	result.Classes = extractUsedClassDefinitions(ir, result.Elements, notesByClass, connectionPolicies)
	result.Template = templateForElements(result.Elements)
	return result
}

// stripClassNotes supports Notes as authoring-only guidance inside classes.<role>.
// D2 v0.7.1 rejects arbitrary class fields, so the compiler receives a source
// with exactly the same line count while the importer retains the annotation.
func stripClassNotes(input []byte) ([]byte, map[string]string) {
	lines := strings.SplitAfter(string(input), "\n")
	notesByClass := make(map[string]string)
	output := make([]string, 0, len(lines))
	depth, classesDepth, classDepth := 0, -1, -1
	classKey := ""
	scanner := d2SourceScanner{}
	noteClass := ""
	noteLines := make([]string, 0)
	for _, line := range lines {
		if noteClass != "" {
			output = append(output, newlineOnly(line))
			if isD2MarkdownEnd(line) {
				notesByClass[noteClass] = strings.TrimSpace(strings.Join(noteLines, "\n"))
				noteClass = ""
				noteLines = noteLines[:0]
			} else {
				noteLines = append(noteLines, strings.TrimSpace(line))
			}
			continue
		}
		if scanner.markdown {
			output = append(output, line)
			if isD2MarkdownEnd(line) {
				scanner.markdown = false
			}
			continue
		}

		code := scanner.codeLine(line)
		fieldName, fieldValue, hasField := d2Field(code)
		if classesDepth < 0 && hasField && fieldName == "classes" && d2MapValue(fieldValue) {
			classesDepth = depth + 1
		}
		if classesDepth >= 0 && depth == classesDepth && hasField && d2MapValue(fieldValue) {
			classKey = fieldName
			classDepth = depth + 1
		}
		if classKey != "" && depth == classDepth && hasField && strings.EqualFold(fieldName, "notes") && d2MarkdownValue(fieldValue) {
			noteClass = classKey
			noteLines = noteLines[:0]
			output = append(output, newlineOnly(line))
			continue
		}
		output = append(output, line)
		if hasField && d2MarkdownValue(fieldValue) {
			scanner.markdown = true
		}
		depth += d2BraceDelta(code)
		if classKey != "" && depth < classDepth {
			classKey, classDepth = "", -1
		}
		if classesDepth >= 0 && depth < classesDepth {
			classesDepth = -1
		}
	}
	if noteClass != "" {
		notesByClass[noteClass] = strings.TrimSpace(strings.Join(noteLines, "\n"))
	}
	return []byte(strings.Join(output, "")), notesByClass
}

// d2SourceScanner keeps only structural D2 syntax in codeLine. Braces in
// quoted values, # comments, and multiline Markdown do not affect map depth.
type d2SourceScanner struct {
	escaped  bool
	markdown bool
	quoted   bool
}

func (scanner *d2SourceScanner) codeLine(line string) string {
	var code strings.Builder
	code.Grow(len(line))
	for index := 0; index < len(line); index++ {
		character := line[index]
		if scanner.quoted {
			code.WriteByte(' ')
			if scanner.escaped {
				scanner.escaped = false
				continue
			}
			switch character {
			case '\\':
				scanner.escaped = true
			case '"':
				scanner.quoted = false
			}
			continue
		}
		if character == '#' {
			break
		}
		if character == '"' {
			scanner.quoted = true
			scanner.escaped = false
			code.WriteByte(' ')
			continue
		}
		code.WriteByte(character)
	}
	return code.String()
}

func d2Field(code string) (string, string, bool) {
	separator := strings.IndexByte(code, ':')
	if separator <= 0 {
		return "", "", false
	}
	name := strings.TrimSpace(code[:separator])
	if name == "" || strings.ContainsAny(name, "{};") {
		return "", "", false
	}
	return name, strings.TrimSpace(code[separator+1:]), true
}

func d2MapValue(value string) bool {
	return strings.HasPrefix(value, "{")
}

func d2MarkdownValue(value string) bool {
	return strings.HasPrefix(value, "|")
}

func isD2MarkdownEnd(line string) bool {
	return strings.TrimSpace(line) == "|"
}

func d2BraceDelta(code string) int {
	depth := 0
	for index := 0; index < len(code); index++ {
		switch code[index] {
		case '{':
			depth++
		case '}':
			depth--
		}
	}
	return depth
}

func newlineOnly(line string) string {
	if strings.HasSuffix(line, "\r\n") {
		return "\r\n"
	}
	if strings.HasSuffix(line, "\n") {
		return "\n"
	}
	return ""
}

func extractSemanticRoleIndex(ir *d2ir.Map) (semanticRoleIndex, []sourceError) {
	result := make(semanticRoleIndex)
	current := ir
	var rolesField *d2ir.Field
	for _, name := range []string{"vars", "data", "cmdp", "import", "roles"} {
		rolesField = current.GetField(d2ast.FlatUnquotedString(name))
		if rolesField == nil {
			return result, nil
		}
		if rolesField.Map() == nil {
			return result, []sourceError{{Code: "invalid_semantic_roles", Message: fmt.Sprintf("vars.data.cmdp.import.roles path component %q must be a map", name), Range: rangeFromD2(rolesField.AST().GetRange())}}
		}
		current = rolesField.Map()
	}
	roles := current
	errors := make([]sourceError, 0)
	for _, roleField := range roles.Fields {
		key := roleField.Name.ScalarString()
		roleMap := roleField.Map()
		if roleMap == nil {
			errors = append(errors, sourceError{Code: "invalid_semantic_role", Message: fmt.Sprintf("semantic role %q must be a map", key), Range: rangeFromD2(roleField.AST().GetRange())})
			continue
		}
		var semanticField *d2ir.Field
		for _, field := range roleMap.Fields {
			if field.Name.ScalarString() == "semantic" {
				semanticField = field
				break
			}
		}
		if semanticField == nil || semanticField.Primary() == nil {
			errors = append(errors, sourceError{Code: "invalid_semantic_role", Message: fmt.Sprintf("semantic role %q must define a scalar semantic value", key), Range: rangeFromD2(roleField.AST().GetRange())})
			continue
		}
		semantic := semanticField.Primary().Value.ScalarString()
		if !validContainerRole(semantic) {
			errors = append(errors, sourceError{Code: "invalid_semantic_role", Message: fmt.Sprintf("semantic role %q must be composite, group, or decorative", key), Range: rangeFromD2(semanticField.AST().GetRange())})
			continue
		}
		result[key] = semanticRoleEntry{Role: semantic, Range: rangeFromD2(semanticField.AST().GetRange())}
	}
	return result, errors
}

func extractConnectionPolicyIndex(ir *d2ir.Map) (connectionPolicyIndex, []sourceError) {
	result := make(connectionPolicyIndex)
	current := ir
	var connectionsField *d2ir.Field
	for _, name := range []string{"vars", "data", "cmdp", "import", "connections"} {
		connectionsField = current.GetField(d2ast.FlatUnquotedString(name))
		if connectionsField == nil {
			return result, nil
		}
		if connectionsField.Map() == nil {
			return result, []sourceError{{Code: "invalid_connection_policies", Message: fmt.Sprintf("vars.data.cmdp.import.connections path component %q must be a map", name), Range: rangeFromD2(connectionsField.AST().GetRange())}}
		}
		current = connectionsField.Map()
	}
	errors := make([]sourceError, 0)
	for _, connectionField := range current.Fields {
		key := connectionField.Name.ScalarString()
		connectionMap := connectionField.Map()
		if connectionMap == nil {
			errors = append(errors, sourceError{Code: "invalid_connection_policy", Message: fmt.Sprintf("connection policy %q must be a map", key), Range: rangeFromD2(connectionField.AST().GetRange())})
			continue
		}
		var directionPolicyField *d2ir.Field
		for _, field := range connectionMap.Fields {
			if field.Name.ScalarString() == "directionPolicy" {
				directionPolicyField = field
				break
			}
		}
		if directionPolicyField == nil || directionPolicyField.Primary() == nil {
			errors = append(errors, sourceError{Code: "invalid_connection_policy", Message: fmt.Sprintf("connection policy %q must define a scalar directionPolicy", key), Range: rangeFromD2(connectionField.AST().GetRange())})
			continue
		}
		policy := directionPolicyField.Primary().Value.ScalarString()
		if !validDirectionPolicy(policy) {
			errors = append(errors, sourceError{Code: "invalid_connection_policy", Message: fmt.Sprintf("connection policy %q must use dataFields, template, or undirected", key), Range: rangeFromD2(directionPolicyField.AST().GetRange())})
			continue
		}
		result[key] = connectionPolicyEntry{Policy: policy, Range: rangeFromD2(directionPolicyField.AST().GetRange())}
	}
	return result, errors
}

func validateConnectionPolicyTargets(value elements, policies connectionPolicyIndex) []sourceError {
	edgeClasses := make(map[string]struct{})
	for _, edge := range value.Edges {
		for _, key := range edge.ClassKeys {
			edgeClasses[key] = struct{}{}
		}
	}
	errors := make([]sourceError, 0)
	for key, entry := range policies {
		if _, ok := edgeClasses[key]; !ok {
			errors = append(errors, sourceError{Code: "unknown_connection_policy_target", Message: fmt.Sprintf("connection policy target %q is not a used D2 edge class", key), Range: entry.Range})
		}
	}
	return errors
}

func extractUsedClassDefinitions(ir *d2ir.Map, normalized elements, notesByClass map[string]string, connectionPolicies connectionPolicyIndex) []classDefinition {
	result := make([]classDefinition, 0)
	classesField := ir.GetField(d2ast.FlatUnquotedString("classes"))
	if classesField == nil || classesField.Map() == nil {
		return result
	}

	usage := collectClassUsage(normalized)
	for _, field := range classesField.Map().Fields {
		entry := usage[field.Name.ScalarString()]
		if entry == nil || entry.count == 0 || field.Map() == nil {
			continue
		}
		result = append(result, classDefinition{
			Key:               field.Name.ScalarString(),
			Notes:             strings.TrimSpace(notesByClass[field.Name.ScalarString()]),
			DirectionPolicy:   connectionPolicies[field.Name.ScalarString()].Policy,
			Definition:        classMapDefinition(field.Map()),
			UsageCount:        entry.count,
			SampleElementKeys: append([]string(nil), entry.samples...),
			Range:             irFieldRange(field),
		})
	}
	return result
}

func collectClassUsage(normalized elements) map[string]*classUsage {
	result := make(map[string]*classUsage)
	add := func(elementKey string, classKeys []string) {
		for _, classKey := range classKeys {
			entry := result[classKey]
			if entry == nil {
				entry = &classUsage{samples: make([]string, 0, classUsageSampleLimit), seen: make(map[string]struct{})}
				result[classKey] = entry
			}
			if _, ok := entry.seen[elementKey]; ok {
				continue
			}
			entry.seen[elementKey] = struct{}{}
			entry.count++
			if len(entry.samples) < classUsageSampleLimit {
				entry.samples = append(entry.samples, elementKey)
			}
		}
	}
	for _, node := range normalized.Nodes {
		add(node.ID, node.ClassKeys)
	}
	for _, group := range normalized.Groups {
		add(group.ID, group.ClassKeys)
	}
	for _, edge := range normalized.Edges {
		add(edge.ID, edge.ClassKeys)
	}
	return result
}

func classMapDefinition(value *d2ir.Map) map[string]any {
	result := make(map[string]any, len(value.Fields))
	for _, field := range value.Fields {
		result[field.Name.ScalarString()] = classFieldDefinition(field)
	}
	return result
}

func classFieldDefinition(field *d2ir.Field) any {
	var primary any
	if field.Primary() != nil {
		primary = field.Primary().Value.ScalarString()
	}
	if field.Composite == nil {
		return primary
	}

	composite := classValueDefinition(field.Composite)
	if primary == nil {
		return composite
	}
	return map[string]any{
		"value":      primary,
		"definition": composite,
	}
}

func classValueDefinition(value d2ir.Value) any {
	switch typed := value.(type) {
	case *d2ir.Scalar:
		return typed.Value.ScalarString()
	case *d2ir.Map:
		return classMapDefinition(typed)
	case *d2ir.Array:
		items := make([]any, 0, len(typed.Values))
		for _, item := range typed.Values {
			items = append(items, classValueDefinition(item))
		}
		return items
	default:
		return nil
	}
}

func irFieldRange(field *d2ir.Field) *sourceRange {
	if field == nil || len(field.References) == 0 {
		return nil
	}
	return rangeFromD2(field.LastRef().AST().GetRange())
}

func validateSemanticRoleTargets(visits []graphVisit, roles semanticRoleIndex) []sourceError {
	objects := make(map[string]struct{})
	for _, visit := range visits {
		for _, object := range visit.graph.Objects {
			objects[elementID(visit.board, object.AbsID())] = struct{}{}
		}
	}
	errors := make([]sourceError, 0)
	for key, entry := range roles {
		if _, ok := objects[key]; !ok {
			errors = append(errors, sourceError{Code: "unknown_semantic_role_target", Message: fmt.Sprintf("semantic role target %q is not a D2 object", key), Range: entry.Range})
		}
	}
	return errors
}

func validContainerRole(value string) bool {
	return value == "composite" || value == "group" || value == "decorative"
}

func validDirectionPolicy(value string) bool {
	return value == "dataFields" || value == "template" || value == "undirected"
}

func encodeResult(w io.Writer, result importResult) error {
	encoder := json.NewEncoder(w)
	encoder.SetEscapeHTML(false)
	return encoder.Encode(result)
}

func findImports(root d2ast.Node) []*d2ast.Import {
	imports := make([]*d2ast.Import, 0)
	var walk func(d2ast.Node)
	walk = func(node d2ast.Node) {
		if item, ok := node.(*d2ast.Import); ok {
			imports = append(imports, item)
		}
		for _, child := range node.Children() {
			walk(child)
		}
	}
	walk(root)
	return imports
}

func errorsFromD2(err error, code string) []sourceError {
	var parseErr *d2parser.ParseError
	if errors.As(err, &parseErr) {
		result := make([]sourceError, 0, len(parseErr.Errors))
		for _, item := range parseErr.Errors {
			result = append(result, sourceError{
				Code:    code,
				Message: item.Message,
				Range:   rangeFromD2(item.Range),
			})
		}
		return result
	}
	return []sourceError{{Code: code, Message: err.Error()}}
}

func rangeFromD2(value d2ast.Range) *sourceRange {
	return &sourceRange{
		Start: sourcePosition{Line: value.Start.Line + 1, Column: value.Start.Column + 1, Byte: value.Start.Byte},
		End:   sourcePosition{Line: value.End.Line + 1, Column: value.End.Column + 1, Byte: value.End.Byte},
	}
}

func collectGraphs(root *d2graph.Graph) []graphVisit {
	visits := make([]graphVisit, 0, 1)
	var walk func(*d2graph.Graph, string)
	walk = func(graph *d2graph.Graph, board string) {
		visits = append(visits, graphVisit{graph: graph, board: board})
		walkChildren := func(kind string, children []*d2graph.Graph) {
			for index, child := range children {
				name := child.Name
				if name == "" {
					name = strconv.Itoa(index)
				}
				childBoard := kind + "." + name
				if board != "" {
					childBoard = board + "." + childBoard
				}
				walk(child, childBoard)
			}
		}
		walkChildren("layers", graph.Layers)
		walkChildren("scenarios", graph.Scenarios)
		walkChildren("steps", graph.Steps)
	}
	walk(root, "")
	return visits
}

func countNormalizedElements(visits []graphVisit, limit int) int {
	count := 0
	for _, visit := range visits {
		count += len(visit.graph.Objects) + len(visit.graph.Edges)
		for _, object := range visit.graph.Objects {
			if hasElementParent(object) {
				count++
			}
		}
		if count > limit {
			return count
		}
	}
	return count
}

func normalizeElements(visits []graphVisit, semanticRoles semanticRoleIndex) elements {
	result := elements{
		Nodes:       make([]nodeElement, 0),
		Edges:       make([]edgeElement, 0),
		Groups:      make([]groupElement, 0),
		Hierarchies: make([]hierarchyElement, 0),
	}
	for _, visit := range visits {
		for _, object := range visit.graph.Objects {
			if isGroup(object) || hasSemanticRole(visit, object, semanticRoles) {
				result.Groups = append(result.Groups, normalizeGroup(visit, object, semanticRoles))
			} else {
				result.Nodes = append(result.Nodes, normalizeNode(visit, object))
			}
			if hasElementParent(object) {
				parentID := elementID(visit.board, object.Parent.AbsID())
				childID := elementID(visit.board, object.AbsID())
				result.Hierarchies = append(result.Hierarchies, hierarchyElement{
					ID:         hierarchyID(visit.board, parentID, childID),
					Parent:     parentID,
					Child:      childID,
					Label:      "contains",
					Board:      visit.board,
					ParentPath: objectPathSegments(object.Parent),
					ChildPath:  objectPathSegments(object),
					Range:      objectRange(object),
				})
			}
		}
		for _, edge := range visit.graph.Edges {
			result.Edges = append(result.Edges, normalizeEdge(visit, edge))
		}
	}
	return result
}

func normalizeNode(visit graphVisit, object *d2graph.Object) nodeElement {
	parent := elementParentID(visit, object)
	return nodeElement{
		ID:        elementID(visit.board, object.AbsID()),
		Label:     objectLabel(object),
		Shape:     object.Shape.Value,
		ClassKeys: copyClassKeys(object.Classes),
		Style:     normalizeStyle(object.Style),
		Group:     parent,
		Parent:    parent,
		Href:      scalarValue(object.Link),
		Tooltip:   scalarValue(object.Tooltip),
		Board:     visit.board,
		Path:      objectPathSegments(object),
		Range:     objectRange(object),
	}
}

func normalizeGroup(visit graphVisit, object *d2graph.Object, semanticRoles semanticRoleIndex) groupElement {
	children := make([]string, 0, len(object.ChildrenArray))
	for _, child := range object.ChildrenArray {
		children = append(children, elementID(visit.board, child.AbsID()))
	}
	suggestedRole, semanticReason := suggestedContainerRole(object)
	selectedRole := ""
	if entry, ok := semanticRoles[elementID(visit.board, object.AbsID())]; ok {
		selectedRole = entry.Role
	}
	return groupElement{
		ID:             elementID(visit.board, object.AbsID()),
		Label:          objectLabel(object),
		Shape:          object.Shape.Value,
		ClassKeys:      copyClassKeys(object.Classes),
		Style:          normalizeStyle(object.Style),
		Parent:         elementParentID(visit, object),
		Children:       children,
		SuggestedRole:  suggestedRole,
		SelectedRole:   selectedRole,
		SemanticReason: semanticReason,
		Href:           scalarValue(object.Link),
		Tooltip:        scalarValue(object.Tooltip),
		Board:          visit.board,
		Path:           objectPathSegments(object),
		Range:          objectRange(object),
	}
}

func normalizeEdge(visit graphVisit, edge *d2graph.Edge) edgeElement {
	return edgeElement{
		ID:          elementID(visit.board, edge.AbsID()),
		Source:      elementID(visit.board, edge.Src.AbsID()),
		Target:      elementID(visit.board, edge.Dst.AbsID()),
		Label:       edge.Label.Value,
		Kind:        "connection",
		Direction:   edge.ArrowString(),
		SourceArrow: edge.SrcArrow,
		TargetArrow: edge.DstArrow,
		ClassKeys:   copyClassKeys(edge.Classes),
		Style:       normalizeStyle(edge.Style),
		Href:        scalarValue(edge.Link),
		Tooltip:     scalarValue(edge.Tooltip),
		Board:       visit.board,
		SourcePath:  objectPathSegments(edge.Src),
		TargetPath:  objectPathSegments(edge.Dst),
		Range:       edgeRange(edge),
	}
}

func suggestedContainerRole(object *d2graph.Object) (string, string) {
	if object == nil || len(object.ChildrenArray) == 0 {
		return "group", "container has no child shapes"
	}
	for _, child := range object.ChildrenArray {
		if len(child.ChildrenArray) != 0 {
			return "group", "container includes nested containers"
		}
	}
	for _, edge := range object.Graph.Edges {
		sourceInside := isDescendantOf(edge.Src, object)
		targetInside := isDescendantOf(edge.Dst, object)
		if sourceInside != targetInside {
			return "group", "container has a connection crossing its boundary"
		}
	}
	return "composite", "container contains only leaf shapes and has no boundary-crossing connections"
}

func isDescendantOf(candidate *d2graph.Object, ancestor *d2graph.Object) bool {
	for current := candidate; current != nil; current = current.Parent {
		if current == ancestor {
			return true
		}
	}
	return false
}

func normalizeStyle(style d2graph.Style) map[string]string {
	result := make(map[string]string)
	add := func(name string, value *d2graph.Scalar) {
		if value != nil && value.Value != "" {
			result[name] = value.Value
		}
	}
	add("opacity", style.Opacity)
	add("stroke", style.Stroke)
	add("fill", style.Fill)
	add("fill-pattern", style.FillPattern)
	add("stroke-width", style.StrokeWidth)
	add("stroke-dash", style.StrokeDash)
	add("border-radius", style.BorderRadius)
	add("shadow", style.Shadow)
	add("3d", style.ThreeDee)
	add("multiple", style.Multiple)
	add("font", style.Font)
	add("font-size", style.FontSize)
	add("font-color", style.FontColor)
	add("animated", style.Animated)
	add("bold", style.Bold)
	add("italic", style.Italic)
	add("underline", style.Underline)
	add("filled", style.Filled)
	add("double-border", style.DoubleBorder)
	add("text-transform", style.TextTransform)
	if len(result) == 0 {
		return nil
	}
	return result
}

func templateForElements(value elements) templateHints {
	result := templateHints{
		NodeMappings:      make([]mappingHint, 0),
		EdgeMappings:      make([]mappingHint, 0),
		GroupMappings:     make([]mappingHint, 0),
		HierarchyMappings: make([]mappingHint, 0),
	}
	if len(value.Nodes) != 0 {
		result.NodeMappings = append(result.NodeMappings, mappingHint{
			From:          "nodes",
			LabelTemplate: "${label}",
			Fields: map[string]string{
				"id":       "id",
				"label":    "label",
				"group":    "group",
				"parent":   "parent",
				"nodeType": "shape",
				"href":     "href",
			},
		})
	}
	if len(value.Edges) != 0 {
		result.EdgeMappings = append(result.EdgeMappings, mappingHint{
			From:          "edges",
			Type:          "generic",
			LabelTemplate: "${label}",
			Fields: map[string]string{
				"source":        "source",
				"target":        "target",
				"label":         "label",
				"edgeType":      "kind",
				"edgeDirection": "direction",
			},
		})
	}
	if len(value.Groups) != 0 {
		result.GroupMappings = append(result.GroupMappings, mappingHint{
			From:          "groups",
			LabelTemplate: "${label}",
			Fields: map[string]string{
				"id":     "id",
				"label":  "label",
				"parent": "parent",
			},
		})
	}
	if len(value.Hierarchies) != 0 {
		result.HierarchyMappings = append(result.HierarchyMappings, mappingHint{
			From:          "hierarchies",
			LabelTemplate: "${label}",
			Fields: map[string]string{
				"parent": "parent",
				"child":  "child",
				"label":  "label",
			},
		})
	}
	return result
}

func isGroup(object *d2graph.Object) bool {
	return len(object.ChildrenArray) != 0
}

func hasSemanticRole(visit graphVisit, object *d2graph.Object, roles semanticRoleIndex) bool {
	if object == nil {
		return false
	}
	_, ok := roles[elementID(visit.board, object.AbsID())]
	return ok
}

func hasElementParent(object *d2graph.Object) bool {
	return object.Parent != nil && object.Parent != object.Graph.Root
}

func objectPathSegments(object *d2graph.Object) []string {
	if object == nil {
		return []string{}
	}
	result := make([]string, 0, 4)
	for current := object; current != nil && current != current.Graph.Root; current = current.Parent {
		result = append(result, current.IDVal)
	}
	for left, right := 0, len(result)-1; left < right; left, right = left+1, right-1 {
		result[left], result[right] = result[right], result[left]
	}
	return result
}

func elementParentID(visit graphVisit, object *d2graph.Object) string {
	if !hasElementParent(object) {
		return ""
	}
	return elementID(visit.board, object.Parent.AbsID())
}

func elementID(board string, id string) string {
	if board == "" {
		return id
	}
	return board + "::" + id
}

func hierarchyID(board string, parent string, child string) string {
	sum := sha256.Sum256([]byte(board + "\x00" + parent + "\x00" + child))
	return "hierarchy-" + hex.EncodeToString(sum[:8])
}

func objectLabel(object *d2graph.Object) string {
	if object.Label.Value != "" {
		return object.Label.Value
	}
	return object.IDVal
}

func scalarValue(value *d2graph.Scalar) string {
	if value == nil {
		return ""
	}
	return value.Value
}

func copyClassKeys(values []string) []string {
	if len(values) == 0 {
		return make([]string, 0)
	}
	return append([]string(nil), values...)
}

func objectRange(object *d2graph.Object) *sourceRange {
	for _, reference := range object.References {
		if reference.MapKey != nil {
			return rangeFromD2(reference.MapKey.GetRange())
		}
		if reference.Key != nil {
			return rangeFromD2(reference.Key.GetRange())
		}
	}
	return nil
}

func edgeRange(edge *d2graph.Edge) *sourceRange {
	for _, reference := range edge.References {
		if reference.Edge != nil {
			return rangeFromD2(reference.Edge.GetRange())
		}
		if reference.MapKey != nil {
			return rangeFromD2(reference.MapKey.GetRange())
		}
	}
	return nil
}
