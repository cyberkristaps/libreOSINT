import io
import json
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from osint_transform import INPUT_REF, Transform, TransformError, run  # noqa: E402


def request(type_="Domain", value="example.com", **extra):
    return {"contract_version": 1, "transform_id": "test", "entity": {"id": "x", "type": type_, "value": value}, **extra}


def invoke(handler, req, accepts=None):
    out = io.StringIO()
    code = run(handler, accepts=accepts, stdin=io.StringIO(json.dumps(req)), stdout=out)
    return code, (json.loads(out.getvalue()) if out.getvalue() else None)


class TransformHelperTests(unittest.TestCase):
    def test_happy_path_emits_contract_document(self):
        def handle(t):
            ip = t.add_entity("IPv4", "192.0.2.1", {"record": "A"})
            t.link(t.INPUT, ip, "resolves_to")

        code, doc = invoke(handle, request())
        self.assertEqual(code, 0)
        self.assertEqual(doc["contract_version"], 1)
        self.assertEqual(doc["entities"][0]["type"], "IPv4")
        self.assertEqual(doc["edges"], [{"source": INPUT_REF, "target": "e1", "label": "resolves_to"}])

    def test_duplicate_entities_share_ref_and_merge(self):
        def handle(t):
            a = t.add_entity("IPv4", "192.0.2.1", {"ttl": 60}, tags=["a"])
            b = t.add_entity("IPv4", "192.0.2.1", {"record": "A"}, tags=["b"])
            self.assertEqual(a, b)

        _, doc = invoke(handle, request())
        self.assertEqual(len(doc["entities"]), 1)
        self.assertEqual(doc["entities"][0]["properties"], {"ttl": 60, "record": "A"})
        self.assertEqual(doc["entities"][0]["tags"], ["a", "b"])

    def test_rejects_unaccepted_input_type(self):
        code, doc = invoke(lambda t: None, request("Email", "a@b.c"), accepts={"Domain"})
        self.assertEqual((code, doc), (1, None))

    def test_rejects_wrong_contract_version(self):
        req = request()
        req["contract_version"] = 99
        self.assertEqual(invoke(lambda t: None, req)[0], 1)

    def test_rejects_unknown_output_type(self):
        def handle(t):
            t.add_entity("Planet", "Mars")

        self.assertEqual(invoke(handle, request())[0], 1)

    def test_unexpected_exception_exits_2(self):
        def handle(t):
            raise RuntimeError("boom")

        self.assertEqual(invoke(handle, request())[0], 2)

    def test_api_key_reads_injected_env(self):
        os.environ["OSINT_KEY_SHODAN"] = "test-value"
        try:
            self.assertEqual(Transform(request()).api_key("shodan"), "test-value")
        finally:
            del os.environ["OSINT_KEY_SHODAN"]

    def test_invalid_entity_raises(self):
        with self.assertRaises(TransformError):
            Transform({"contract_version": 1, "entity": {"type": "Nope", "value": "x"}})


if __name__ == "__main__":
    unittest.main()
