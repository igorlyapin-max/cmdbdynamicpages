"""Offline OpenAPI contracts for optional generic D2 edge aggregation."""

from __future__ import annotations

from copy import deepcopy
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

from jsonschema import Draft4Validator

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
from aa_contracts import read_spec, references, runtime_input_limits, validate_input_contracts  # noqa: E402

AGGREGATION_REF = "#/components/schemas/DiagramEdgeAggregation"
CONNECTION_SCHEMAS = (
    "DiagramImportRelationRule",
    "AssistantD2BindingConnection",
    "AssistantD2StructuralConnection",
)


class EdgeAggregationContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.document = read_spec(ROOT / "aa/openapi.yaml")
        references(cls.document, cls.document)
        cls.schemas = cls.document["components"]["schemas"]

    def validator(self, name: str = "DiagramEdgeAggregation") -> Draft4Validator:
        schema = {
            "$ref": f"#/components/schemas/{name}",
            "components": {"schemas": self.schemas},
        }
        Draft4Validator.check_schema(schema)
        return Draft4Validator(schema)

    def assert_contract(self, payload: object, name: str = "DiagramEdgeAggregation") -> None:
        errors = list(self.validator(name).iter_errors(payload))
        self.assertEqual([], [f"{list(error.path)}: {error.message}" for error in errors])

    def assert_rejected(self, payload: object, keyword: str) -> None:
        errors = list(self.validator().iter_errors(payload))
        self.assertTrue(any(error.validator == keyword for error in errors), errors)

    def test_closed_schema_has_only_the_five_optional_properties(self) -> None:
        schema = self.schemas["DiagramEdgeAggregation"]
        self.assertEqual("object", schema["type"])
        self.assertIs(False, schema["additionalProperties"])
        self.assertEqual(set(), set(schema.get("required", [])))
        self.assertEqual(
            {"enabled", "groupBy", "format", "duplicates", "maxLabelChars"},
            set(schema["properties"]),
        )
        self.assert_contract({})
        for payload in (None, [], "", False):
            with self.subTest(payload=payload):
                self.assert_rejected(payload, "type")

    def test_documented_defaults_are_valid(self) -> None:
        defaults = {
            key: value["default"]
            for key, value in self.schemas["DiagramEdgeAggregation"]["properties"].items()
        }
        self.assertEqual({
            "enabled": False, "groupBy": [], "format": "compact",
            "duplicates": "distinct", "maxLabelChars": 2000,
        }, defaults)
        self.assert_contract(defaults)

    def test_enabled_requires_a_boolean(self) -> None:
        for enabled in (False, True):
            self.assert_contract({"enabled": enabled})
        for enabled in (0, 1, "false", None):
            with self.subTest(enabled=enabled):
                self.assert_rejected({"enabled": enabled}, "type")

    def test_group_by_accepts_empty_and_32_fields_but_rejects_33_without_clamp(self) -> None:
        schema = self.schemas["DiagramEdgeAggregation"]["properties"]["groupBy"]
        self.assertEqual(32, schema["maxItems"])
        self.assertEqual("edge-aggregation-group-by", schema["x-input-collection-policy"])
        self.assertEqual(32, self.document["x-input-collection-limits"]["edge-aggregation-group-by"])
        self.assert_contract({"enabled": True, "groupBy": []})
        self.assert_contract({"groupBy": [f"Field{index}" for index in range(32)]})
        for group_by in ([f"Field{index}" for index in range(33)], ["SameField"] * 33):
            with self.subTest(group_by=group_by):
                self.assert_rejected({"groupBy": group_by}, "maxItems")

    def test_group_by_requires_nonempty_string_fields(self) -> None:
        self.assert_contract({"groupBy": ["Protocol", "Selection 2.Environment", "primary.Code"]})
        for group_by, keyword in (
            ("Protocol", "type"), ({}, "type"), ([1], "type"),
            ([None], "type"), ([""], "minLength"), (["  "], "pattern"),
        ):
            with self.subTest(group_by=group_by):
                self.assert_rejected({"groupBy": group_by}, keyword)

    def test_format_and_duplicate_enums_are_exact(self) -> None:
        properties = self.schemas["DiagramEdgeAggregation"]["properties"]
        self.assertEqual(["compact", "tree"], properties["format"]["enum"])
        self.assertEqual(["distinct", "preserve"], properties["duplicates"]["enum"])
        for format_ in ("compact", "tree"):
            for duplicates in ("distinct", "preserve"):
                self.assert_contract({"format": format_, "duplicates": duplicates})
        for key in ("format", "duplicates"):
            for value in ("", "unsupported", None, True):
                with self.subTest(key=key, value=value):
                    self.assert_rejected({key: value}, "enum")

    def test_label_char_bounds_are_inclusive_and_require_an_integer(self) -> None:
        schema = self.schemas["DiagramEdgeAggregation"]["properties"]["maxLabelChars"]
        self.assertEqual(("integer", 64, 20000, 2000), (
            schema["type"], schema["minimum"], schema["maximum"], schema["default"],
        ))
        for value in (64, 2000, 20000):
            self.assert_contract({"maxLabelChars": value})
        for value, keyword in (
            (63, "minimum"), (0, "minimum"), (-1, "minimum"),
            (20001, "maximum"), (64.5, "type"), ("2000", "type"),
            (True, "type"), (None, "type"),
        ):
            with self.subTest(value=value):
                self.assert_rejected({"maxLabelChars": value}, keyword)

    def test_second_label_template_and_unknown_options_are_rejected(self) -> None:
        for key in ("labelTemplate", "labelField", "leafLabelTemplate", "unknown"):
            with self.subTest(key=key):
                self.assert_rejected({"enabled": True, key: "${Description}"}, "additionalProperties")

    def test_all_three_connection_refs_remain_optional(self) -> None:
        for name in CONNECTION_SCHEMAS:
            with self.subTest(schema=name):
                schema = self.schemas[name]
                self.assertEqual({"$ref": AGGREGATION_REF}, schema["properties"]["aggregation"])
                self.assertNotIn("aggregation", schema.get("required", []))

    def test_optional_aggregation_validates_through_each_connection_reference(self) -> None:
        connection = {
            "d2ElementKey": "source -> target", "d2ClassKey": "dependency",
            "sourceStageId": "selection:dependencies", "mode": "deterministicEndpoints",
            "sourceField": "SourceId", "targetField": "TargetId",
            "sourceOperator": "equals", "targetOperator": "equals",
            "labelTemplate": "${Operation}", "endpointScopeStructureItemId": "",
        }
        structural = {
            "d2ElementKey": "source -> target", "d2ClassKey": "dependency",
            "connectionNotes": "", "directionPolicy": "dataFields",
            "supportedModes": ["deterministicEndpoints"], "exampleLabels": [],
        }
        for name in CONNECTION_SCHEMAS:
            base = structural if name == "AssistantD2StructuralConnection" else connection
            for aggregation in ({}, {"enabled": True, "groupBy": []}, {
                "enabled": True, "groupBy": ["Team", "Environment"],
                "format": "tree", "duplicates": "preserve", "maxLabelChars": 2000,
            }):
                with self.subTest(schema=name, aggregation=aggregation):
                    self.assert_contract(base, name)
                    self.assert_contract({**base, "aggregation": aggregation}, name)
            payload = {**base, "aggregation": {"groupBy": ["Field"] * 33}}
            self.assertTrue(any(
                error.validator == "maxItems" and list(error.path) == ["aggregation", "groupBy"]
                for error in self.validator(name).iter_errors(payload)
            ))

    def test_optional_properties_do_not_bump_or_change_model_versions(self) -> None:
        for name, kind, version, fields in (
            ("AssistantD2StructuralModel", "D2StructuralModel", 1, {"roles": [], "placements": [], "connections": []}),
            ("AssistantD2BindingModel", "D2BindingModel", 2, {"placements": [], "connections": []}),
        ):
            with self.subTest(schema=name):
                self.assertEqual([version], self.schemas[name]["properties"]["version"]["enum"])
                payload = {"kind": kind, "version": version, "modelHash": "a" * 64, **fields}
                self.assert_contract(payload, name)
                changed = deepcopy(payload)
                changed["version"] = version + 1
                self.assertFalse(self.validator(name).is_valid(changed))

    def test_input_contracts_use_the_fixed_runtime_literal(self) -> None:
        limits = runtime_input_limits()
        self.assertEqual(32, limits["edge-aggregation-group-by"])
        self.assertEqual(limits, self.document["x-input-collection-limits"])
        self.assertGreater(validate_input_contracts(self.document, limits), 0)

    def test_missing_or_invalid_schema_safety_cap_fails_closed(self) -> None:
        for maximum in (None, True, "32", 0, -1, 31, 33, 50000):
            with self.subTest(maximum=maximum):
                document = deepcopy(self.document)
                group_by = document["components"]["schemas"]["DiagramEdgeAggregation"]["properties"]["groupBy"]
                if maximum is None:
                    del group_by["maxItems"]
                else:
                    group_by["maxItems"] = maximum
                with self.assertRaisesRegex(ValueError, "maxItems must equal runtime absolute limit 32"):
                    validate_input_contracts(document)

    def test_missing_or_unknown_collection_policy_is_not_a_limit_bypass(self) -> None:
        for policy, message in (
            (None, "maxItems must equal runtime absolute limit 50000"),
            ("unsupported", "unknown input collection policy: unsupported"),
        ):
            with self.subTest(policy=policy):
                document = deepcopy(self.document)
                group_by = document["components"]["schemas"]["DiagramEdgeAggregation"]["properties"]["groupBy"]
                if policy is None:
                    del group_by["x-input-collection-policy"]
                else:
                    group_by["x-input-collection-policy"] = policy
                with self.assertRaisesRegex(ValueError, message):
                    validate_input_contracts(document)

    def test_aggregation_policy_cannot_change_an_unrelated_request_collection_cap(self) -> None:
        document = deepcopy(self.document)
        rules = document["components"]["schemas"]["ObjectFlowSelectionStage"]["properties"]["rules"]
        rules["maxItems"] = 32
        with self.assertRaisesRegex(ValueError, "maxItems must equal runtime absolute limit 50000"):
            validate_input_contracts(document)
        rules["x-input-collection-policy"] = "edge-aggregation-group-by"
        with self.assertRaisesRegex(ValueError, "policy is only allowed on DiagramEdgeAggregation.groupBy"):
            validate_input_contracts(document)

    def test_aggregation_schema_requires_consistent_bounds_and_description(self) -> None:
        for key, value, message in (
            ("minItems", 33, "invalid minItems/maxItems bounds"),
            ("description", "", "missing configured/default limit description"),
        ):
            with self.subTest(property=key):
                document = deepcopy(self.document)
                document["components"]["schemas"]["DiagramEdgeAggregation"]["properties"]["groupBy"][key] = value
                with self.assertRaisesRegex(ValueError, message):
                    validate_input_contracts(document)

    def test_runtime_literal_drift_and_missing_literal_are_rejected_without_backend_import(self) -> None:
        source = (ROOT / "scripts/input-collection-limits.mjs").read_text(encoding="utf-8")
        literal = "aggregation: { groupBy: ['leaf', 32] }"
        self.assertIn(literal, source)
        with tempfile.TemporaryDirectory() as temporary:
            module = Path(temporary) / "limits.mjs"
            module.write_text(source.replace(literal, "aggregation: { groupBy: ['leaf', 33] }", 1), encoding="utf-8")
            limits = runtime_input_limits(module)
            self.assertEqual(33, limits["edge-aggregation-group-by"])
            with self.assertRaisesRegex(ValueError, "differ from runtime literals"):
                validate_input_contracts(self.document, limits)
            module.write_text(source.replace(literal, "aggregation: {}", 1), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "missing runtime literal contract: edge-aggregation-group-by"):
                runtime_input_limits(module)

    def test_existing_openapi_validator_accepts_the_document(self) -> None:
        result = subprocess.run(
            [shutil.which("node") or "node", str(ROOT / "scripts/validate-openapi.mjs")],
            cwd=ROOT, text=True, capture_output=True, timeout=30, check=False,
        )
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
