"""Validate owned and consumed OpenAPI documents against the AA flow registry."""

from __future__ import annotations

import argparse
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
