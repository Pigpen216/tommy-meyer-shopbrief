# Usability testing

ShopBrief v1.0.0 — October 21, 2026

**Method:** Simulated maker-project scenario. This is not a human-participant session or a physical build.

**Scenario:** Plan a freestanding plywood organizer for calipers, pencils, and a steel ruler. Available resources included hand tools and a plywood offcut. Constraints included a 250 × 150 mm maximum footprint, a $20 budget, and one evening of work.

**Tasks exercised:** Enter the project brief, generate a plan, interpret the first recommended action, record a working note, mark a demonstration step complete, and reload the project.

| Finding | Change or result |
|---|---|
| The first recommendation referred to mounting despite the freestanding project. | Revised instructions make mounting and attachment measurements conditional; the retest showed the corrected wording. |
| The planner asked for available work time even though “one evening” was entered. | Updated time-constraint recognition; the retest removed the redundant question. |
| The completed action’s note was not visible in the next action’s note field. | The note remained available in the completed step’s details. A clearer cue remains a possible future improvement. |
| Project details and completion progress needed to survive a reload. | The scenario confirmed that the brief, saved note, and step status were restored in the same browser. |

**Outcome:** The simulated task identified usability issues, two wording improvements were made, and the same scenario was retested. Automated tests are included in the repository for independent execution. The simulation does not represent interviews with real participants or verification of a physical fabrication project.
