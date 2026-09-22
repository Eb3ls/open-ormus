# Evaluation Pipeline

The evaluation harness tests whether the shared `generateTurn()` implementation carries information from a fictional character sheet into generated dialogue, then evaluates the saved transcripts from three perspectives: alias-to-profile guessing, persona reconstruction, and context drift.

The harness does not require the application's database or authentication services, but it is not offline in the network sense: every generation and analysis pass calls the configured OpenAI-compatible LLM API. Set all three required environment variables before running it:

```bash
export EVAL_RESULTS_PATH=/absolute/path/for/evaluation-results
export LLM_API_KEY=...
export LLM_BASE_URL=https://provider.example/api/v1
```

`EVAL_RESULTS_PATH` is the result-root source of truth. The scripts do not default to `evaluation/results/`; they fail when it is unset. `LLM_BASE_URL` may include a trailing `/v1`, which the scripts normalize before constructing the client.

## Dataset

`evaluation/dataset/characters.yaml` contains 16 fictional character records, and `evaluation/dataset/scenarios.yaml` contains 32 social scenarios. The characters include eight distinctive archetypes (`char_001`–`char_008`) and four deliberately similar pairs (`char_009`–`char_016`):

| Pair | IDs | Declared `varyingAxis` |
| --- | --- | --- |
| Officials | `char_009` / `char_010` | `speechPatterns` |
| Survivors | `char_011` / `char_012` | `copingStyle` |
| Reformers | `char_013` / `char_014` | `fears` |
| Caregivers | `char_015` / `char_016` | `goals` |

The Vethara setting and fictional names reduce the chance of a direct match to well-known real-world characters. They do not demonstrate that the models or providers have no related training-data contamination, so results should not be interpreted as a contamination guarantee.

Each configured generation run chooses a scenario, two or more characters, a model, a number of turns per character, and either `ROUND_ROBIN` or `ORCHESTRATOR` scheduling. `ORCHESTRATOR` is invalid for exactly two characters. The generator assigns aliases from its fixed alias pool in participant order, so the transcript records aliases rather than the dataset characters' real names.

## Run a dataset and its analyses

First generate the reusable transcript corpus:

```bash
bun evaluation/generate_dataset.ts evaluation/configs/generate-dataset.yaml
```

The generate config requires `output_dir` and at least one run. Each run needs `scenario`, at least two `characters`, a positive integer `turns`, and `turn_strategy`; its `model` may inherit from `default_model`.

Generation writes directly below `$EVAL_RESULTS_PATH/<output_dir>/`. It creates the directory if necessary and writes fixed conversation filenames such as `conversations/001.yaml`. It does not refuse an existing dataset name, so reusing one can replace metadata, config, and same-numbered conversation files. If generation ultimately fails, the generator removes its entire dataset directory. Use a new or disposable `output_dir` and preserve completed datasets elsewhere before regenerating.

Then run all three analysis passes against that dataset:

```bash
bun evaluation/run_pipeline.ts <dataset-name>
```

`run_pipeline.ts` requires `$EVAL_RESULTS_PATH/<dataset-name>/conversations/` to exist. It finds the next unused `eval-XX` name under that dataset, then starts Judge Guessing, Persona Reconstruction, and Context Drift concurrently with `Promise.allSettled()`. The passes read the same saved conversations, make separate API calls, and write different output subdirectories. Generation must finish first; the analyses do not depend on one another's results.

For an individual analysis pass, put `eval_name` in that pass's YAML config and run the command with only the config path:

```bash
bun evaluation/judge_guessing.ts evaluation/configs/judge-guessing.yaml
bun evaluation/reconstruct_persona.ts evaluation/configs/reconstruct-persona.yaml
bun evaluation/context_drift.ts evaluation/configs/context-drift.yaml
```

The positional `eval-name` form is not supported by these entry points. A direct pass takes its `dataset_dir` and `eval_name` from the YAML config. Each pass refuses to start if its own output directory already exists, rather than overwriting it.

## What each analysis reports

### Judge Guessing

