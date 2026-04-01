# OpenClaw Sync

Sync browserclaw with the latest OpenClaw browser SDK changes. Creates a PR with a single commit.

## Source of Truth

OpenClaw's bundled JS files — NOT the changelog:
- `pw-ai-*.js` — all browser action functions
- `ssrf-*.js` — SSRF/IP security
- `client-fetch-*.js` — connection, chrome launcher, navigation guards (previously `routes-*.js`, before that `thread-bindings-*.js`)

Locate them by grepping for known functions:
```
OC_DIST=$(npm root -g)/openclaw/dist
grep -rl 'clickViaPlaywright' "$OC_DIST" --include='*.js' | grep -v node_modules | grep -v plugin-sdk
grep -rl 'isBlockedSpecialUseIpv6Address' "$OC_DIST" --include='*.js' | grep -v node_modules | grep -v plugin-sdk
grep -rl 'isChromeReachable' "$OC_DIST" --include='*.js' | grep -v node_modules | grep -v plugin-sdk
```
Bundle filenames contain hashes that change between versions. Never hardcode them.

## Known Differences Registry

`sync/known-differences.md` tracks every intentional divergence. If a difference isn't in that file, it's a bug that needs porting.

## Function Map

`sync/function-map.md` maps every browserclaw function to its OpenClaw source. Update it if new functions appear.

## Process

### Phase 1: Discovery

1. Check installed OpenClaw version: `npm list -g openclaw --depth=0`
2. Locate the 3 bundle files (filenames contain hashes that change between versions)
3. Read the changelog for context — but DO NOT rely on it as complete

### Phase 2: Deterministic Inventory

Before any agent-based comparison, build a complete mechanical inventory of what's in each OC bundle. This step is fully deterministic — no agent judgment involved.

**Step 2a: Region extraction.** OC bundles contain `//#region src/...` and `//#endregion` markers. Extract all region names and line ranges from each bundle file:
```bash
grep -n '#region\|#endregion' "$BUNDLE_FILE"
```
Record every region and which bundle it lives in. OC restructures bundles between releases — code that was in one bundle last sync may have moved.

**Step 2b: Export extraction.** Each bundle ends with an export line mapping internal names to exported names. Extract all exported symbols:
```bash
tail -5 "$BUNDLE_FILE" | grep 'export {'
```

**Step 2c: Function extraction.** Extract all `function functionName(` definitions from each bundle. This catches internal helpers that aren't exported:
```bash
grep -n 'function [a-zA-Z_][a-zA-Z0-9_]*(' "$BUNDLE_FILE"
```

**Step 2d: Cross-reference against browserclaw.** For every exported symbol AND every function name in the function map (`sync/function-map.md`), verify it exists in browserclaw's source files. Flag any OC function not found in browserclaw for investigation.

**Step 2e: Discover new bundles.** Search ALL `.js` files in the OC dist directory for browserclaw-relevant function names (every function in `sync/function-map.md`). Flag any matches in bundles not previously known — OC moves code between bundles regularly.

**Gate:** Complete inventory of all OC regions, exports, and functions. Every item mapped to a browserclaw file or flagged as "new/moved."

### Phase 2f: Agent Comparison (3 parallel workstreams)

Using the inventory from 2a-2e, run 3 parallel comparison workstreams. Each workstream receives the specific regions and line ranges it needs to compare — NOT "read the whole file and find things."

**Chunking large files:** OC bundle files can be 3000+ lines. Agents miss things in large reads. When passing bundle content to a workstream agent, break it into chunks using the region markers from 2a. Each agent should read one region at a time (using line offsets), compare it against the corresponding browserclaw code, then move to the next region. Never ask an agent to "read the entire bundle" — always specify line ranges.

**Workstream A: Security**
- Read specific OC regions identified in 2a that map to `src/security.ts` (by line range)
- Also read any OC bundle regions containing navigation guard functions (by line range)
- Read browserclaw's `src/security.ts`
- Compare every function, constant, IP range, hostname set

**Workstream B: Browser Actions**
- Read specific OC regions identified in 2a that map to action/capture/storage/snapshot (by line range)
- Read ALL browserclaw action/capture/storage/snapshot files
- Compare every `*ViaPlaywright` function and internal helpers

