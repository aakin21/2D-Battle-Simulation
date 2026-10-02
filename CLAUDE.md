# Project instructions

This is a thesis project. Phase 1 (baseline simulation, commit `5a96495`) is a finished checkpoint; Phase 2 adds AI integration (see `THESIS_DOCUMENTATION.md`).

## Thesis documentation rule

`THESIS_DOCUMENTATION.md` is the record of the thesis process. Do not update it while a topic is still being discussed. Discuss first; write entries only when the user asks or confirms (e.g. "bunu kaydet"), or at the end of a topic after asking the user.

Record an entry when:
- **A decision is proposed or changes status:** a proposal is put forward, or the user explicitly accepts or rejects one. → Decision log (`D#`)
- **Research is done:** a question is investigated (docs, web, API tests, experiments, benchmarks). → Research log (`R#`)
- **A thesis-level problem is encountered:** something blocks the plan, an assumption turns out wrong, or a limitation forces a design change. → Problems log (`P#`)
- **A question is raised or answered.** → Open questions (`Q#`): add it, or update its notes and point to the decision that answered it.
- **A milestone is reached.** → Timeline

What NOT to record: small implementation issues: ordinary bugs, typos, minor algorithm tweaks, refactors, tuning a constant. Record only what matters at thesis level: decisions about the design or the research direction, research results, and problems that change the plan or the architecture or are worth discussing in the thesis. When unsure, ask the user instead of logging.

Decision status: a decision is `Accepted` only when the user explicitly confirms it. Proposals from the professor or from Claude, and options under discussion, are `Proposed`.

How to write entries:
- Follow the `thesis-log` skill (`.claude/skills/thesis-log/SKILL.md`) for each section's format.
- IDs are sequential and never reused. Never delete an entry: superseded decisions get status `Superseded by D#`, resolved problems get status `Resolved`.
- Use absolute dates (YYYY-MM-DD). Cross-reference related entries (`see R1`, `D7`).
- Write the documentation in English. Discussion with the user is in Turkish.
- Record facts as they happened, with sources for research. Mark vendor claims or unverified numbers as such.
- After updating, tell the user in one line what was logged (e.g. "Logged: D8 accepted, P1 resolved").
