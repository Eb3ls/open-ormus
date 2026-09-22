# Evaluation Pipeline Reference

This reference describes the evaluation code as implemented. It complements [the operator guide](../evaluation/README.md).

## Execution model

Dataset generation is a prerequisite, and it makes external LLM API calls through the shared `generateTurn()` path:

```bash
bun evaluation/generate_dataset.ts <config.yaml>
```

The analysis launcher then creates the next available `eval-XX` directory and starts its three passes concurrently:

```bash
bun evaluation/run_pipeline.ts <dataset-name>
```

```text
generate_dataset.ts
        |
        v
<dataset>/conversations/*.yaml
        |
        +---- Promise.allSettled() ----> judge_guessing
        +------------------------------> reconstruct_persona
        +------------------------------> context_drift
```

The analysis passes are independent consumers of the conversation files. `Promise.allSettled()` lets the launcher retain successful output when another analysis fails. It does not make generation concurrent with analysis.

All entry points require `EVAL_RESULTS_PATH`, `LLM_API_KEY`, and `LLM_BASE_URL`. The result root has no fallback path. Although the harness runs without the application database or authentication services, it invokes the configured LLM provider and therefore is not an offline network workflow.

The individual commands read `eval_name` from their YAML config; it is not a supported positional argument:

```bash
bun evaluation/judge_guessing.ts <config.yaml>
bun evaluation/reconstruct_persona.ts <config.yaml>
bun evaluation/context_drift.ts <config.yaml>
```

`run_pipeline.ts` supplies its generated `eval-XX` name internally and overrides the default configs' `dataset_dir` with the command-line dataset argument.

## Generation

The generator validates `output_dir` as a simple directory name, requires at least one run, and verifies every scenario and character ID against the static YAML datasets. A run has at least two characters, `turns >= 1`, a resolved model, and either `ROUND_ROBIN` or `ORCHESTRATOR`; `ORCHESTRATOR` is rejected for two-character runs.

For each configured run, `runConversation()` creates `turns * number_of_characters` messages. It passes the complete prior conversation to `generateTurn()` for every turn. The stored `ConversationResult` includes scenario metadata, alias names, model, scheduling strategy, timestamps, and the messages' emotion, intensity, subtext, reasoning, and content fields.

Generation uses `Promise.all()` across configured runs, while turns within an individual conversation are generated serially. It writes to:

```text
$EVAL_RESULTS_PATH/<output_dir>/
├── meta.yaml
├── generate-config.yaml
├── conversations/NNN.yaml
└── costs/generation.yaml
```

There is no refusal check for an existing `<output_dir>`. Existing metadata, config, and same-numbered conversations can be overwritten. If any run fails after its retries, the generator recursively removes the entire dataset directory, including any pre-existing material under that name. Treat each output directory as new and disposable while generating; copy complete results before rerunning a name.

The aliases are assigned deterministically from a fixed pool in input character order. The fictional Vethara setting and aliases reduce obvious identity leakage, but cannot establish that a model or provider has no related training-data knowledge.

## Judge Guessing

`runJudgingPass()` loads every conversation YAML and processes conversations in parallel. For one conversation it reconstructs the alias-to-real-name map from character IDs, gives only aliases in the transcript, and supplies the participating dataset profiles to each configured judge. Profile display order is deterministically shuffled from the scenario ID. The judge models run in parallel.

Each output entry has `scenario_id`, `scenario_title`, and one record per judge containing the model, individual alias assignments, evidence strings, and `all_correct`. The config permits one through three judges. The pass writes:

```text
$EVAL_RESULTS_PATH/<dataset>/eval-XX/judge_guessing/
├── config.yaml
└── guessing_result.yaml
```

No code computes `inter_judge_agreement`, aggregate accuracy, or another summary artifact for this pass. Those are analyses of `guessing_result.yaml`, not fields emitted by the current harness.

## Persona Reconstruction

`runReconstructionPass()` skips conversation files that have no messages, then processes the remaining conversations in parallel. A reconstructable conversation must contain at least `2 * segments` messages. `segments` defaults to 1; `segmentConversation()` uses `min(segments, message_count)`, equal-size floor divisions, and puts any remainder in the final segment.

