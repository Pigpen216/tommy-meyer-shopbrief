/* ShopBrief keeps only the current workspace in this browser. The server builds
   suggestions; completion and notes always remain the maker's own record. */
"use strict";

(() => {
  const STORAGE_KEY = "shopbrief.workspace.v1";
  const FIELD_NAMES = ["goal", "tools", "materials", "constraints"];
  const FIELD_LIMITS = { goal: 600, tools: 1200, materials: 1200, constraints: 1200 };
  const blankInputs = () => ({ goal: "", tools: "", materials: "", constraints: "" });
  /* I keep the editable brief separate from the generated plan so draft changes
     remain visible without silently changing the route already being followed. */
  let state = { inputs: blankInputs(), plan: null, completed: [], notes: {} };
  let busy = false;
  let saveAvailable = true;
  let noteTimer;
  let pendingErrorFocus = null;

  const byId = (id) => document.getElementById(id);
  const form = byId("brief-form");
  const submitButton = byId("generate-plan");
  const exampleButton = byId("example-button");
  const noteInput = byId("outcome-note");

  /* Create every response element through textContent so entered project text
     cannot become executable markup in the workspace. */
  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function announce(message) {
    byId("status-message").textContent = message;
  }

  function readInputs() {
    return Object.fromEntries(FIELD_NAMES.map((name) => [name, byId(name).value]));
  }

  function populateInputs(inputs) {
    for (const name of FIELD_NAMES) byId(name).value = inputs[name] || "";
  }

  /* Local storage can be blocked or full. Keep the app usable while reporting
     that loss of persistence honestly instead of claiming a successful save. */
  function saveWorkspace() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      saveAvailable = true;
      byId("save-status").textContent = "Saved in this browser. No account or shared-device sync.";
    } catch {
      saveAvailable = false;
      byId("save-status").textContent = "Browser saving is unavailable. Keep this tab open to retain your work.";
    }
  }

  function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function isStringList(value) {
    return Array.isArray(value) && value.every((item) => typeof item === "string");
  }

  /* Validate members as well as containers before either saved data or a server
     response reaches the renderers. Dependency order prevents a damaged saved
     route from presenting a later step as a prerequisite for an earlier one. */
  function validPlan(plan) {
    const validFacts = (facts) => Array.isArray(facts) && facts.every((fact) =>
      isRecord(fact) && typeof fact.title === "string" && typeof fact.detail === "string");
    if (!isRecord(plan) || typeof plan.plan_id !== "string" || !plan.plan_id.trim()
      || typeof plan.project_title !== "string" || typeof plan.summary !== "string"
      || !isRecord(plan.inputs) || typeof plan.inputs.goal !== "string"
      || typeof plan.inputs.constraints !== "string" || !isStringList(plan.inputs.tools)
      || !isStringList(plan.inputs.materials) || !isRecord(plan.resources)
      || !isStringList(plan.resources.tools) || !isStringList(plan.resources.materials)
      || !validFacts(plan.requirements) || !validFacts(plan.risks)
      || !isStringList(plan.missing_information) || !Array.isArray(plan.actions)
      || plan.actions.length === 0) return false;

    const actionIds = new Set();
    for (const action of plan.actions) {
      if (!isRecord(action) || typeof action.id !== "string" || !action.id.trim()
        || actionIds.has(action.id) || typeof action.title !== "string"
        || typeof action.detail !== "string" || typeof action.done_when !== "string"
        || typeof action.why !== "string" || typeof action.phase !== "string"
        || !isStringList(action.depends_on)
        || !action.depends_on.every((id) => actionIds.has(id))) return false;
      actionIds.add(action.id);
    }
    /* This optional local snapshot is used only to detect edited drafts. The
       API response has no original_inputs until the successful form submission. */
    return plan.original_inputs === undefined || (isRecord(plan.original_inputs)
      && FIELD_NAMES.every((name) => typeof plan.original_inputs[name] === "string"));
  }

  /* Restore only expected values. An older or damaged saved workspace should
     fall back to a clean form without preventing a new project plan. */
  function restoreWorkspace() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const stored = JSON.parse(raw);
      if (!isRecord(stored)) throw new Error("Invalid saved workspace.");
      const inputs = blankInputs();
      for (const name of FIELD_NAMES) {
        if (typeof stored.inputs?.[name] === "string") inputs[name] = stored.inputs[name].slice(0, FIELD_LIMITS[name]);
      }
      const plan = validPlan(stored.plan) ? stored.plan : null;
      const invalidSavedPlan = stored.plan !== null && stored.plan !== undefined && !plan;
      const actionIds = plan ? new Set(plan.actions.map((action) => action.id)) : new Set();
      const storedCompleted = new Set(Array.isArray(stored.completed) ? stored.completed : []);
      const completed = [];
      /* Only an uninterrupted completed prefix can advance the next action.
         Ignore damaged later completion flags while retaining valid notes. */
      if (plan) {
        for (const action of plan.actions) {
          if (!storedCompleted.has(action.id)) break;
          completed.push(action.id);
        }
      }
      const notes = Object.create(null);
      if (isRecord(stored.notes)) {
        for (const id of actionIds) {
          if (typeof stored.notes[id] === "string") notes[id] = stored.notes[id].slice(0, 2000);
        }
      }
      state = { inputs, plan, completed, notes };
      populateInputs(inputs);
      byId("save-status").textContent = invalidSavedPlan
        ? "Your saved plan could not be restored. Your draft brief is retained; build a new plan."
        : "Restored from this browser. No account or shared-device sync.";
    } catch {
      saveAvailable = false;
      byId("save-status").textContent = "A saved workspace could not be loaded. You can start a new brief.";
    }
  }

  function clearErrors() {
    for (const name of FIELD_NAMES) {
      byId(name).removeAttribute("aria-invalid");
      byId(`${name}-error`).hidden = true;
      byId(`${name}-error`).textContent = "";
    }
    byId("form-message").hidden = true;
    byId("form-message").textContent = "";
  }

  function showErrors(errors, message) {
    let firstField = null;
    for (const name of FIELD_NAMES) {
      if (typeof errors?.[name] !== "string") continue;
      byId(name).setAttribute("aria-invalid", "true");
      byId(`${name}-error`).textContent = errors[name];
      byId(`${name}-error`).hidden = false;
      if (!firstField) firstField = byId(name);
    }
    if (message) {
      byId("form-message").textContent = message;
      byId("form-message").hidden = false;
    }
    /* I defer error focus while a request has disabled the fields; setBusy restores
       that focus after unlocking them so keyboard users reach the actual problem. */
    if (firstField) {
      if (firstField.disabled) pendingErrorFocus = firstField;
      else firstField.focus();
    }
    announce(message || "Check the highlighted fields in your project brief.");
  }

  function setBusy(value) {
    busy = value;
    submitButton.disabled = value;
    exampleButton.disabled = value;
    form.setAttribute("aria-busy", String(value));
    submitButton.firstElementChild.textContent = value ? "Building your plan…" : state.plan ? "Update my project plan" : "Build my project plan";
    /* Freeze inputs during the brief request so the plan and displayed draft
       cannot silently refer to different input snapshots. */
    for (const name of FIELD_NAMES) byId(name).disabled = value;
    if (!value && pendingErrorFocus) {
      pendingErrorFocus.focus();
      pendingErrorFocus = null;
    }
  }

  /* I use -1 as the finished-route state, rather than treating the final step
     as still current after every suggested action has been checked. */
  function currentActionIndex() {
    return state.plan.actions.findIndex((action) => !state.completed.includes(action.id));
  }

  function renderProgress() {
    const total = state.plan.actions.length;
    const completed = state.completed.length;
    const percent = Math.round(completed / total * 100);
    byId("progress-count").textContent = `${completed} of ${total}`;
    byId("progress-fill").style.width = `${percent}%`;
    byId("progress-track").setAttribute("aria-valuenow", String(percent));
    byId("progress-track").setAttribute("aria-valuetext", `${completed} of ${total} suggested steps complete`);
    byId("roadmap-count").textContent = `${total} suggested steps`;
  }

  function renderCurrentAction() {
    const index = currentActionIndex();
    const finished = index === -1;
    const action = finished ? null : state.plan.actions[index];
    const card = byId("current-action");
    card.classList.toggle("is-finished", finished);
    byId("current-step-label").textContent = finished ? "ROUTE COMPLETE" : `STEP ${index + 1} OF ${state.plan.actions.length}`;
    byId("current-number").textContent = finished ? "✓" : String(index + 1).padStart(2, "0");
    byId("current-phase").textContent = finished ? "Time to take stock" : action.phase || "Make progress";
    byId("current-title").textContent = finished ? "Your route is complete." : action.title;
    byId("current-detail").textContent = finished ? "You’ve worked through every suggested step. Review the result against your original brief and keep your decisions in the notes below." : action.detail;
    byId("current-why").textContent = finished ? "A final look helps catch open questions before you call the project finished." : action.why;
    byId("current-done-when").textContent = finished ? "You have checked the physical result and any remaining requirements yourself." : action.done_when;
    byId("current-note-group").hidden = finished;
    byId("complete-action").hidden = finished;
    byId("completion-hint").textContent = finished ? "Need another pass? Reopen a step in your route below. Your notes stay with it." : "Move at your pace. Check the result before moving on.";
    noteInput.value = action ? state.notes[action.id] || "" : "";
    noteInput.dataset.actionId = action ? action.id : "";
  }

  function addActionDetail(parent, label, text) {
    const paragraph = element("p");
    paragraph.append(element("strong", "", `${label} `), document.createTextNode(text));
    parent.append(paragraph);
  }

  function renderRoadmap() {
    const list = byId("action-list");
    list.replaceChildren();
    const currentIndex = currentActionIndex();
    state.plan.actions.forEach((action, index) => {
      const completed = state.completed.includes(action.id);
      const current = index === currentIndex;
      const item = element("li", `action-item${completed ? " is-complete" : ""}${current ? " is-current" : ""}`);
      item.dataset.actionId = action.id;
      const row = element("div", "action-row");
      const checkbox = element("input", "action-check");
      checkbox.type = "checkbox";
      checkbox.checked = completed;
      checkbox.id = `action-${index + 1}`;
      checkbox.setAttribute("aria-label", `${completed ? "Reopen" : "Complete"} step ${index + 1}: ${action.title}`);
      /* Later steps remain visible while prior work controls progression. */
      checkbox.disabled = !completed && !current;
      checkbox.title = checkbox.disabled ? "Complete earlier steps to continue." : completed ? "Reopen this step and later steps." : "Record this suggested step as complete.";
      checkbox.addEventListener("change", () => toggleAction(action.id));
      const main = element("div", "action-row-main");
      const top = element("div", "action-row-top");
      top.append(element("span", "action-index", String(index + 1).padStart(2, "0")), element("h3", "", action.title));
      main.append(top, element("span", "action-phase", action.phase || "Project step"));
      row.append(checkbox, main);
      if (current || completed) row.append(element("span", `action-badge${completed ? " is-done" : ""}`, completed ? "COMPLETE" : "UP NEXT"));
      /* I keep earlier outcomes with their own step details so reopening work
         retains the measurements and decisions already recorded for that step. */
      const details = element("details", "action-details");
      const summary = element("summary", "", "Step details");
      const content = element("div", "action-details-content");
      content.append(element("p", "", action.detail));
      addActionDetail(content, "Why:", action.why);
      addActionDetail(content, "Done when:", action.done_when);
      if (state.notes[action.id]) {
        const savedNote = element("p", "saved-note");
        savedNote.append(element("strong", "", "Your notes: "), document.createTextNode(state.notes[action.id]));
        content.append(savedNote);
      }
      details.append(summary, content);
      item.append(row, details);
      list.append(item);
    });
  }

  /* Reopening an early action also reopens later actions, because their checks
     may depend on the earlier result. Notes remain available for review. */
  function toggleAction(id) {
    const actions = state.plan.actions;
    const index = actions.findIndex((action) => action.id === id);
    if (index < 0) return;
    const reopening = state.completed.includes(id);
    if (reopening) {
      const retainedIds = new Set(actions.slice(0, index).map((action) => action.id));
      state.completed = state.completed.filter((completedId) => retainedIds.has(completedId));
    } else {
      if (index !== currentActionIndex()) return;
      state.completed.push(id);
    }
    saveWorkspace();
    renderProgress();
    renderCurrentAction();
    renderRoadmap();
    announce(reopening ? "Step reopened. Later steps are now marked incomplete. Your notes are preserved." : currentActionIndex() === -1 ? "All suggested steps are marked complete. Review the finished result yourself." : `Step complete. Next: ${actions[currentActionIndex()].title}`);
  }

  function renderFacts(id, facts) {
    const list = byId(id);
    list.replaceChildren();
    for (const fact of facts) {
      const item = element("li");
      item.append(element("strong", "", fact.title), element("p", "", fact.detail));
      list.append(item);
    }
  }

  function renderResources(id, resources, unknownText) {
    const list = byId(id);
    list.replaceChildren();
    if (!resources.length) {
      list.append(element("li", "is-unknown", unknownText));
      return;
    }
    for (const resource of resources) list.append(element("li", "", resource));
  }

  /* I compare resource drafts with the submitted strings, because the server
     splits those strings into lists and cannot preserve their original separators. */
  function hasDraftChanges() {
    if (!state.plan) return false;
    const saved = state.plan.inputs;
    return state.inputs.goal.trim() !== String(saved.goal || "").trim()
      || state.inputs.constraints.trim() !== String(saved.constraints || "").trim()
      || state.inputs.tools.trim() !== (state.plan.original_inputs?.tools || "").trim()
      || state.inputs.materials.trim() !== (state.plan.original_inputs?.materials || "").trim();
  }

  function renderPlan() {
    const plan = state.plan;
    byId("empty-state").hidden = Boolean(plan);
    byId("plan-content").hidden = !plan;
    if (!plan) return;
    byId("project-title").textContent = plan.project_title;
    byId("project-summary").textContent = plan.summary;
    byId("draft-notice").hidden = !hasDraftChanges();
    renderProgress();
    renderCurrentAction();
    renderRoadmap();
    renderFacts("requirements-list", plan.requirements);
    renderFacts("risks-list", plan.risks);
    const missing = byId("missing-list");
    missing.replaceChildren();
    if (plan.missing_information.length) {
      for (const question of plan.missing_information) missing.append(element("li", "", question));
    } else {
      missing.append(element("li", "", "No additional gaps were identified from this brief. Confirm details as the build develops."));
    }
    renderResources("tools-list", plan.resources.tools, "Tools not specified");
    renderResources("materials-list", plan.resources.materials, "Materials not specified");
    byId("constraints-summary").textContent = plan.inputs.constraints || "No constraints entered. Confirm dimensions, budget, and timing before committing.";
    submitButton.firstElementChild.textContent = "Update my project plan";
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy) return;
    clearErrors();
    const inputs = readInputs();
    /* I show simple field errors before making a request; the server still
       validates independently when a request reaches the API. */
    const localErrors = {};
    if (!inputs.goal.trim()) localErrors.goal = "Enter a project goal.";
    for (const name of FIELD_NAMES) {
      if (inputs[name].length > FIELD_LIMITS[name]) localErrors[name] = `Use ${FIELD_LIMITS[name]} characters or fewer.`;
    }
    if (Object.keys(localErrors).length) {
      showErrors(localErrors, "Check your project brief before building the plan.");
      return;
    }
    setBusy(true);
    announce("Building your project plan.");
    try {
      const response = await fetch("/api/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify(inputs)
      });
      const data = await response.json();
      if (!response.ok) {
        showErrors(data.errors, data.message || "The project brief could not be processed. Check your entries.");
        return;
      }
      if (!validPlan(data)) throw new Error("Unexpected project plan response.");
      /* Keep the exact submitted strings beside normalized server lists so
         editing a draft can be disclosed without guessing its formatting. */
      data.original_inputs = { ...inputs };
      /* I start a replacement plan with fresh progress and notes so results
         from the previous route are not assigned to newly generated steps. */
      state = { inputs, plan: data, completed: [], notes: {} };
      saveWorkspace();
      renderPlan();
      byId("project-title").focus({ preventScroll: true });
      if (window.matchMedia("(max-width: 800px)").matches) byId("project-title").scrollIntoView({ behavior: "smooth", block: "start" });
      announce(`Project plan ready. ${data.actions.length} suggested steps. Your next action: ${data.actions[0].title}`);
    } catch {
      showErrors({}, "Your plan could not be loaded. Check that ShopBrief is running and try again. Your brief is still here.");
    } finally {
      setBusy(false);
    }
  });

  for (const name of FIELD_NAMES) {
    byId(name).addEventListener("input", () => {
      state.inputs = readInputs();
      byId(name).removeAttribute("aria-invalid");
      byId(`${name}-error`).hidden = true;
      if (state.plan) byId("draft-notice").hidden = !hasDraftChanges();
      saveWorkspace();
    });
  }

  /* I fill the example brief without submitting it, leaving the maker in
     control of when to replace an existing plan. */
  exampleButton.addEventListener("click", () => {
    const example = {
      goal: "Build a wall-mounted paint rack",
      tools: "3D printer, drill, calipers",
      materials: "PETG, plywood, screws",
      constraints: "12-inch width, $30 budget, rounded edges"
    };
    populateInputs(example);
    state.inputs = example;
    clearErrors();
    saveWorkspace();
    if (state.plan) byId("draft-notice").hidden = !hasDraftChanges();
    byId("goal").focus();
    announce("Paint rack example added to the brief. Build the project plan when you are ready.");
  });

  byId("complete-action").addEventListener("click", () => {
    if (!state.plan) return;
    const index = currentActionIndex();
    if (index !== -1) toggleAction(state.plan.actions[index].id);
  });

  noteInput.addEventListener("input", () => {
    const id = noteInput.dataset.actionId;
    if (!id) return;
    state.notes[id] = noteInput.value;
    /* Write each change immediately; delay only the lower roadmap redraw so
       typing and cursor position remain stable in the active notes field. */
    saveWorkspace();
    window.clearTimeout(noteTimer);
    noteTimer = window.setTimeout(renderRoadmap, 350);
  });

  restoreWorkspace();
  renderPlan();
  /* A brief may be restored without a plan. Avoid a misleading initial saved
     label if browser storage was unavailable during that restoration. */
  if (!saveAvailable && !state.plan) announce("Browser saving is unavailable or the previous workspace could not be loaded.");
})();