Judge Guessing asks whether a judge can map the aliases in a transcript to the participating character profiles. For each conversation, the profiles are shuffled deterministically using the scenario ID, then every configured judge independently returns alias-to-real-name assignments and evidence. The output records each assignment's `correct` flag and the judge's `all_correct` flag.

The config accepts one to three judge models. Results are stored at:

```text
$EVAL_RESULTS_PATH/<dataset>/eval-XX/judge_guessing/guessing_result.yaml
```

There is no calculated `inter_judge_agreement` field or dataset-level accuracy summary in this output. Consumers that need those metrics must calculate them from the recorded per-judge assignments.

### Persona Reconstruction

Persona Reconstruction asks a reconstructor to infer observable profile items from each character's transcript segment. Comparator models then label each inferred item against the dataset sheet as `match`, `no_match`, or `contradiction`; a strict majority determines the item score, with ties becoming `no_match`.

By default it evaluates six fields: `personalityTraits`, `speechPatterns`, `values`, `fears`, `goals`, and `copingStyle`. The `fields` config option can restrict that set. `segments` defaults to `1`; a conversation must contain at least twice as many messages as requested segments. Segmentation uses consecutive message windows, putting any remainder in the final window.

For a non-`not_observed` field, the writer records precision, recall, F1, count of contradicted items, item-level comparator votes, and comparator agreement. Fields marked `not_observed` have a raw F1 of zero but are excluded from summary means and F1-slope calculations. With two or more observed segments, it also reports a ground-truth F1 slope and an endpoint internal-consistency comparison.

Results are written to:

```text
$EVAL_RESULTS_PATH/<dataset>/eval-XX/reconstruct_persona/
├── config.yaml
├── conversations/<NNN>.yaml
└── summary.yaml
```

The current summary includes mean field F1, drift and consistency aggregates, difficulty and tier groupings, and `mean_inter_comparator_agreement`. It does not produce a top-level `contradiction_rate`, a pair-differentiation result, or four directional comparisons of a pair's `varyingAxis`. Similar pairs can still be inspected through their ordinary per-character records, but those additional metrics are not implemented outputs.

### Context Drift

Context Drift gives its judge models the scenario, character records, prior messages, and the current segment. It asks for scenario engagement (`active`, `touched`, or `absent`) and per-character alignment (`consistent`, `neutral`, or `contradicts`). It accepts one or more judges and requires `segments >= 2`; conversations with fewer messages than requested segments are skipped.

Labels map to scores of 1.0, 0.5, and 0.0. The reported label requires a strict majority; when no label has one, it falls back to `touched` or `neutral`. The reported numeric score is the mean of the successful judges' label scores. A segment is marked low confidence when fewer than two judges return successfully. The pass fails if every judge fails for a segment.

Drift is last segment score minus first segment score. Totals below `-0.25` are `degrading`, above `0.25` are `improving`, and the remainder are `stable`. The output includes per-conversation segment scores and deltas plus a summary grouped by scenario:

```text
$EVAL_RESULTS_PATH/<dataset>/eval-XX/context_drift/
├── config.yaml
├── conversation_results.yaml
└── summary.yaml
```

## Output layout and retention

After a successful generation and complete analysis run, the relevant directory shape is:

```text
$EVAL_RESULTS_PATH/
└── <dataset>/
    ├── meta.yaml
    ├── generate-config.yaml
    ├── conversations/
    │   └── NNN.yaml
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

The three passes copy their configs into their own subdirectories and update `eval-XX/meta.yaml`. Cost files contain the available usage metadata; when the base URL contains `openrouter.ai`, the harness additionally attempts to fetch costs. Cost-fetch failures are reported but do not fail a completed pass.

On a failure inside an analysis pass, that pass removes its incomplete output directory. `run_pipeline.ts` preserves a partially completed `eval-XX` directory when at least one concurrent pass succeeds; if all three fail, it removes the `eval-XX` directory. This cleanup and the generation behavior above make result-directory backups important for experimental provenance.

For implementation-level details, see [the evaluation pipeline reference](../docs/evaluation-pipeline.md).