For every character and segment, the reconstructor receives the alias, scenario, and transcript segment, without the ground-truth sheet. For every requested field, each comparator receives the reconstructed items and the corresponding sheet items. Characters, segments, and comparator calls use `Promise.all()` at their respective levels.

The default profile fields are:

```text
personalityTraits, speechPatterns, values, fears, goals, copingStyle
```

Comparator labels become numeric item scores: `match` = 1, `no_match` = 0, and `contradiction` = -1. An item needs a strict majority of configured comparators for 1 or -1; all other cases score 0. Missing comparator item scores also default to `no_match`.

`not_observed` or an empty reconstructed item list yields a raw zero F1 and an empty item list, but those fields are excluded from aggregate means and ground-truth F1 slopes. For observed fields, precision is `matched / observed_count`, recall is `matched / gt_count`, and F1 is their harmonic mean. A field's `contradicted` count is retained in its per-segment record; it is not an aggregate `contradiction_rate`.

For fields with enough observed segment F1s, `gt_divergence_slope` is an OLS slope over their original segment indices. The optional `internal_consistency` comparison scores final-segment reconstructed items against first-segment reconstructed items when both have observations. The summary contains field, difficulty, and character-tier aggregates, `mean_inter_comparator_agreement`, and the ten most negative mean slopes.

The implementation has no special similar-pair comparison path. In particular, it does not run or write A-on-A, B-on-B, A-on-B, and B-on-A comparisons of a pair's `varyingAxis`, and it does not emit pair-differentiation verdicts.

Output:

```text
$EVAL_RESULTS_PATH/<dataset>/eval-XX/reconstruct_persona/
├── config.yaml
├── conversations/NNN.yaml
└── summary.yaml
```

## Context Drift

`runDriftPass()` requires `segments >= 2`. It skips empty conversations and conversations with fewer messages than requested segments, then processes the others in parallel. It exposes real character records, the scenario metadata, prior transcript context, and the current segment to each judge. The judges for a segment are launched with `Promise.allSettled()`; the config accepts one or more judges.

Successful judges vote on scenario engagement (`active`, `touched`, `absent`) and each character's alignment (`consistent`, `neutral`, `contradicts`). A strict majority selects the stored label. Otherwise the label is `touched` or `neutral`. The stored numeric score is the mean score of valid votes: 1.0, 0.5, or 0.0 respectively. A segment has `low_confidence: true` when fewer than two judges succeed, and a segment where all judges fail aborts the conversation and pass.

For each conversation, `total` drift is last numeric segment score minus first score. The code marks it `degrading` below `-0.25`, `improving` above `0.25`, and `stable` otherwise. The pass records adjacent deltas as well as engagement and alignment totals. Its scenario summary provides per-segment engagement counts and mean scores, mean drift per delta, total engagement and alignment drift, and per-character mean total drift.

Output:

```text
$EVAL_RESULTS_PATH/<dataset>/eval-XX/context_drift/
├── config.yaml
├── conversation_results.yaml
└── summary.yaml
```

## API calls, costs, and failure behavior

Analysis LLM calls use streamed chat completions at temperature zero, request JSON-object responses, validate parsed output with pass-specific Zod schemas, and retry up to three attempts. Generation has a separate three-attempt retry loop per configured conversation run. These are provider API calls, not local-only computations.

Each successful call that returns usage metadata is recorded in `costs/<pass>.yaml`. For OpenRouter base URLs, the harness also tries to retrieve cost values by generation ID; failure to retrieve cost information is logged but does not fail an otherwise successful pass.

Before processing, each analysis pass refuses an existing own output directory (`judge_guessing`, `reconstruct_persona`, or `context_drift`) for the selected `eval_name`. After a failure, the affected pass removes its incomplete directory. `run_pipeline.ts` removes the entire `eval-XX` directory only when all three concurrent passes fail; otherwise it preserves completed outputs.

The complete result layout is:

```text
$EVAL_RESULTS_PATH/<dataset>/
├── meta.yaml
├── generate-config.yaml
├── conversations/
├── costs/
│   └── generation.yaml
└── eval-XX/
    ├── meta.yaml
    ├── costs/
    │   ├── judge_guessing.yaml
    │   ├── reconstruct_persona.yaml
    │   └── context_drift.yaml
    ├── judge_guessing/
    ├── reconstruct_persona/
    └── context_drift/
```
