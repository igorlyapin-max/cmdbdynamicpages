"""Regression tests use shipped workbooks, never developer template directories."""

from pathlib import Path
import shutil
import sys
import tempfile
import unittest

from openpyxl import load_workbook

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
from aa_workbooks import BOOKS, validate_book, workbook_data  # noqa: E402
from aa_contracts import UniqueLoader, validate  # noqa: E402
import yaml  # noqa: E402


class WorkbookTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        shutil.copytree(ROOT / "aa", self.root / "aa")

    def tearDown(self):
        self.temporary.cleanup()

    def mutate_book(self, action):
        path = self.root / "aa/xlsx/healthcheck-map.xlsx"
        book = load_workbook(path)
        action(book)
        book.save(path)
        book.close()

    def test_delivery_without_local_templates(self):
        for name in BOOKS:
            self.assertTrue(workbook_data(self.root, name)["sheets"])
            validate_book(self.root, name)
        self.assertGreater(validate(self.root), 0)

    def test_missing_workbook(self):
        (self.root / "aa/xlsx/healthcheck-map.xlsx").unlink()
        with self.assertRaisesRegex(ValueError, "missing workbook"):
            validate_book(self.root, "healthcheck-map")

    def test_changed_value(self):
        self.mutate_book(lambda b: setattr(b["HealthCheck"]["C4"], "value", "wrong endpoint"))
        with self.assertRaisesRegex(ValueError, "differs from Markdown"):
            validate_book(self.root, "healthcheck-map")

    def test_extra_row(self):
        self.mutate_book(lambda b: setattr(b["HealthCheck"]["B100"], "value", "extra"))
        with self.assertRaisesRegex(ValueError, "extra cell"):
            validate_book(self.root, "healthcheck-map")

    def test_changed_markdown(self):
        path = self.root / "aa/healthcheck-map.md"
        path.write_text(path.read_text().replace("/health/live", "/health/changed"))
        with self.assertRaisesRegex(ValueError, "differs from Markdown"):
            validate_book(self.root, "healthcheck-map")

    def test_changed_header(self):
        self.mutate_book(lambda b: setattr(b["HealthCheck"]["B2"], "value", "wrong"))
        with self.assertRaisesRegex(ValueError, "header changed"):
            validate_book(self.root, "healthcheck-map")

    def test_formula(self):
        self.mutate_book(lambda b: setattr(b["HealthCheck"]["B4"], "value", "=1+1"))
        with self.assertRaisesRegex(ValueError, "prohibited formula"):
            validate_book(self.root, "healthcheck-map")

    def test_changed_instruction(self):
        self.mutate_book(lambda b: setattr(b["HealthCheck"]["B3"], "value", "changed instructions"))
        with self.assertRaisesRegex(ValueError, "canonical instructions"):
            validate_book(self.root, "healthcheck-map")

    def test_changed_dictionary(self):
        self.mutate_book(lambda b: setattr(b["Справочник типов ресурсов"]["B3"], "value", "NOT_API"))
        with self.assertRaisesRegex(ValueError, "canonical instructions"):
            validate_book(self.root, "healthcheck-map")

    def test_secret_material(self):
        self.mutate_book(lambda b: setattr(b["HealthCheck"]["B4"], "value", "password=fixture-not-a-real-secret"))
        with self.assertRaisesRegex(ValueError, "prohibited secret"):
            validate_book(self.root, "healthcheck-map")

    def test_hyperlink(self):
        self.mutate_book(lambda b: setattr(b["HealthCheck"]["B4"], "hyperlink", "https://example.invalid/"))
        with self.assertRaisesRegex(ValueError, "prohibited archive metadata"):
            validate_book(self.root, "healthcheck-map")

    def test_unknown_flow(self):
        self.mutate_book(lambda b: setattr(b["Системы"]["C4"], "value", "H999"))
        with self.assertRaisesRegex(ValueError, "unknown flow"):
            validate_book(self.root, "healthcheck-map")

    def test_api_wrong_flow(self):
        path = self.root / "aa/openapi.yaml"
        path.write_text(path.read_text().replace("x-flow-id: H0", "x-flow-id: H999", 1))
        with self.assertRaisesRegex(ValueError, "undeclared"):
            validate(self.root)

    def test_duplicate_yaml_keys(self):
        with self.assertRaisesRegex(ValueError, "duplicate YAML key"):
            yaml.load("paths: {}\npaths: {}\n", Loader=UniqueLoader)


if __name__ == "__main__":
    unittest.main()
