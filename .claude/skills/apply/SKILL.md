---
name: apply
description: >-
  Live application assistant -- reads the job application form on screen (or a
  pasted screenshot/questions) and generates personalized, ready-to-paste
  answers from the matched career-ops report and cv.md. Use when the user is
  filling out an application form and wants help answering it. Never submits.
user_invocable: true
user-invocable: true
license: MIT
---

# apply -- Alias for career-ops apply mode

This is a direct shortcut to the `apply` mode of the `career-ops` skill, for when
typing `/career-ops apply` is more than needed. It is not a separate mode --
it loads and executes the exact same instructions.

## Project Root Resolution

Derive `PROJECT_ROOT` the same way `career-ops`'s router does: start at this
skill file's directory and walk upward until the nearest directory containing
both `AGENTS.md` and `modes/`. Resolve every path below against `PROJECT_ROOT`.

## What to load

Read, in order:

1. `modes/_shared.md`
2. `modes/_profile.md` (if it exists)
3. `modes/_custom.md` (if it exists)
4. `modes/apply.md`

Then, before producing any output, read `config/profile.yml` (if it exists) and
apply the Output Language Directive from `career-ops`'s `SKILL.md`: write all
human-facing output in `language.output` (default `en`), keeping any
`language.modes_dir` market vocabulary as context only.

## Execution

Execute `modes/apply.md` exactly as written -- same preflight gates (blacklist,
cross-channel, repeat-application, knock-out questions, immigration-status and
jurisdiction-prohibited-content checks), same workflow steps, same
prepare-don't-submit rule from `AGENTS.md` -> "Ethical Use". If Playwright is
available and the candidate has an active browser tab open, this mode is
best run delegated to a subagent the same way `career-ops`'s router delegates
`apply` (with Playwright):

```python
Agent(
  subagent_type="general-purpose",
  prompt="[output language directive]\n\n[content of modes/_shared.md]\n\n[content of modes/_profile.md if exists]\n\n[content of modes/_custom.md if exists]\n\n[content of modes/apply.md]\n\n[invocation-specific data]",
  description="career-ops apply"
)
```

Without Playwright, or for a quick single-question ask, run it inline instead
of spawning a subagent.
