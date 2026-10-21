"""Turn a maker's project notes into an ordered, local project plan.

The planner uses explicit rules, does not contact other services, and does not
store submissions. Supplied resources are inventory, not a suitability approval.
"""

from __future__ import annotations

import re
from uuid import uuid4


# I keep these limits aligned with the form and browser checks for predictable errors.
FIELD_LIMITS = {"goal": 600, "tools": 1200, "materials": 1200, "constraints": 1200}

# These expressions find planning signals; they do not calculate engineering
# tolerances, certify a design, or infer measurements that were never supplied.
DIMENSION = re.compile(r"\b\d+(?:\.\d+)?\s*(?:-\s*)?(?:inches|inch|in\b|feet|foot|ft\b|mm\b|cm\b|meters?\b|metres?\b)|\b\d+(?:\.\d+)?\s*[\"′″]", re.I)
MOUNTING = re.compile(r"\b(?:mount(?:ed|ing)?|wall|attach(?:ed|ment)?|bolt(?:ed|s)?)\b", re.I)
LOAD = re.compile(r"\b(?:load|weight|hold|holds|support)\b|\b\d+(?:\.\d+)?\s*(?:lbs?\b|pounds?\b|kg\b)", re.I)
BUDGET = re.compile(r"\b(?:budget|cost|spend|dollars?|price)\b|[$£€]\s*\d", re.I)
DEADLINE = re.compile(r"\b(?:deadline|finish by|due|deliver|today|tomorrow|tonight|weekend|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b|\b\d+\s*(?:hours?|days?|weeks?)\b|\b(?:one|an?|[1-9]\d*)\s+(?:evenings?|afternoons?|mornings?)\b", re.I)
HIGH_RISK = re.compile(r"\b(?:mains|electrical wiring|outlet|gas line|fuel system|load[- ]bearing|structural|pressure vessel|lifting|hoist|vehicle brakes?|firearm)\b|\b(?:120|220|230|240)\s*v\b", re.I)


class PlannerValidationError(ValueError):
    """Carry field-specific problems to the HTTP boundary without losing them."""

    def __init__(self, errors: dict[str, str]):
        super().__init__("Check the highlighted project fields.")
        self.errors = errors


def _validate(payload: object) -> dict[str, str]:
    """Reject malformed input explicitly instead of silently coercing or cutting it."""
    if not isinstance(payload, dict):
        raise PlannerValidationError({"request": "Send a JSON object with project fields."})

    errors: dict[str, str] = {}
    values: dict[str, str] = {}
    for field, limit in FIELD_LIMITS.items():
        value = payload.get(field, "")
        if not isinstance(value, str):
            errors[field] = "Enter text for this field."
            continue
        if len(value) > limit:
            errors[field] = f"Use {limit} characters or fewer."
        # Only trim outside whitespace. Interior spacing and punctuation are data.
        values[field] = value.strip()
    if "goal" not in errors and not values.get("goal"):
        errors["goal"] = "Enter a project goal before creating a plan."
    if errors:
        raise PlannerValidationError(errors)
    return values


def _split_resources(value: str) -> list[str]:
    """Split common list separators and retain the first spelling of each item."""
    items: list[str] = []
    seen: set[str] = set()
    for part in re.split(r"[,;\n\r]+", value):
        item = part.strip()
        key = item.casefold()
        if item and key not in seen:
            items.append(item)
            seen.add(key)
    return items


