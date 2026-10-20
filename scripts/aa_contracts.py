"""Validate owned and consumed OpenAPI documents against the AA flow registry."""

from __future__ import annotations

import argparse
from collections.abc import Iterator
from pathlib import Path
import re

import yaml


ROOT = Path(__file__).resolve().parents[1]
METHODS = {"get", "post", "put", "patch", "delete", "head", "options"}
FLOW = re.compile(r"(?:OAPI|AAPI|IF|L|M|H)(?:0|[1-9][0-9]*)\Z")
SPECS = ["aa/openapi.yaml", "aa/openapi/cmdbuild-consumed.openapi.yaml", "aa/openapi/litellm-consumed.openapi.yaml"]


class UniqueLoader(yaml.SafeLoader):
    pass


def unique_mapping(loader: UniqueLoader, node: yaml.MappingNode, deep: bool = False) -> dict:
    result = {}
    for key_node, value_node in node.value:
        key = loader.construct_object(key_node, deep=deep)
        if key in result:
            raise ValueError(f"duplicate YAML key: {key}")
        result[key] = loader.construct_object(value_node, deep=deep)
    return result


UniqueLoader.add_constructor(yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, unique_mapping)


def read_spec(path: Path) -> dict:
    value = yaml.load(path.read_text(encoding="utf-8"), Loader=UniqueLoader)
    if not isinstance(value, dict) or value.get("openapi") != "3.0.3":
        raise ValueError(f"{path}: expected OpenAPI 3.0.3 object")
    return value


def references(value: object, document: dict) -> None:
    if isinstance(value, dict):
        ref = value.get("$ref")
        if ref:
            if not isinstance(ref, str) or not ref.startswith("#/"):
                raise ValueError(f"only local OpenAPI refs allowed: {ref}")
            target = document
            for part in ref[2:].split("/"):
                part = part.replace("~1", "/").replace("~0", "~")
                if not isinstance(target, dict) or part not in target:
                    raise ValueError(f"unresolved OpenAPI ref: {ref}")
                target = target[part]
        for item in value.values():
            references(item, document)
    elif isinstance(value, list):
        for item in value:
            references(item, document)


def operations(document: dict):
    for path, item in document.get("paths", {}).items():
        for method, operation in item.items():
            if method in METHODS:
                yield path, method, operation


def local_reference(ref: str, document: dict) -> dict:
    target = document
    for part in ref[2:].split("/"):
        part = part.replace("~1", "/").replace("~0", "~")
        if not isinstance(target, dict) or part not in target:
            raise ValueError(f"unresolved OpenAPI ref: {ref}")
        target = target[part]
    if not isinstance(target, dict):
        raise ValueError(f"OpenAPI ref is not an object: {ref}")
    return target


def request_schemas(document: dict) -> Iterator[tuple[str, str, str, dict]]:
    """Walk schema keywords only, from request bodies, without following responses."""
    def walk(schema: object, location: str, active: frozenset[str]) -> Iterator[tuple[str, dict]]:
        if not isinstance(schema, dict):
            return
        ref = schema.get("$ref")
        if ref:
            if isinstance(ref, str) and ref.startswith("#/") and ref not in active:
                yield from walk(local_reference(ref, document), ref, active | {ref})
            return
        yield location, schema
        if schema.get("x-input-collection-policy") == "output-data":
            return
        for key, child in schema.get("properties", {}).items():
            yield from walk(child, f"{location}/properties/{key}", active)
        for key in ("items", "additionalProperties"):
            yield from walk(schema.get(key), f"{location}/{key}", active)
        for key in ("allOf", "oneOf", "anyOf"):
            for index, child in enumerate(schema.get(key, [])):
                yield from walk(child, f"{location}/{key}/{index}", active)

    for path, method, operation in operations(document):
        body = operation.get("requestBody", {})
        active = frozenset()
        while isinstance(body, dict) and "$ref" in body:
            ref = body["$ref"]
            if not isinstance(ref, str) or not ref.startswith("#/") or ref in active:
                body = {}
                break
            active |= {ref}
            body = local_reference(ref, document)
        for media, content in body.get("content", {}).items():
            for location, schema in walk(content.get("schema"), f"{method.upper()} {path}/{media}", active):
                yield path, method, location, schema