**Workstream C: Connection & Chrome Launcher**
- Read specific OC regions identified in 2a that map to connection/chrome-launcher (by line range)
- Read browserclaw's `src/connection.ts` and `src/chrome-launcher.ts`
- Compare every function

Each workstream categorizes every difference as:
- **In registry** — known intentional difference in `sync/known-differences.md`, skip
- **New gap** — needs porting
- **New function** — needs evaluation (port or add to registry as "not applicable")
- **Browserclaw ahead** — browserclaw has something OpenClaw doesn't, keep

**Evidence requirement for "New gap":** Every gap MUST include:
1. The exact OpenClaw code (copy-pasted from the bundle, not paraphrased)
2. The exact browserclaw code
3. A clear description of what changed in OpenClaw

If you cannot copy-paste the OpenClaw code that proves the gap exists, it is NOT a gap. Do not invent or infer changes — only report what you can see verbatim in the bundle files.

**Per-function known-differences check:** For every function that has ANY difference (not just "New gap"), look up that function name in `sync/known-differences.md`. If it has an entry marked "Browserclaw ahead", "Browserclaw Additions", or any intentional divergence, that function's browserclaw code must be preserved — even if OpenClaw changed other parts of the same function. Log which functions were protected by this check.

**Gate:** All 3 workstreams complete. Every difference categorized. Zero uncategorized items.

### Phase 2g: Coverage Verification

After workstreams complete, verify completeness:

1. **Export coverage check:** Take the export list from 2b. For every exported symbol that maps to a browserclaw function, verify the workstreams compared it. Any symbol NOT mentioned in a workstream report is a coverage gap — investigate it directly.

2. **New-function check:** Take the function list from 2c. Cross-reference against `sync/function-map.md`. Any function not in the map and not in a workstream report needs investigation.

3. **Moved-code check:** Take the results from 2e. If any browserclaw-relevant function appeared in an unexpected bundle, verify the workstreams found it there.

**Gate:** 100% of OC exports and mapped functions were covered by a workstream. Zero uncovered items.

### Phase 3: Port Changes

For each "New gap" and applicable "New function":

**Provenance verification (MANDATORY before any edit):**
For every gap you are about to port, re-read the specific function directly from the OpenClaw bundle file yourself. Do NOT rely on the workstream agent's report alone. Confirm with your own eyes that the OpenClaw code differs from browserclaw in the way the workstream described. If you cannot find the claimed difference in the actual bundle file, the gap is fabricated — discard it and move on.

**Before touching any function, do the per-function known-differences check:**
1. Search `sync/known-differences.md` for the function name
2. If the function has an entry:
   - **"Browserclaw ahead"** or **"Browserclaw Additions"** — DO NOT port OpenClaw's version of that code. The browserclaw implementation is intentionally better/newer. Preserve it exactly as-is, even if OpenClaw changed the surrounding function.
   - **Other intentional divergence** — preserve the browserclaw side of the divergence. Only port parts of the function that are unrelated to the registered difference.
3. If the function has NO entry, port the change normally

**When porting:**
- Never change a public function's return type or shape. If OpenClaw changed a return type, do NOT port that change — flag it for explicit user approval instead.
- Never introduce OpenClaw branding. Any `openclaw` in data attributes (e.g. `data-openclaw-*`), CSS class names, IDs, or user-visible strings must be changed to `browserclaw` when porting.
- If a new intentional difference is created, add it to `sync/known-differences.md` with reason

**Gate:** All changes ported. `npm run typecheck` and `npm run build` pass.

### Phase 4: Two Clean Passes

The sync is not complete until TWO independent clean passes confirm zero unregistered gaps. Agent comparison is non-deterministic — a single pass can miss things. Two consecutive clean passes provide confidence.

**Pass 1:** Re-run Phase 2 comparison (full deterministic inventory + agent workstreams) on the modified files. Every remaining difference must be in the known-differences registry. If there's an unregistered difference, port it or add it to the registry with justification, then restart Pass 1.

**Pass 2:** Run a THIRD comparison with fresh agents (not continuations of previous agents). These agents must not see the results of Pass 1 — they start from scratch. If Pass 2 finds anything Pass 1 missed, port it, then restart from Pass 1.

Only when both passes return zero unregistered gaps does the sync proceed to Phase 5.

**Gate:** Two consecutive clean passes with zero unregistered differences.

### Phase 5: Record & PR

