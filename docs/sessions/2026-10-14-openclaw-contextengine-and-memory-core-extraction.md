# Session Archive — 2026-10-14

OpenClaw ContextEngine implementation, engine rename, and standalone memory-core extraction.

## Summary

This session delivered three pieces of work on the AIAgentLocalMemory project, plus
diagnostics for two runtime issues.

## 1. OpenClaw ContextEngine (host-side compaction)

OpenClaw's `slots.contextEngine = "neural-context"` was declared but the adapter never
implemented the `ContextEngine` interface — it only provided a memory capability, so the
slot was a dangling pointer.

- Added `packages/adapter-openclaw/src/context-engine.ts` implementing
  `assemble` / `compact` / `ingest` / `info{ownsCompaction:true}`, wired to core's
  host-agnostic `runCompartmentTransform`.
- All OpenClaw-specific logic (AgentMessage <-> neutral opencode-shape conversion,
  usagePct estimation mirroring OpenClaw's `estimateContextTokens`, the ContextEngine
  interface) stays in the adapter layer; core is never made aware OpenClaw exists.
- `assemble` fails safe by passing messages through untouched so a bug can never break a turn.
- Registered via `api.registerContextEngine` with exclusive-slot conflict handling.
- Verified live: added diagnostic logging to `assemble`, restarted the gateway, and
  confirmed from `/tmp/neural-openclaw-assemble.log` that OpenClaw calls our engine on
  every turn (in=N out=N, estTok~16000/budget=128000 ~ 12%, matching the dashboard's 12%).
- Commits: `75b443c` (implementation), plus the diagnostic build deployed to
  `~/.openclaw/extensions/neural-context/dist/`.

### Gateway restart note
The gateway initially failed to start because `talk.realtime` referenced a missing
`HAI_API_KEY` env var (unrelated to our plugin — it crashed in the secrets-resolution
phase before plugins loaded). Per user decision, the `talk` block was temporarily
removed from `~/.openclaw/openclaw.json` (backed up to
`openclaw.json.bak-ctxengine-20261002-082522`) so the gateway could start. The voice
key can be restored later via the launchd plist's EnvironmentVariables.

## 2. Rename NeuralContextEngine -> NeuralMemoryEngine

The class name contained "Context" which misleadingly implied context
compression/rendering, but it is purely the memory engine
(ingest/remember/recall/associate/decay/consolidate).

- First rename commit `4ec2c6c` was incomplete — it missed `engine.ts` (the class
  definition itself), the `INeuralContextEngine` interface, the `index.ts` export, and
  all adapter/server call sites (15 occurrences across 7 files).
- Completed in `733b0fa`: renamed everywhere, verified zero remaining occurrences of
  `NeuralContextEngine`, and confirmed `build.sh` passes.

## 3. Standalone memory-core extraction -> SAP repo

Extracted the memory layer into a new standalone repository
`github.tools.sap/I027910/AIAgentUnifyMemroy` (user decisions: core + example adapter;
copy-and-diverge; code only, no data).

- `@ai-agent-unify-memory/core` — NeuralMemoryEngine, spreading activation, Hebbian
  learning, lightweight + embedding linking, cross-session linking, deduplication,
  hierarchical abstraction, operation log (16 memory files + 4 providers).
- `@ai-agent-unify-memory/storage-sqlite` — SQLite provider (nodes/edges/FTS) with
  Bun/Node runtime shim.
- `@ai-agent-unify-memory/adapter-example` — minimal init -> ingest -> recall example.
- Intentionally excluded: historian, compartments, context-renderer, context-compressor,
  compactor, transform-helpers (all context-compression / rendering).
- Verified: `bun install`, `bun build` for core (79KB) and storage (16.77KB), `.d.ts`
  generation clean (added `allowImportingTsExtensions`), and the example typechecks
  against the real API.
- Apache-2.0 LICENSE + README with integration guide.
- Pushed as commit `fe6116f`.
- Local working copy moved from `/tmp` to `~/Desktop/ju/projects/AIAgentUnifyMemroy`.

## Open items (diagnosed, not resolved — deferred)

- **"Thought ... then no output" on the huge session** (opencode.db = 2.2G): transform
  works (out=144, user message preserved); the failure is after transform, in the
  LLM-return path — suspected hai-proxy SSE frame-boundary issue. Not a plugin bug.
- **GitHub Pages Chinese shows as boxes**: not an encoding problem — source `mkdocs.yml`,
  the local `site/`, and the git-tracked `site/` all contain valid UTF-8 Chinese. Root
  cause is the deploy/build mismatch: `site/` was committed into git (build artifacts
  should not be), and the Pages deploy serves/builds without a guaranteed UTF-8 locale.
  Fix (deferred to another session): remove `site/` from git, force `LANG/LC_ALL=C.UTF-8`
  in the CI build step, and confirm the Pages Source is "GitHub Actions".