def runtime_input_limits(module: Path | None = None) -> dict:
    """Read literal contracts, never import the backend or execute JavaScript."""
    source = (module or Path(__file__).with_name("input-collection-limits.mjs")).read_text(encoding="utf-8")
    values = {}
    for kind in ("DEFAULT", "ABSOLUTE"):
        name = f"INPUT_COLLECTION_{kind}_LIMITS"
        match = re.search(rf"export const {name} = Object\.freeze\(\{{([^{{}}]+)\}}\);", source)
        if not match:
            raise ValueError(f"missing runtime literal contract: {name}")
        entries = re.findall(r"([A-Za-z][A-Za-z0-9]*):\s*([0-9][0-9_]*)\s*(?:,|$)", match[1].strip())
        values[kind] = {key: int(value.replace("_", "")) for key, value in entries}
        if len(entries) != 3 or set(values[kind]) != {"maxCollectionItems", "maxTotalItems", "d2MaxElements"}:
            raise ValueError(f"invalid runtime literal contract: {name}")
    limits = {}
    for policy, key, configuration in (
        ("collection", "maxCollectionItems", "CMDP_INPUT_MAX_COLLECTION_ITEMS"),
        ("total", "maxTotalItems", "CMDP_INPUT_MAX_TOTAL_ITEMS"),
        ("d2", "d2MaxElements", "CMDP_D2_IMPORT_MAX_ELEMENTS"),
    ):
        default, absolute = values["DEFAULT"][key], values["ABSOLUTE"][key]
        if not 0 < default <= absolute:
            raise ValueError(f"invalid runtime limits: {key}")
        limits[policy] = {"configuration": configuration, "default": default, "absolute": absolute}
    for policy, kind, field in (
        ("business-blocks", "intent", "blocks"),
        ("block-uses", "intentBlock", "uses"),
        ("edge-aggregation-group-by", "aggregation", "groupBy"),
    ):
        match = re.search(rf"\b{kind}:\s*\{{\s*{field}:\s*\['[A-Za-z]+',\s*([0-9]+)\]", source)
        if not match:
            raise ValueError(f"missing runtime literal contract: {policy}")
        limits[policy] = int(match[1])
    return limits


def schema_references(value: object, document: dict, target: str, active: frozenset[str] = frozenset()) -> bool:
    if not isinstance(value, dict):
        return False
    ref = value.get("$ref")
    if ref == target:
        return True
    if isinstance(ref, str) and ref.startswith("#/") and ref not in active:
        return schema_references(local_reference(ref, document), document, target, active | {ref})
    return any(
        schema_references(child, document, target, active)
        for key, children in value.items()
        if key in {"content", "schema", "allOf", "oneOf", "anyOf", "application/json"}
        for child in (children if isinstance(children, list) else [children])
    )


def validate_input_contracts(document: dict, limits: dict | None = None) -> int:
    limits = runtime_input_limits() if limits is None else limits
    if document.get("x-input-collection-limits") != limits:
        raise ValueError("input collection defaults/absolute limits differ from runtime literals")
    schemas = document.get("components", {}).get("schemas", {})
    if "AssistantEditorDelta" in schemas:
        params = schemas["AssistantEditorDelta"]["properties"]["spec"]["properties"]["params"]
        if params.get("type") != "object" or "items" in params:
            raise ValueError("AssistantEditorDelta.spec.params must be an object")
    if "AssistantObjectFlowIntent" in schemas:
        block = schemas["AssistantObjectFlowIntent"]["properties"]["blocks"]["items"]
        if "uses" not in block.get("required", []) or "dependsOn" in block.get("properties", {}):
            raise ValueError("AssistantObjectFlowIntent requires canonical uses, not dependsOn")
    bounded_operations = set()
    arrays = set()
    for path, method, location, schema in request_schemas(document):
        policy = schema.get("x-input-collection-policy")
        if policy == "full-spec":
            if schema.get("type") != "object":
                raise ValueError(f"{location}: full-spec policy requires an object")
            bounded_operations.add((path, method))
        if location.endswith(("/properties/currentSpec", "/properties/spec")) and schema.get("additionalProperties") is True:
            if policy != "full-spec":
                raise ValueError(f"{location}: opaque spec missing x-input-collection-policy: full-spec")
        if schema.get("type") != "array" or policy == "output-data":
            continue
        if policy not in (None, "collection", "d2", "business-blocks", "block-uses", "edge-aggregation-group-by"):
            raise ValueError(f"{location}: unknown input collection policy: {policy}")
        if policy == "edge-aggregation-group-by" and location != "#/components/schemas/DiagramEdgeAggregation/properties/groupBy":
            raise ValueError(f"{location}: edge-aggregation-group-by policy is only allowed on DiagramEdgeAggregation.groupBy")
        bound = limits[policy] if policy in ("business-blocks", "block-uses", "edge-aggregation-group-by") else limits[policy or "collection"]["absolute"]
        maximum = schema.get("maxItems")
        if type(maximum) is not int or maximum != bound:
            raise ValueError(f"{location}: maxItems must equal runtime absolute limit {bound}")
        minimum = schema.get("minItems", 0)
        if type(minimum) is not int or not 0 <= minimum <= maximum:
            raise ValueError(f"{location}: invalid minItems/maxItems bounds")
        if not schema.get("description"):
            raise ValueError(f"{location}: missing configured/default limit description")
        arrays.add(location)
        bounded_operations.add((path, method))
    for path, method in bounded_operations:
        response = document["paths"][path][method].get("responses", {}).get("413", {})
        if not schema_references(response, document, "#/components/schemas/InputCollectionLimitError"):
            raise ValueError(f"{method.upper()} {path}: missing 413 InputCollectionLimit contract")
    return len(arrays)


