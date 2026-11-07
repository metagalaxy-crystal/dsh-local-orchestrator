# dsh-local-orchestrator

**A local resource-scheduling runtime for agents on consumer hardware with limited VRAM.**

It puts LLMs, generative workflows (ComfyUI), one-shot scripts and MCP servers into **one budget table**,
and separates *deciding* from *executing* with **single-step tools + a task state machine** — so an agent
can load, swap, queue and resume local work on an 8 GB card without hand-killing processes.

> Not another agent framework: no LLM loop, no tool protocol, no session/memory layer.
> It answers four questions only: how much VRAM is left, who runs next, how to account for it,
> and who cleans up when something gets stuck.

It is a plugin for [DeepSeek Harness](https://github.com/deepseek-ai) (DSH) and has been developed
and measured on `RTX 5060 Laptop 8GB / 32GB RAM`, Windows.

📖 Full design and measured numbers (Chinese): [docs/OVERVIEW.md](docs/OVERVIEW.md)

## Screenshots

<p align="center">
  <img src="docs/screenshots/01-overview.png" width="49%" alt="Overview: three-segment VRAM bar and asset grid" />
  <img src="docs/screenshots/02-assets.png" width="49%" alt="Assets: framework strip and per-model components" />
</p>
<p align="center">
  <img src="docs/screenshots/03-tasks.png" width="49%" alt="Tasks: per-run node graph" />
  <img src="docs/screenshots/04-usage.png" width="49%" alt="Usage: token ledger and context usage" />
</p>

## What it solves

| Pain | Without a scheduler | With this plugin |
|---|---|---|
| Swap a model, get OOM | kill processes by hand, wait for the driver | GPU mutex + budget table: evict, wait for VRAM to fall, load |
| VRAM math is guesswork | eyeball the parameter count | `min(free, total × (1 - reserve)) - fixed`, backfilled from real loads |
| Long tasks die with the session | rerun from scratch | task state machine persisted to disk; `running → paused` on restart, resumable |
| One session hogs the GPU | others wait | lease table rounds across sessions; max 1 consecutive step |
| No idea where tokens/money go | "it feels slow" | token ledger: which asset, how many tokens, tok/s, context usage |
| Model file deleted, still called | crash mid-run | connectivity checks: missing files are flagged and skipped by routing |

## Three core pieces

| Piece | What it does |
|---|---|
| **Budget table** | one account for LLM / workflows / scripts / MCP: who occupies how much VRAM |
| **Single-step tool** | one call advances one step; `local_step` and the background worker share one `StepRunner` |
| **Task state machine** | `queued → running → waiting_decision → done`; cross-session, persisted, resumable |

> Decision authority stays in the host, execution authority lives in the plugin, and the task state is
> the only contract between them.

## Nine tools

`local_resources` · `local_assets` · `local_chat` · `local_service` · `local_delegate` ·
`local_generate` · `local_audio` · `local_task` · `local_step`

Assets are *resources* addressed by an `asset` parameter and picked by the scheduler (VRAM fit, strengths,
already loaded). Not one-tool-per-model: tool schemas go into context every turn.

## Reproducible numbers

```bash
node scripts/bench.mjs
```

| Metric | Value |
|---|---|
| Task recovery after crash/restart | **100% (20/20)** |
| Max consecutive GPU steps across sessions | **1** |
| Per-step overhead | **2.5–2.6 ms** |

Measured on the reference machine: 3B model cold start 39.8–45.4 s, 512×512 image 44.8 s,
4.8 s TTS audio 19.9 s (RTF 4.15).

## Quick start

```bash
git clone https://github.com/metagalaxy-crystal/dsh-local-orchestrator.git
dsh plugin add ./dsh-local-orchestrator   # adjust to your DSH version
```

Restart DSH, open the **Local Scheduling** tab, then either import assets from a directory or add
a single asset (UI "＋ Add asset", or just ask the agent to call
`local_assets {"action":"add","asset":{"id":"my-qwen","gguf":"text/my-qwen/model.gguf"}}`).

Verify end-to-end:

```jsonc
// one chat call
{"prompt":"hello"}
// or a task, one step at a time
{"action":"create","goal":"write a slogan","steps":[{"goal":"write a slogan","kind":"llm"}]}
{"action":"run","taskId":"task-xxxx"}
```

## Limitations (honest list)

- **Windows VRAM attribution**: WDDM hides per-process VRAM (`nvidia-smi` shows `[N/A]`); only totals and
  before/after deltas are reliable.
- First estimate per asset is a guess until a real load backfills it.
- **Small local models plan badly**: a 3B model rarely emits valid JSON plans. JSON mode + one retry +
  degraded single-step fallback are in place, but prefer DeepSeek or an 8B-MoE local model for planning.
- Process/script handling is polished on Windows; Linux works but is not individually tested.
- Single GPU only (no multi-GPU or cluster scheduling).

## Development

```bash
node test/stats.test.js     # run one file (sandboxes may block `node --test`)
node scripts/bench.mjs      # three benchmarks
npm run verify              # tool verification ledger (only changed tools need re-verification)
```

Assets are described in `catalog.json`; each asset is one loadable local service with optional components
(encoder / VAE / vocoder / mmproj) that are hidden from scheduling.

## License

MIT
