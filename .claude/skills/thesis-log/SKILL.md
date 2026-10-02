---
name: thesis-log
description: Add or update an entry in THESIS_DOCUMENTATION.md — a decision (D#), research result (R#), problem (P#), open question (Q#), or timeline milestone. Use when the user asks to log/record/note something for the thesis, or whenever a decision, research finding, or problem occurs during work.
---

# Thesis log

Records the thesis process in `THESIS_DOCUMENTATION.md` (project root).

## Steps

1. **Read** `THESIS_DOCUMENTATION.md` to find the right section and the next free ID for that type.
2. **Classify** what happened (it can be more than one; e.g. a research result often creates a problem and a proposed decision):
   - decision → Decision log
   - research → Research log
   - problem → Problems log
   - question → Open questions
   - milestone → Timeline
3. **Write or update** the entry using the formats below. Update an existing entry if it is the same item (e.g. a decision going from Proposed to Accepted); otherwise add a new one.
4. **Cross-link** related entries in both directions (decision ↔ research ↔ problem ↔ question).
5. **Report** to the user in one line, in Turkish: what was logged.

If the user's input is vague (e.g. `/thesis-log D6 onaylandı`), infer the details from the conversation; ask only if the content truly can't be determined.

## Formats

### Decision log (table row)
```
| D# | YYYY-MM-DD | <decision, one sentence> | <why, with refs like "see R1"> | <Status> |
```
Status: `Proposed` · `Accepted` · `Rejected` · `Superseded by D#`.
When a status changes, edit the row and append the date of the change, e.g. `Accepted (2026-10-03)`.

### Research log (subsection)
```
### R#: <topic> (YYYY-MM-DD)

**Question:** <what we wanted to find out>

<what was found: facts, measurements, tables>

**Findings:**
- ✅ / ⚠️ / ❌ <finding>

**Conclusion:** <one or two sentences>

**Sources:**
- [title](url)
```
Mark vendor claims and unverified numbers explicitly. Include how something was tested (command, setup) when it was tested by us.

### Problems log (subsection)
```
### P#: <short title> (YYYY-MM-DD)
- **Context:** <what we were doing>
- **Problem:** <what went wrong, with exact error text if any>
- **Impact:** <what it blocks or affects>
- **Resolution:** <what was done or proposed, with refs to D#>
- **Status:** Open · Workaround · Resolved (YYYY-MM-DD)
```

### Open questions (table row)
```
| Q# | <question> | <current thinking; when answered: "Answered by D#"> |
```

### Timeline (table row)
```
| YYYY-MM-DD | <milestone> |
```

## Rules
- Thesis-level only. Do not log small implementation issues: ordinary bugs, minor algorithm tweaks, refactors, constant tuning. If something is borderline, ask the user.
- `Accepted` only after the user explicitly confirms. Everything else is `Proposed`.
- IDs are sequential per type and never reused. Never delete entries.
- English only in the document; absolute dates only.
- Keep entries factual and short: they are raw material for the thesis text, not the text itself.