1. Update `sync/function-map.md` if new functions appeared
2. Update `sync/known-differences.md` if new intentional differences added
3. If no changes were needed, report "No changes needed" and stop
4. If changes were made:
   - Create branch: `sync/openclaw-YYYY.M.DD` (use the OpenClaw **release version date**, not today's date)
   - Single commit: `Updates from OpenClaw YYYY.M.DD`
   - Create PR with title: `Updates from OpenClaw YYYY.M.DD`
   - PR body: summary of what changed

## Phase 6: Self-Improvement

After every sync run (whether changes were needed or not):

### 1. Log the run
Append an entry to `sync/run-log.md`:

```
## YYYY.M.DD — OpenClaw X.Y.Z

**Result:** [Changes ported / No changes needed]
**Gaps found:** [count and summary]
**What went well:** [e.g., "workstream parallelization caught a missed constant"]
**What was hard/slow:** [e.g., "thread-bindings search took 3 attempts to find the right region"]
**False positives:** [differences flagged as gaps that turned out to be intentional]
**Action taken:** [what was changed in the process files below]
```

### 2. Review and update the process
Read `sync/run-log.md` for recurring patterns across runs. Then make changes:

- **This skill file** (`.claude/commands/sync.md`) — if a phase was slow, unclear, or produced false positives, rewrite it. If a new step is needed, add it. If a step is wasteful, remove it.
- **`sync/known-differences.md`** — if a false positive keeps appearing, add it to the registry so it's never flagged again. If a known difference is no longer valid, remove it.
- **`sync/function-map.md`** — if functions were hard to find, add region line numbers or better search hints.

### 3. Validate the changes
Re-read the updated files and confirm they're internally consistent. Don't leave stale references.

The goal: every run should make the next run faster and more accurate. If the same problem appears twice, the process has a bug.

## Critical Rules

- **Single commit, always.** Every sync PR must have exactly ONE commit. Never split changes across multiple commits. Stage everything, commit once: `Updates from OpenClaw YYYY.M.DD`
- PR title = commit message
- No Co-Authored-By, no AI mentions
- Never publish to npm
- If zero gaps found, just say "No changes needed" — don't create empty PRs
- **Never revert "Browserclaw ahead" items.** If `sync/known-differences.md` says browserclaw's version is better/newer/correct (entries #7, #16, #17, #28-#36, and any in the "Browserclaw Additions" section), that code is OFF LIMITS. Do not replace it with OpenClaw's version under any circumstances. Do not remove functions, methods, or features that exist only in browserclaw.
- **Never change public API return types.** If OpenClaw changed the return shape of a function that browserclaw exports, do NOT port that change. Flag it for user approval.
- **No OpenClaw branding in browserclaw.** When porting code, replace any `openclaw` references in data attributes, class names, IDs, or user-visible strings with `browserclaw`.
- **Never fabricate changes.** Every change you port MUST exist verbatim in the OpenClaw bundle files. If you cannot point to the exact line in the bundle that differs from browserclaw, the change does not exist. Do not invent improvements, fixes, or features and attribute them to OpenClaw. When in doubt, report "No changes needed" rather than guessing.

## browserclaw Source Files

- `src/security.ts` — SSRF, IP parsing, navigation guards, file safety
- `src/connection.ts` — CDP connection, page state, ref storage
- `src/chrome-launcher.ts` — Chrome detection, launch, CDP utilities
- `src/actions/interaction.ts` — click, hover, type, drag, select, scroll, highlight, file upload
- `src/actions/navigation.ts` — navigate, create/close/focus pages, resize
- `src/actions/download.ts` — download with cancellable waiter
- `src/actions/wait.ts` — wait conditions
- `src/actions/evaluate.ts` — JS evaluation with timeout
- `src/actions/emulation.ts` — device, locale, timezone, headers, geo, credentials
- `src/actions/keyboard.ts` — key press
- `src/capture/screenshot.ts` — screenshot with labels
- `src/capture/trace.ts` — trace start/stop
- `src/capture/response.ts` — response body interception
- `src/capture/pdf.ts` — PDF generation
- `src/capture/activity.ts` — console, errors, network
- `src/snapshot/aria-snapshot.ts` — ARIA tree snapshot
- `src/snapshot/ai-snapshot.ts` — AI snapshot
- `src/snapshot/ref-map.ts` — ref building
- `src/storage/index.ts` — cookies, storage
- `src/types.ts` — type definitions
