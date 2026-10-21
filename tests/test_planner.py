"""Behavioral tests for the project planner's public contract."""

import importlib
import importlib.util
import unittest


# Import lazily so a missing implementation is reported as a clear test failure.
planner = importlib.import_module("planner") if importlib.util.find_spec("planner") else None


class PlannerTests(unittest.TestCase):
    """Exercise actual plans rather than copies of the planning rules."""

    def setUp(self):
        self.assertIsNotNone(planner, "The planner implementation is not present yet.")

    def plan(self, **changes):
        values = {
            "goal": "Build a small wall-mounted tool shelf",
            "tools": "Drill, tape measure, clamps",
            "materials": "Plywood, screws",
            "constraints": "Maximum 12-inch width; wall mounting; budget $40",
        }
        values.update(changes)
        return planner.build_plan(values)

    def test_resource_delimiters_deduplicate_without_losing_first_spelling(self):
        result = self.plan(tools="Drill, tape measure; drill\nClamps; TAPE MEASURE", materials="Oak; oak\nM4 screws, Washers")
        self.assertEqual(result["inputs"]["tools"], ["Drill", "tape measure", "Clamps"])
        self.assertEqual(result["resources"]["materials"], ["Oak", "M4 screws", "Washers"])

    def test_free_text_retains_internal_whitespace_punctuation_and_markup(self):
        goal = 'Make a <wide> jig:  A & B\nKeep the "left" opening.'
        constraints = "Don't exceed 12 in.\n  Keep the original bolt spacing."
        result = self.plan(goal=goal, constraints=constraints)
        self.assertEqual(result["inputs"]["goal"], goal)
        self.assertEqual(result["inputs"]["constraints"], constraints)

    def test_normal_plan_has_seven_actionable_steps_with_forward_progress(self):
        result = self.plan()
        actions = result["actions"]
        self.assertEqual(len(actions), 7)
        self.assertEqual(len({action["id"] for action in actions}), 7)
        earlier_ids = set()
        for index, action in enumerate(actions):
            for field in ("title", "detail", "done_when", "why", "phase"):
                self.assertTrue(action[field].strip(), f"Step {index + 1} needs {field}.")
            self.assertTrue(set(action["depends_on"]).issubset(earlier_ids))
            if index:
                self.assertIn(actions[index - 1]["id"], action["depends_on"])
            earlier_ids.add(action["id"])
        self.assertIn("prototype", " ".join(action["title"].lower() for action in actions))
        self.assertIn("test", " ".join(action["title"].lower() for action in actions))

    def test_dimension_and_mounting_limit_changes_the_first_action(self):
        first = self.plan()["actions"][0]
        self.assertIn("measur", first["title"].lower())
        self.assertIn("12-inch", first["detail"])
        self.assertIn("mount", (first["detail"] + first["done_when"]).lower())

    def test_budget_only_limit_puts_cost_check_before_design(self):
        first = self.plan(goal="Make a desk organizer", constraints="Budget $25", tools="Ruler", materials="Cardboard")["actions"][0]
        self.assertIn("budget", first["title"].lower())
        self.assertIn("$25", first["detail"])
        self.assertIn("cost", first["done_when"].lower())

    def test_deadline_only_limit_puts_schedule_check_before_design(self):
        first = self.plan(goal="Make a desk organizer", constraints="Finish by Friday", tools="Ruler", materials="Cardboard")["actions"][0]
        self.assertIn("deadline", first["title"].lower())
        self.assertIn("Friday", first["detail"])

    def test_freestanding_project_does_not_require_a_mounting_area(self):
        first = self.plan(goal="Build a freestanding tool organizer", constraints="18-inch width; no wall mounting")["actions"][0]
        self.assertNotIn("mount", first["title"].lower())
        self.assertIn("if", first["detail"].lower())

    def test_one_evening_is_recognized_as_supplied_work_time(self):
        result = self.plan(goal="Make a desk organizer", constraints="One evening", tools="Ruler", materials="Cardboard")
        self.assertIn("deadline", result["actions"][0]["title"].lower())
        self.assertFalse(any("deadline" in question.lower() for question in result["missing_information"]))

    def test_load_limit_puts_load_and_attachment_definition_first(self):
        first = self.plan(constraints="Must hold 20 lb of tools", materials="Plywood")["actions"][0]
        self.assertIn("load", first["title"].lower())
        self.assertIn("20 lb", first["detail"])
        self.assertIn("attachment", first["done_when"].lower())

    def test_missing_inputs_are_explicit_unknowns_without_invented_resources(self):
        result = self.plan(goal="Make an organizer", tools="", materials="", constraints="")
        self.assertEqual(result["resources"], {"tools": [], "materials": []})
        unknowns = " ".join(result["missing_information"]).lower()
        for unknown in ("tools", "materials", "dimensions", "budget", "deadline", "load"):
            self.assertIn(unknown, unknowns)
        self.assertIn("unknown", result["actions"][0]["detail"].lower())

    def test_hazardous_scope_starts_with_qualified_review_and_no_certification(self):
        result = self.plan(goal="Build a 120V mains electrical outlet box", constraints="For a garage")
        self.assertEqual(len(result["actions"]), 8)
        first = result["actions"][0]
        self.assertIn("qualified", (first["title"] + first["detail"]).lower())
        self.assertIn("before", first["done_when"].lower())
        self.assertIn("not a safety certification", " ".join(risk["detail"] for risk in result["risks"]).lower())

    def test_user_material_is_not_declared_suitable(self):
        result = self.plan(materials="Unidentified reclaimed board")
        self.assertIn("Unidentified reclaimed board", result["resources"]["materials"])
        self.assertTrue(any("suitability" in risk["detail"].lower() for risk in result["risks"]))

    def test_all_required_sections_are_present_and_plans_have_distinct_ids(self):
        first = self.plan()
        second = self.plan()
        self.assertTrue({"plan_id", "project_title", "summary", "inputs", "requirements", "resources", "risks", "missing_information", "actions"}.issubset(first))
        self.assertNotEqual(first["plan_id"], second["plan_id"])
        self.assertGreaterEqual(len(first["requirements"]), 3)
        self.assertGreaterEqual(len(first["risks"]), 1)

    def test_goal_is_required(self):
        for value in ("", "  \n ", None):
            with self.subTest(value=value):
                with self.assertRaises(planner.PlannerValidationError) as raised:
                    self.plan(goal=value)
                self.assertIn("goal", raised.exception.errors)

    def test_maximum_lengths_are_accepted_without_silent_truncation(self):
        result = self.plan(goal="g" * 600, tools="t" * 1200, materials="m" * 1200, constraints="c" * 1200)
        self.assertEqual(len(result["inputs"]["goal"]), 600)
        self.assertEqual(result["inputs"]["tools"], ["t" * 1200])
        self.assertEqual(result["inputs"]["materials"], ["m" * 1200])
        self.assertEqual(len(result["inputs"]["constraints"]), 1200)

    def test_overlong_fields_are_reported_together(self):
        with self.assertRaises(planner.PlannerValidationError) as raised:
            self.plan(goal="g" * 601, tools="t" * 1201, materials="m" * 1201, constraints="c" * 1201)
        self.assertEqual(set(raised.exception.errors), {"goal", "tools", "materials", "constraints"})

    def test_nonstring_fields_are_rejected_without_coercion(self):
        for field, value in (("goal", ["shelf"]), ("tools", 12), ("materials", {"wood": 1}), ("constraints", False)):
            with self.subTest(field=field):
                with self.assertRaises(planner.PlannerValidationError) as raised:
                    self.plan(**{field: value})
                self.assertIn(field, raised.exception.errors)

    def test_payload_must_be_an_object(self):
        for value in (None, [], "a project"):
            with self.subTest(value=value):
                with self.assertRaises(planner.PlannerValidationError) as raised:
                    planner.build_plan(value)
                self.assertIn("request", raised.exception.errors)


if __name__ == "__main__":
    unittest.main()
