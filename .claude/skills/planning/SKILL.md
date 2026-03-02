# Planning Skill

## Core Philosophy
A plan is a commitment to the simplest path that actually works. Every step must be grounded in research, not assumption. The output is always a living `PLAN.md` — not a chat message, not a summary, a file.

User request: $ARGUMENTS

---

## When to Use This Skill
- User asks to plan, design, architect, or outline anything non-trivial
- A task has more than one meaningful decision point
- You're about to take agentic action across multiple files or systems

**Do NOT use this skill for:**
- Single-step tasks ("rename this variable")
- Tasks where the full approach is already unambiguous

---

## Pre-Planning: Read Context First

Before writing a single plan step, read these files if they exist. Never skip this.

```bash
cat PLAN.md 2>/dev/null || echo "No PLAN.md found"
cat CLAUDE.md 2>/dev/null || echo "No CLAUDE.md found"
```

**What to extract from each:**

`CLAUDE.md` — tech stack, conventions, constraints, forbidden patterns, testing approach. These are hard constraints. A plan step that violates CLAUDE.md is invalid.

`PLAN.md` — if it exists, determine: Is this a new plan replacing the old one? A continuation? A revision of specific steps? Never silently overwrite a PLAN.md without understanding what's already there.

---

## Step 1: Research Before Writing

For **every** step you intend to include in the plan, do agentic research first. A step you haven't researched is a guess, not a plan.

### What research looks like per step type

**Codebase steps** — read the relevant files before planning changes to them.
```bash
grep -r "relevant_function_or_pattern" --include="*.py" -l
cat src/relevant/file.py
```

**Architecture / design steps** — check what already exists before proposing structure.
```bash
find . -name "*.md" | head -20
ls -la src/
git log --oneline -10
```

**External dependency steps** — verify the dependency exists, is compatible, and is not already present.
```bash
pip show package-name 2>/dev/null
cat requirements.txt | grep package-name
```

**Unknown territory steps** — if you don't have enough information to research a step locally, flag it explicitly in the plan with a `[NEEDS RESEARCH]` marker rather than guessing.

### Research standard
Each step must pass this test before being written: *"Could I execute this step right now without discovering anything surprising?"* If no, research more.

---

## Step 2: Draft the Plan (Simplest Form)

Write the plan after research, not during. Apply these constraints:

### Simplicity rules
- **Minimum steps.** If two steps can be one, make them one.
- **No speculative steps.** Don't include "we might also want to..." — if it's not required, it's not in the plan.
- **No redundant verification steps.** Build verification into the step that needs it, don't add a standalone "verify the above worked" step.
- **Flat over nested.** Avoid sub-steps unless a step genuinely has two separable phases. Prefer 8 clean steps over 4 steps with 3 sub-bullets each.
- **Concrete actions only.** Every step must be an action, not a description. "Update the auth middleware to reject expired tokens" not "Handle token expiry."

### Step format
```
## Step N: [Imperative verb phrase]
**What:** One sentence describing the action.
**Why:** One sentence — only include if non-obvious.
**Files:** `path/to/file.py`
**Verify:** How you know this step succeeded.
```

Omit **Why** if obvious. Omit **Files** if the step doesn't touch specific files. Keep **Verify** on every step.

### Before finalizing: apply the CLAUDE.md filter
Read back through every step and check it against CLAUDE.md constraints. A step that conflicts with a project convention is invalid — revise it or find a different approach.

---

## Step 3: Write PLAN.md

Always write the plan to `PLAN.md` in the project root. Never output the plan only to chat.

### PLAN.md structure
```markdown
# Plan: [Task name]

**Goal:** One sentence — what does success look like?
**Constraint source:** CLAUDE.md reviewed ✓ / not present
**Prior plan:** replaced / continued / none
**Created:** YYYY-MM-DD

---

## Step 1: [Imperative verb phrase]
**What:** ...
**Why:** ... (if non-obvious)
**Files:** `...`
**Verify:** ...

## Step 2: ...

---

## Open Questions
[Any [NEEDS RESEARCH] items or unresolved decisions. Omit if none.]

## Out of Scope
[Things considered but excluded. Makes scope explicit so it doesn't creep back in.]
```

Write the file to disk — not just to chat output.

---

## Step 4: Present and Confirm

After writing `PLAN.md`:

1. Tell the user the plan is written and give a one-line summary: what it covers, how many steps.
2. Ask if they want to proceed, revise, or adjust scope before execution begins.

Do not begin executing without confirmation unless the user has explicitly said to proceed automatically.

---

## Updating an Existing PLAN.md

- **Completing steps** — mark `[DONE]`, don't delete. History matters.
- **Revising steps** — annotate inline: `[REVISED: switched from X to Y because ...]`
- **Adding steps** — append; don't reorder unless the user asks for a full replan.
- **Replacing the plan entirely** — archive the old one as `PLAN_archive_YYYYMMDD.md` before overwriting.

---

## Checklist

- [ ] Read CLAUDE.md — hard constraints extracted
- [ ] Read existing PLAN.md — intent understood, no silent overwrites
- [ ] Researched every step before writing it
- [ ] No speculative or optional steps included
- [ ] Every step is a concrete action with a verify condition
- [ ] Plan passes the CLAUDE.md constraint filter
- [ ] PLAN.md written to disk
- [ ] User asked to confirm before execution begins