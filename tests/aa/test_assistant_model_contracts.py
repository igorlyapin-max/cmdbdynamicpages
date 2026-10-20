"""Validate real offline backend model payloads, not a second set of fixtures."""

from __future__ import annotations

from copy import deepcopy
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import unittest

from jsonschema import Draft4Validator

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
from aa_contracts import read_spec, references  # noqa: E402


def nullable_schema(value: object) -> object:
    """Adapt OAS 3.0 nullable to JSON Schema; Draft4 handles all other used keywords."""
    if isinstance(value, list):
        return [nullable_schema(item) for item in value]
    if not isinstance(value, dict):
        return value
    result = {key: nullable_schema(item) for key, item in value.items() if key != "nullable"}
    if value.get("nullable"):
        if isinstance(result.get("type"), str):
            result["type"] = [result["type"], "null"]
        else:
            return {"anyOf": [result, {"type": "null"}]}
    return result


class AssistantModelContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.document = read_spec(ROOT / "aa/openapi.yaml")
        # Fail before creating validators if a reference could trigger network IO.
        references(cls.document, cls.document)
        cls.schemas = nullable_schema(cls.document["components"]["schemas"])
        result = subprocess.run(
            [shutil.which("node") or "node", str(ROOT / "tests/aa/assistant_models_fixture.mjs")],
            cwd=ROOT,
            env={"PATH": os.environ.get("PATH", os.defpath), "NODE_ENV": "test",
                 "CMDP_LOG_LEVEL": "silent", "CMDBDYNAMIC_REDIS_ENABLED": "false"},
            text=True, capture_output=True, check=True, timeout=30,
        )
        cls.payloads = json.loads(result.stdout)

    def validator(self, name: str) -> Draft4Validator:
        schema = {"$ref": f"#/components/schemas/{name}", "components": {"schemas": self.schemas}}
        Draft4Validator.check_schema(schema)
        return Draft4Validator(schema)

    def assert_contract(self, name: str, payload: object) -> None:
        errors = list(self.validator(name).iter_errors(payload))
        self.assertEqual([], [f"{list(error.path)}: {error.message}" for error in errors])

    def test_actual_model_builders_and_bundles_match_response_contracts(self) -> None:
        for key in ("data", "truncatedData", "missingClassData"):
            with self.subTest(payload=key):
                self.assert_contract("AssistantDataSemanticModel", self.payloads[key])
        self.assert_contract("AssistantD2BindingModel", self.payloads["binding"])
        for key in ("mapping", "interpretation", "emptyMapping", "emptyInterpretation"):
            with self.subTest(payload=key):
                self.assert_contract("AssistantDiagramModels", self.payloads[key])

    def test_typed_fields_and_diagnostics_are_nonempty_and_linked(self) -> None:
        data = self.payloads["data"]
        self.assertEqual(4, data["version"])
        fields = {field["id"]: field for field in data["fieldCatalog"]}
        self.assertTrue(fields)
        self.assertTrue(any(field.get("help") for field in fields.values()))
        self.assertEqual({"reference", "domain"}, {
            hop["kind"] for field in fields.values() for hop in field["hops"]
        })
        self.assertIn("many", {field["cardinality"] for field in fields.values()})
        for stage in data["stages"]:
            self.assertTrue(stage["typedFields"])
            self.assertTrue(stage["rules"])
            self.assertTrue(stage["cardSources"])
            for field in stage["typedFields"]:
                self.assertEqual(field["path"], fields[field["id"]]["path"])
                self.assertEqual(field["rootClass"], fields[field["id"]]["rootClass"])
        self.assertIsNone(data["stages"][0]["relationSource"])
        self.assertTrue(data["stages"][1]["relationSource"]["structuredFields"])
        self.assertTrue(data["stages"][1]["connection"]["sourceField"])
        diagnostics = data["fieldContextDiagnostics"]
        self.assertEqual(len(fields), diagnostics["returnedFields"])
        self.assertGreater(diagnostics["scannedStates"], 0)
        self.assertGreater(diagnostics["bytes"], 0)
        self.assertFalse(diagnostics["truncated"])
        self.assertTrue(self.payloads["truncatedData"]["fieldContextDiagnostics"]["truncated"])
        self.assertEqual(["Unavailable"], self.payloads["missingClassData"]["fieldContextDiagnostics"]["missingClasses"])

    def test_binding_conditions_labels_card_sources_and_endpoint_scope(self) -> None:
        binding = self.payloads["binding"]
        self.assertEqual(2, binding["version"])
        self.assertEqual({}, binding["placements"][0]["conditions"])
        placement = binding["placements"][1]
        self.assertEqual("current", placement["cardSourceId"])
        self.assertEqual("${Code}", placement["labelTemplate"])
        self.assertTrue(placement["conditions"]["rules"])
        self.assertTrue(placement["hierarchyConditions"]["rules"])
        connection = binding["connections"][0]
        self.assertEqual("frame", connection["endpointScopeStructureItemId"])
        self.assertEqual(("SourceId", "TargetId", "equals", "in", "${Description}"), tuple(
            connection[key] for key in ("sourceField", "targetField", "sourceOperator", "targetOperator", "labelTemplate")
        ))

    def test_mapping_bundle_requirement_ledger_and_coverage_are_populated(self) -> None:
        bundle = self.payloads["mapping"]
        ledger, coverage = bundle["requirementLedger"], bundle["requirementCoverage"]
        self.assertEqual(1, ledger["version"])
        self.assertTrue(ledger["warnings"])
        self.assertTrue(any(item.get("overriddenBy") for item in ledger["requirements"]))
        self.assertEqual({"directive", "paragraph"}, {item["kind"] for item in ledger["requirements"]})
        self.assertEqual({"compiled", "unresolved", "conflict"}, {item["status"] for item in coverage["entries"]})
        self.assertEqual({item["id"] for item in ledger["requirements"]}, {item["id"] for item in coverage["entries"]})
        self.assertEqual("source-target-accountability-only", coverage["scope"])
        self.assertIs(False, coverage["semanticProof"])
        self.assertTrue(all(item.get("evidenceRefs") for item in coverage["entries"] if item["status"] == "compiled"))
        self.assertNotIn("requirementLedger", self.payloads["interpretation"])

    def test_unsupported_model_versions_are_rejected(self) -> None:
        for key, schema, versions in (
            ("data", "AssistantDataSemanticModel", (1, 3, 5, "4")),
            ("binding", "AssistantD2BindingModel", (1, 3, "2")),
        ):
            self.assert_contract(schema, self.payloads[key])
            for version in versions:
                with self.subTest(model=key, version=version):
                    payload = deepcopy(self.payloads[key])
                    payload["version"] = version
                    self.assertTrue(any(
                        list(error.path) == ["version"] and error.validator in {"enum", "type"}
                        for error in self.validator(schema).iter_errors(payload)
                    ))

    def test_unknown_keys_are_rejected_in_models_and_nested_contracts(self) -> None:
        self.assert_contract("AssistantDiagramModels", self.payloads["mapping"])
        paths = [
            (), ("dataSemanticModel",), ("dataSemanticModel", "stages", 0),
            ("dataSemanticModel", "stages", 0, "rules", 0),
            ("dataSemanticModel", "stages", 0, "typedFields", 0),
            ("dataSemanticModel", "stages", 0, "cardSources", 0),
            ("dataSemanticModel", "stages", 1, "relationSource"),
            ("dataSemanticModel", "stages", 1, "connection"),
            ("dataSemanticModel", "fieldCatalog", 0),
            ("dataSemanticModel", "fieldContextDiagnostics"),
            ("d2StructuralModel",), ("d2StructuralModel", "roles", 0),
            ("d2StructuralModel", "placements", 0), ("d2StructuralModel", "connections", 0),
            ("d2SemanticModel",), ("d2SemanticModel", "roles", 0),
            ("d2BindingModel",), ("d2BindingModel", "placements", 0), ("d2BindingModel", "connections", 0),
            ("coverageModel",), ("requirementLedger",), ("requirementLedger", "requirements", 0),
            ("requirementLedger", "warnings", 0), ("requirementCoverage",), ("requirementCoverage", "entries", 0),
        ]
        field_index = next(index for index, field in enumerate(self.payloads["data"]["fieldCatalog"]) if field["hops"])
        paths.append(("dataSemanticModel", "fieldCatalog", field_index, "hops", 0))
        entry_index = next(index for index, entry in enumerate(self.payloads["mapping"]["requirementCoverage"]["entries"]) if entry.get("evidenceRefs"))
        paths.append(("requirementCoverage", "entries", entry_index, "evidenceRefs", 0))
        for path in paths:
            with self.subTest(path=path):
                payload = deepcopy(self.payloads["mapping"])
                target = payload
                for part in path:
                    target = target[part]
                target["unsupportedContractKey"] = True
                errors = list(self.validator("AssistantDiagramModels").iter_errors(payload))
                self.assertTrue(any(
                    error.validator == "additionalProperties" and list(error.path) == list(path)
                    for error in errors
                ), [error.message for error in errors])

    def test_missing_required_response_fields_are_rejected(self) -> None:
        self.assert_contract("AssistantDiagramModels", self.payloads["mapping"])
        for path, key in (
            (("dataSemanticModel",), "fieldCatalog"),
            (("dataSemanticModel",), "fieldContextDiagnostics"),
            (("dataSemanticModel", "stages", 0), "typedFields"),
            (("dataSemanticModel", "fieldCatalog", 0), "type"),
            (("dataSemanticModel", "fieldContextDiagnostics"), "truncated"),
            (("d2BindingModel", "placements", 0), "cardSourceId"),
            (("d2BindingModel", "placements", 0), "labelTemplate"),
            (("d2BindingModel", "placements", 0), "conditions"),
            (("d2BindingModel", "connections", 0), "endpointScopeStructureItemId"),
            (("requirementLedger",), "requirements"),
            (("requirementCoverage",), "semanticProof"),
        ):
            with self.subTest(path=path, key=key):
                payload = deepcopy(self.payloads["mapping"])
                target = payload
                for part in path:
                    target = target[part]
                del target[key]
                errors = list(self.validator("AssistantDiagramModels").iter_errors(payload))
                self.assertTrue(any(
                    error.validator == "required" and list(error.path) == list(path)
                    and key in error.message for error in errors
                ), [error.message for error in errors])

    def test_wrong_nested_types_are_rejected(self) -> None:
        self.assert_contract("AssistantDiagramModels", self.payloads["mapping"])
        for path, value in (
            (("dataSemanticModel", "fieldContextDiagnostics", "bytes"), "100"),
            (("dataSemanticModel", "fieldContextDiagnostics", "truncated"), 0),
            (("dataSemanticModel", "fieldCatalog", 0, "type"), {}),
            (("dataSemanticModel", "stages", 0, "typedFields"), {}),
            (("d2BindingModel", "placements", 1, "cardSourceId"), 1),
            (("d2BindingModel", "connections", 0, "endpointScopeStructureItemId"), []),
            (("requirementLedger", "requirements", 0, "start"), "0"),
            (("requirementCoverage", "semanticProof"), True),
            (("requirementCoverage", "entries", 0, "status"), "approved"),
        ):
            with self.subTest(path=path):
                payload = deepcopy(self.payloads["mapping"])
                target = payload
                for part in path[:-1]:
                    target = target[part]
                target[path[-1]] = value
                self.assertTrue(any(
                    list(error.path) == list(path)
                    for error in self.validator("AssistantDiagramModels").iter_errors(payload)
                ))
