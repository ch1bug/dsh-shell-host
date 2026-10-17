---
name: implement
description: "Implement a piece of work based on a spec or set of tickets."
disable-model-invocation: true
---

Implement the work described by the user in the spec or tickets.

If the user passes a ticket reference, fetch it from the issue tracker and state its title before starting. If the reference is ambiguous, ask.

Call the Skill tool with "tdd" where possible, at pre-agreed seams.

Run typechecking regularly, and single test files regularly.

Call the Skill tool with "code-review" to review the work, and fix what it finds.

Then run the full test suite once — it must start after your last write (a review fix invalidates an earlier run) — and commit your work to the current branch.
