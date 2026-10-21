"""Integration tests for the local Flask service and its JSON boundary."""

import importlib
import importlib.util
from html.parser import HTMLParser
import unittest


application = importlib.import_module("app") if importlib.util.find_spec("app") else None


class WorkspaceMarkup(HTMLParser):
    """Collect the public form contract and local assets from the served page."""

    def __init__(self):
        super().__init__()
        self.fields = set()
        self.assets = []

    def handle_starttag(self, tag, attributes):
        attributes = dict(attributes)
        if tag == "textarea" and "name" in attributes:
            self.fields.add(attributes["name"])
        if tag == "script" and "src" in attributes:
            self.assets.append(attributes["src"])
        if tag == "link" and attributes.get("rel") == "stylesheet":
            self.assets.append(attributes["href"])


class AppTests(unittest.TestCase):
    """Use Flask's real request handling with the real project planner."""

    def setUp(self):
        self.assertIsNotNone(application, "The Flask application is not present yet.")
        self.app = application.create_app({"TESTING": True})
        self.client = self.app.test_client()

    def test_health_identifies_the_service_and_release(self):
        response = self.client.get("/healthz")
        self.assertEqual(response.status_code, 200)
        body = response.get_json()
        self.assertEqual(body["service"], "shopbrief")
        self.assertEqual(body["status"], "healthy")
        self.assertTrue(body["version"])

    def test_homepage_serves_the_four_input_workspace_and_local_assets(self):
        response = self.client.get("/")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.mimetype, "text/html")
        markup = WorkspaceMarkup()
        markup.feed(response.get_data(as_text=True))
        self.assertEqual(markup.fields, {"goal", "tools", "materials", "constraints"})
        self.assertGreaterEqual(len(markup.assets), 2)
        for asset in markup.assets:
            self.assertTrue(asset.startswith("/static/"))
            with self.client.get(asset) as asset_response:
                self.assertEqual(asset_response.status_code, 200)

    def test_valid_submission_returns_a_usable_action_sequence(self):
        response = self.client.post("/api/plan", json={"goal": "Build a desk organizer", "tools": "Ruler; ruler", "materials": "Cardboard", "constraints": "Budget $20"})
        self.assertEqual(response.status_code, 200)
        body = response.get_json()
        self.assertEqual(body["inputs"]["tools"], ["Ruler"])
        self.assertEqual(len(body["actions"]), 7)
        self.assertIn("budget", body["actions"][0]["title"].lower())

    def test_empty_goal_returns_a_field_error(self):
        response = self.client.post("/api/plan", json={"goal": "  "})
        self.assertEqual(response.status_code, 400)
        self.assertIn("goal", response.get_json()["errors"])
        self.assertTrue(response.get_json()["message"])

    def test_nonobject_payload_returns_json_not_an_html_error(self):
        response = self.client.post("/api/plan", json=["shelf"])
        self.assertEqual(response.status_code, 400)
        self.assertIn("request", response.get_json()["errors"])

    def test_malformed_json_returns_a_structured_error(self):
        response = self.client.post("/api/plan", data='{"goal":', content_type="application/json")
        self.assertEqual(response.status_code, 400)
        self.assertIn("request", response.get_json()["errors"])

    def test_nonjson_request_returns_a_structured_error(self):
        response = self.client.post("/api/plan", data={"goal": "Build a shelf"})
        self.assertEqual(response.status_code, 400)
        self.assertIn("request", response.get_json()["errors"])

    def test_field_limit_is_reported_without_silent_truncation(self):
        response = self.client.post("/api/plan", json={"goal": "x" * 601})
        self.assertEqual(response.status_code, 400)
        self.assertIn("goal", response.get_json()["errors"])

    def test_oversized_payload_returns_json_413(self):
        response = self.client.post("/api/plan", json={"goal": "x" * 20000})
        self.assertEqual(response.status_code, 413)
        self.assertIn("request", response.get_json()["errors"])
        self.assertTrue(response.get_json()["message"])

    def test_legal_maximum_unicode_fields_fit_the_outer_request_limit(self):
        response = self.client.post("/api/plan", json={"goal": "🔧" * 600, "tools": "🔧" * 1200, "materials": "🔧" * 1200, "constraints": "🔧" * 1200})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["inputs"]["goal"], "🔧" * 600)

    def test_responses_restrict_external_code_and_disable_type_sniffing(self):
        response = self.client.get("/healthz")
        self.assertEqual(response.headers["X-Content-Type-Options"], "nosniff")
        self.assertEqual(response.headers["Referrer-Policy"], "no-referrer")
        policy = response.headers["Content-Security-Policy"]
        self.assertIn("script-src 'self'", policy)
        self.assertIn("style-src 'self'", policy)
        self.assertIn("img-src 'self' data:", policy)
        self.assertNotIn("'unsafe-inline'", policy)

    def test_project_text_roundtrips_as_data(self):
        goal = '<img src=x onerror="alert(1)"> & a shelf'
        response = self.client.post("/api/plan", json={"goal": goal})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["inputs"]["goal"], goal)
        self.assertEqual(response.mimetype, "application/json")


if __name__ == "__main__":
    unittest.main()
