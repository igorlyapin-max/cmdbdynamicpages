"""Offline request-only collection contracts, paired with shared runtime literals."""

from copy import deepcopy
from pathlib import Path
import shutil
import sys
import tempfile
import unittest

import yaml

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
from aa_contracts import (  # noqa: E402
    read_spec,
    request_schemas,
    runtime_input_limits,
    schema_references,
    validate,
    validate_input_contracts,
)


class InputContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.document = read_spec(ROOT / "aa/openapi.yaml")
        cls.limits = runtime_input_limits()

    def setUp(self):
        self.spec = deepcopy(self.document)
        self.schemas = self.spec["components"]["schemas"]

    def check_contracts(self):
        return validate_input_contracts(self.spec, self.limits)

    def test_shipped_owned_and_consumed_contracts(self):
        self.assertGreater(validate(ROOT), 0)
        self.assertGreater(self.check_contracts(), 0)

    def test_missing_max_items_in_request_ref_is_detected(self):
        del self.schemas["ObjectFlowSelectionStage"]["properties"]["rules"]["maxItems"]
        with self.assertRaisesRegex(ValueError, "ObjectFlowSelectionStage.*rules: maxItems"):
            self.check_contracts()

    def test_configurable_default_is_not_the_schema_cap(self):
        self.schemas["ObjectFlowProposal"]["properties"]["selections"]["maxItems"] = 5000
        with self.assertRaisesRegex(ValueError, "maxItems must equal runtime absolute limit 50000"):
            self.check_contracts()

    def test_invalid_array_bounds(self):
        for maximum in (True, "50000", 50001, -1):
            with self.subTest(maximum=maximum):
                self.schemas["ObjectFlowProposal"]["properties"]["selections"]["maxItems"] = maximum
                with self.assertRaisesRegex(ValueError, "maxItems"):
                    self.check_contracts()

    def test_minimum_cannot_exceed_absolute_cap(self):
        self.schemas["ObjectFlowProposal"]["properties"]["selections"]["minItems"] = 50001
        with self.assertRaisesRegex(ValueError, "invalid minItems/maxItems"):
            self.check_contracts()

    def test_response_only_arrays_are_not_forced(self):
        before = self.check_contracts()
        self.schemas["RuntimeJsonResult"]["properties"]["tables"]["items"]["properties"]["rows"]["maxItems"] = "not-an-input-bound"
        self.schemas["AssistantObjectFlowPlanResponse"]["properties"]["warnings"]["maxItems"] = -1
        self.assertEqual(self.check_contracts(), before)

    def test_consumed_requests_are_not_subject_to_owned_limits(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            shutil.copytree(ROOT / "aa", root / "aa")
            consumed = root / "aa/openapi/cmdbuild-consumed.openapi.yaml"
            document = read_spec(consumed)
            document["components"]["schemas"]["UnboundedExternalInput"] = {
                "type": "array", "items": {"type": "object"}
            }
            operation = next(
                operation for item in document["paths"].values()
                for method, operation in item.items() if method == "post"
            )
            operation["requestBody"] = {"content": {"application/json": {
                "schema": {"$ref": "#/components/schemas/UnboundedExternalInput"}
            }}}
            consumed.write_text(yaml.safe_dump(document, allow_unicode=True), encoding="utf-8")
            self.assertGreater(validate(root), 0)

    def test_external_refs_are_not_walked_as_owned_schemas(self):
        self.spec["paths"]["/external-fixture"] = {"post": {"requestBody": {
            "content": {"application/json": {"schema": {"$ref": "https://example.invalid/input.yaml#/Input"}}}
        }}}
        self.assertEqual(self.check_contracts(), validate_input_contracts(self.document, self.limits))

    def test_request_body_ref_and_schema_composition_are_followed(self):
        self.spec["components"]["requestBodies"]["StructuralFixture"] = {
            "content": {"application/json": {"schema": {"allOf": [{
                "type": "object", "properties": {"newRules": {"type": "array", "items": {}}}
            }]}}}
        }
        self.spec["paths"]["/request-fixture"] = {"post": {
            "requestBody": {"$ref": "#/components/requestBodies/StructuralFixture"}
        }}
        with self.assertRaisesRegex(ValueError, "newRules: maxItems"):
            self.check_contracts()

    def test_recursive_local_schema_does_not_loop(self):
        self.schemas["ObjectFlowSelectionStage"]["properties"]["nested"] = {
            "$ref": "#/components/schemas/ObjectFlowSelectionStage"
        }
        self.assertGreater(self.check_contracts(), 0)

    def test_opaque_full_spec_requires_explicit_policy(self):
        del self.schemas["TemplatePayload"]["properties"]["spec"]["x-input-collection-policy"]
        with self.assertRaisesRegex(ValueError, "opaque spec missing x-input-collection-policy"):
            self.check_contracts()

    def test_opaque_business_and_literal_data_are_not_invented(self):
        params = self.schemas["AssistantEditorDelta"]["properties"]["spec"]["properties"]["params"]
        self.assertTrue(params["additionalProperties"])
        paths = [location for _, _, location, _ in request_schemas(self.spec)]
        self.assertFalse(any("/params/" in path for path in paths))
        unresolved = self.schemas["DiagramImportProposalEnvelope"]["properties"]["unresolved"]
        self.assertEqual(unresolved["x-input-collection-policy"], "output-data")
        self.assertNotIn("maxItems", unresolved)
        unresolved["items"] = {"type": "array", "items": {}}
        self.assertGreater(self.check_contracts(), 0)

    def test_params_is_object_and_array_regression_is_rejected(self):
        params = self.schemas["AssistantEditorDelta"]["properties"]["spec"]["properties"]["params"]
        self.assertEqual(params["type"], "object")
        params["type"] = "array"
        with self.assertRaisesRegex(ValueError, "params must be an object"):
            self.check_contracts()

    def test_canonical_uses_and_business_caps(self):
        blocks = self.schemas["AssistantObjectFlowIntent"]["properties"]["blocks"]
        self.assertEqual(blocks["maxItems"], self.limits["business-blocks"])
        block = blocks["items"]
        self.assertIn("uses", block["required"])
        self.assertNotIn("dependsOn", block["properties"])
        self.assertEqual(block["properties"]["uses"]["maxItems"], self.limits["block-uses"])
        block["properties"]["dependsOn"] = block["properties"].pop("uses")
        with self.assertRaisesRegex(ValueError, "canonical uses"):
            self.check_contracts()

    def test_set_operation_on_remains_a_string_key(self):
        operation = self.schemas["ObjectFlowSetOperation"]
        self.assertIn("on", operation["required"])
        self.assertEqual(operation["properties"]["on"]["maxItems"], 50000)

    def test_contract_defaults_and_caps_match_shared_runtime_literals(self):
        self.assertEqual(self.spec["x-input-collection-limits"], self.limits)
        for policy, key in (("collection", "default"), ("d2", "absolute"), ("total", "absolute")):
            with self.subTest(policy=policy, key=key):
                self.spec["x-input-collection-limits"] = deepcopy(self.limits)
                self.spec["x-input-collection-limits"][policy][key] += 1
                with self.assertRaisesRegex(ValueError, "differ from runtime literals"):
                    self.check_contracts()

    def test_numeric_separators_in_runtime_literal_contract(self):
        self.assertEqual(self.limits["collection"]["default"], 5000)
        self.assertEqual(self.limits["collection"]["absolute"], 50000)
        self.assertEqual(self.limits["total"]["absolute"], 500000)
        source = (ROOT / "scripts/input-collection-limits.mjs").read_text(encoding="utf-8")
        with tempfile.TemporaryDirectory() as temporary:
            module = Path(temporary) / "limits.mjs"
            module.write_text(source.replace("INPUT_COLLECTION_ABSOLUTE_LIMITS =", "RENAMED_LIMITS =", 1), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "missing runtime literal contract"):
                runtime_input_limits(module)

    def test_runtime_literal_change_is_detected_without_backend_import(self):
        source = (ROOT / "scripts/input-collection-limits.mjs").read_text(encoding="utf-8")
        self.assertIn("maxCollectionItems: 50_000", source)
        with tempfile.TemporaryDirectory() as temporary:
            module = Path(temporary) / "limits.mjs"
            module.write_text(source.replace("maxCollectionItems: 50_000", "maxCollectionItems: 40_000", 1), encoding="utf-8")
            limits = runtime_input_limits(module)
            self.assertEqual(limits["collection"]["absolute"], 40000)
            with self.assertRaisesRegex(ValueError, "differ from runtime literals"):
                validate_input_contracts(self.spec, limits)

    def test_early_413_contract_is_required_through_response_ref(self):
        response = self.spec["paths"]["/cmdbuild/custom-api/templates"]["post"]["responses"].pop("413")
        self.assertEqual(response["$ref"], "#/components/responses/InputCollectionLimit")
        with self.assertRaisesRegex(ValueError, "missing 413 InputCollectionLimit"):
            self.check_contracts()

    def test_early_413_retains_existing_diagram_errors(self):
        response = self.spec["paths"]["/cmdbuild/custom-api/draft/diagram-import/analyze"]["post"]["responses"]["413"]
        for name in ("InputCollectionLimitError", "DiagramImportErrorResponse"):
            self.assertTrue(schema_references(response, self.spec, f"#/components/schemas/{name}"))

    def test_error_schema_matches_safe_runtime_payload(self):
        schema = self.schemas["InputCollectionLimitError"]
        self.assertEqual(set(schema["required"]), {"success", "code", "message", "errors", "limits"})
        self.assertNotIn("requestId", schema["required"])
        self.assertEqual(schema["properties"]["code"]["enum"], ["input_collection_limit"])
        details = schema["properties"]["errors"]["items"]
        self.assertEqual(set(details["required"]), {"path", "actualCount", "limit"})
        limits = schema["properties"]["limits"]["properties"]
        for key, policy in (("maxCollectionItems", "collection"), ("maxTotalItems", "total"), ("d2MaxElements", "d2")):
            absolute = self.limits[policy]["absolute"]
            self.assertEqual(limits["effective"]["properties"][key]["maximum"], absolute)
            self.assertEqual(limits["meta"]["properties"][key]["allOf"][1]["properties"]["absolute"]["enum"], [absolute])

    def test_public_security_empty_is_not_an_authentication_failure(self):
        operation = self.spec["paths"]["/cmdbuild/custom-api/public-snapshots/{code}/run"]["get"]
        self.assertEqual(operation["security"], [])
        self.assertGreater(self.check_contracts(), 0)


if __name__ == "__main__":
    unittest.main()
