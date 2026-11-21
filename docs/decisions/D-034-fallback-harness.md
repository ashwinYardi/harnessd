# D-034 An agent can run on a fallback harness while a hold is on its main harness
Status: accepted 2026-11-21. Issue: MET-70 (part 3, MET-81). Extends D-033.

- `[agents.<name>]` takes two optional keys: `fallback_harness` (a harness id) and `fallback_model` (a string). They merge per layer like `harness` and `model`. Default: no fallback.
- While a hold is on the agent's main harness, its part, QA, grill and plan runs start on the fallback harness and model.
- The loop uses the fallback only when it has an adapter and no hold of its own. Otherwise the run waits in Ready, as D-033 says.
- A fallback that is the same as the main harness is ignored.
- Without `fallback_model`, the fallback harness uses its own default model. The main model is not passed, because it names a model of another harness.
- A limit on a fallback run holds the fallback harness, not the main one.
- The run's start logs "<agent> on <fallback> while <harness> is limited", with display names.
- D-033 still holds: no run starts on a held harness. "The fallback plan" in D-033 is the one-part split plan, not this fallback harness.

Why:
- A Claude Code limit can last hours. An owner with a Codex account can keep the team working in that time.
- The choice is per agent, because a harness and model fit some roles better than others.