def registry(root: Path) -> dict[str, str]:
    text = (root / "aa/information-model.md").read_text(encoding="utf-8")
    return {match[1]: match[0] for match in re.finditer(r"^\| ((?:OAPI|AAPI|IF|L|M|H)[0-9]+) \|.*$", text, re.M)}


def validate(root: Path) -> int:
    flows = registry(root)
    uses: dict[str, list[str]] = {}
    count = 0
    for name in SPECS:
        document = read_spec(root / name)
        references(document, document)
        if name == "aa/openapi.yaml":
            validate_input_contracts(document)
        if not document.get("servers"):
            raise ValueError(f"{name}: missing servers/port contract")
        for path, method, operation in operations(document):
            context = f"{name}: {method.upper()} {path}"
            flow = operation.get("x-flow-id", "")
            if not FLOW.fullmatch(flow) or flow not in flows:
                raise ValueError(f"{context}: invalid or undeclared x-flow-id {flow}")
            if f"{method.upper()} {path}" not in flows[flow]:
                raise ValueError(f"{context}: registry channel differs for {flow}")
            expected = "H" if re.search(r"/health/(live|ready|redis)$", path) else "M" if path == "/metrics" else "L" if path.endswith(("/client-log", "/proxy-log")) else "OAPI"
            if not re.fullmatch(expected + r"(?:0|[1-9][0-9]*)", flow):
                raise ValueError(f"{context}: flow category must be {expected}")
            if not operation.get("summary") or not operation.get("responses"):
                raise ValueError(f"{context}: missing summary/responses")
            if "security" not in operation and "security" not in document:
                raise ValueError(f"{context}: authentication boundary is unspecified")
            rejected_method = path == "/cmdbuild/custom-api/client-log" and method == "post" and "405" in operation["responses"]
            if not rejected_method and not any(str(status).startswith(("2", "3")) for status in operation["responses"]):
                raise ValueError(f"{context}: no successful response")
            uses.setdefault(flow, []).append(context)
            count += 1
    for flow, contexts in uses.items():
        if flow.startswith("OAPI") and len(contexts) != 1:
            raise ValueError(f"{flow}: multiple unrelated API operations")
    missing = {key for key in flows if key.startswith("OAPI")} - uses.keys()
    if missing:
        raise ValueError(f"registry operations without OpenAPI: {sorted(missing)}")
    return count


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=ROOT)
    parser.add_argument("--inventory", action="store_true")
    args = parser.parse_args()
    try:
        if args.inventory:
            for name in SPECS:
                for path, method, operation in operations(read_spec(args.root / name)):
                    print(f"{operation.get('x-flow-id', '')}\t{method.upper()} {path}\t{operation.get('summary', '')}\t{name}")
        else:
            print(f"OK OpenAPI/flow contracts: {validate(args.root)} operations")
    except (ValueError, KeyError, OSError, yaml.YAMLError) as error:
        parser.exit(1, f"AA API error: {error}\n")


if __name__ == "__main__":
    main()