def _first_action(goal: str, constraints: str, signals: dict[str, bool]) -> dict[str, str]:
    """Put the strongest supplied constraint before design or material spending."""
    # I use a fixed priority: fit, load, budget, then timing, with definition as the fallback.
    # The remaining constraints stay in the plan even when one sets the first action.
    limits = constraints or goal
    if signals["dimensions"] or (signals["mounting"] and not signals["load"]):
        return {
            "title": "Measure the project fit",
            "detail": f"Measure the usable space and clearances. If mounting or attachment is part of the project, record that area too. Compare the measurements with: {limits}",
            "done_when": "A dimensioned note records usable space and each supplied size limit, plus mounting or attachment locations where applicable; any unknown measurement is marked.",
            "why": "Confirmed fit prevents a detailed design from starting with the wrong dimensions.",
        }
    if signals["load"]:
        return {
            "title": "Define the load and attachment checks",
            "detail": f"Record what the project must hold, how it will be used, and how it will be attached. Resolve these stated limits before sketching: {limits}",
            "done_when": "The intended load, attachment method, and a review or test approach are written down; unknown values are flagged before design.",
            "why": "Load and attachment needs determine what must be checked before a build can proceed.",
        }
    if signals["budget"]:
        return {
            "title": "Check the budget before design",
            "detail": f"List likely purchases, quantities, and estimated costs, including items already on hand. Check the total against: {limits}",
            "done_when": "A cost estimate fits the stated budget or identifies an explicit scope change to discuss before buying anything.",
            "why": "A budget check prevents the design from depending on unaffordable parts.",
        }
    if signals["deadline"]:
        return {
            "title": "Check the deadline and available work time",
            "detail": f"Work backward from the deadline, allowing time for a small test and one revision. Use the stated timing: {limits}",
            "done_when": "A dated work schedule includes material lead time, a test, a revision window, and the final check.",
            "why": "A realistic schedule makes the next step achievable within the time available.",
        }
    return {
        "title": "Define the use and measure the space",
        "detail": f"Write one observable success condition for: {goal} Then measure the relevant space and list unknown dimensions, load, budget, and timing before sketching.",
        "done_when": "A short project note states the intended use, a measurable success condition, available dimensions, and the questions still unanswered.",
        "why": "A clear definition gives every later action a checkable purpose.",
    }


def build_plan(payload: object) -> dict[str, object]:
    """Create a fresh plan with explicit unknowns and ordered completion criteria."""
    values = _validate(payload)
    goal = values["goal"]
    constraints = values["constraints"]
    tools = _split_resources(values["tools"])
    materials = _split_resources(values["materials"])
    # I read intent from the goal and limits; an inventory item alone does not define its use.
    context = f"{goal}\n{constraints}"
    signals = {
        "dimensions": bool(DIMENSION.search(context)),
        "mounting": bool(MOUNTING.search(context)),
        "load": bool(LOAD.search(context)),
        "budget": bool(BUDGET.search(context)),
        "deadline": bool(DEADLINE.search(context)),
    }
    high_risk = bool(HIGH_RISK.search(context))

    # I surface unknowns as questions instead of supplying measurements or assumptions as facts.
    missing: list[str] = []
    if not tools:
        missing.append("Which tools are available, and which required tools need to be obtained?")
    if not materials:
        missing.append("Which materials, sizes, quantities, and condition are available?")
    if not signals["dimensions"]:
        missing.append("What are the target dimensions and required clearances?")
    if not signals["load"]:
        missing.append("What load, use conditions, and attachment method must be checked?")
    if not signals["budget"]:
        missing.append("What is the budget for additional parts and supplies?")
    if not signals["deadline"]:
        missing.append("What is the deadline, and how much work time is available?")

    requirements = [
        {"title": "Define the finished result", "detail": goal},
        {"title": "Respect the project limits", "detail": constraints or "Dimensions, budget, deadline, and use limits are still unknown; record them before committing to a design."},
        {"title": "Confirm fit and performance", "detail": "Record target dimensions and an observable acceptance check for the intended use before cutting, assembling, or purchasing parts."},
        {"title": "Use a tested sequence", "detail": "Check the inventory, try a small reversible prototype, record test observations, and update the design before the full build."},
    ]

    risks = [
        {"title": "Inventory needs confirmation", "detail": "Listed tools and materials are user-supplied inventory. Confirm their condition, dimensions, instructions, and suitability for the intended process and use."},
        {"title": "Test before committing", "detail": "A plan can miss fit or use problems. Try a small, reversible prototype and record what changes before using the full amount of material."},
    ]
    if missing:
        risks.append({"title": "Open questions can change the plan", "detail": "Resolve the listed missing information, or mark a deliberate assumption, before buying parts or beginning the affected step."})
    if high_risk:
        risks.insert(0, {"title": "Qualified review required", "detail": "This scope includes a potentially hazardous system. Obtain an appropriate qualified professional's review before design, purchasing, testing, or building. This plan is not a safety certification or an engineering approval."})

    tool_note = ", ".join(tools) if tools else "No tools have been confirmed."
    material_note = ", ".join(materials) if materials else "No materials have been confirmed."
    first = _first_action(goal, constraints, signals)
    steps = [
        {**first, "phase": "Define"},
        {"phase": "Design", "title": "Sketch one buildable approach", "detail": f"Sketch a simple approach for: {goal} Label overall dimensions, interfaces, assembly order, and any assumptions. Check the sketch against every recorded constraint.", "done_when": "One annotated sketch shows the intended size, connections, assembly sequence, and unresolved decisions.", "why": "A sketch exposes fit and assembly questions while changes are still inexpensive."},
        {"phase": "Prepare", "title": "Check resources and close the gaps", "detail": f"Compare the sketch with the available inventory. Tools: {tool_note} Materials: {material_note} Record sizes, quantities, missing items, and costs; check suitability rather than assuming it.", "done_when": "A checked resource list identifies what is on hand, what is missing, quantities, costs, and any suitability question that blocks the prototype.", "why": "A resource check makes the prototype achievable without an avoidable interruption."},
        {"phase": "Prototype", "title": "Make a small reversible prototype", "detail": "Choose the most uncertain fit, connection, or use detail from the sketch. Try that detail at a useful scale with a reversible mock-up or small sample, following applicable tool instructions.", "done_when": "One sample or mock-up exists, and the question it is intended to answer is written next to it.", "why": "A focused prototype tests the riskiest assumption before the full build."},
        {"phase": "Test", "title": "Test the prototype and revise the sketch", "detail": "Compare the prototype with the recorded dimensions and success condition. Record actual observations, pass or fail, and one specific change where needed. Repeat the affected check after revising.", "done_when": "A short test note states expected and actual results, the decision, and any revised dimensions or assembly details.", "why": "Recorded observations turn a promising mock-up into a reasoned build decision."},
        {"phase": "Build", "title": "Build from the revised plan", "detail": "Use the revised sketch and checked resource list. Work in the recorded assembly order, checking fit at each connection and pausing if a new issue changes the plan.", "done_when": "The intended assembly is complete, interim fit checks are recorded, and any deviation from the sketch is noted.", "why": "Building from the tested revision keeps work aligned with the project requirements."},
        {"phase": "Review", "title": "Verify the result and record the handoff", "detail": "Repeat the acceptance check on the finished project. Compare the result with the goal and every constraint; record remaining issues, photographs, and any maintenance or use notes.", "done_when": "A final note records expected versus actual results for each requirement and identifies any remaining work before use.", "why": "A final check makes completion an observable result rather than a guess."},
    ]
    if high_risk:
        steps.insert(0, {"phase": "Safety review", "title": "Obtain qualified review of the scope", "detail": f"Ask an appropriately qualified professional to review the hazardous parts of this scope: {goal} Record the review limits, applicable requirements, and whether the work can proceed.", "done_when": "A qualified review identifies the applicable requirements and a clear decision before design, purchasing, testing, or building begins.", "why": "Potentially hazardous work needs competent review that this planning tool cannot provide."})

    # A linear dependency chain is deliberate: the interface can reveal the next
    # unfinished action without letting later completion skip a prerequisite.
    actions = []
    for index, step in enumerate(steps, start=1):
        action_id = f"step-{index}"
        actions.append({"id": action_id, **step, "depends_on": [f"step-{index - 1}"] if index > 1 else []})

    # Keep the display title compact, while retaining the entire goal in inputs.
    title = re.split(r"[\n.!?]", goal, maxsplit=1)[0].strip()
    title = title if len(title) <= 72 else title[:69].rstrip() + "..."
    # I give each generated route a fresh identity; the browser starts its progress separately.
    return {
        "plan_id": uuid4().hex,
        "project_title": title or "Maker project",
        "summary": "Seven practical steps connect your project goal to a checked result." if not high_risk else "Qualified review comes first, followed by seven project steps with checkable outcomes.",
        "inputs": {"goal": goal, "tools": tools, "materials": materials, "constraints": constraints},
        "requirements": requirements,
        "resources": {"tools": tools, "materials": materials},
        "risks": risks,
        "missing_information": missing,
        "actions": actions,
    }
