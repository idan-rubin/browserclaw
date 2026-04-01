---
name: sync-openclaw
description: Sync browserclaw with the latest OpenClaw browser SDK changes
disable-model-invocation: true
---

# Sync from OpenClaw

Sync browserclaw with upstream OpenClaw browser SDK changes. Follow every step.

## 1. Check versions

```bash
npm root -g          # find global install
npm view openclaw version  # latest on npm
# check installed version in the global openclaw package.json
```

Compare installed vs latest. If outdated, run `npm install -g openclaw@latest`.

## 2. Read the changelog

Read `CHANGELOG.md` in the openclaw package. Check MEMORY.md sync history to know what version was last synced.

## 3. Identify browser-relevant changes

From the changelog, find entries tagged Browser/, Security/, or that mention CDP, SSRF, navigation, snapshot, accessibility, download, upload, trace, evaluate, form fields, or Playwright.

Skip anything that is:
- Extension-relay-specific
- CLI/config-only
- Gateway/server-side only
- Channel/messaging/plugin-specific
- OpenClaw profile/decoration-specific (browserclaw has its own simpler profile system)

## 4. Diff OpenClaw against browserclaw

For each potentially relevant change, **diff** the OpenClaw implementation against the corresponding browserclaw source to identify the specific lines that differ. Only carry forward the actual differences — new lines added or existing lines modified in OpenClaw.

OpenClaw sources:
- Type definitions: `dist/plugin-sdk/browser/*.d.ts`
- Implementation bundles: `dist/plugin-sdk/chrome-*.js`, `dist/plugin-sdk/ssrf-*.js`, `dist/plugin-sdk/pw-ai-*.js`, `dist/plugin-sdk/fs-safe-*.js`

Browserclaw source mapping:
- CDP/connection → `src/connection.ts`
- Chrome launching → `src/chrome-launcher.ts`
- Accessibility snapshots → `src/snapshot/aria-snapshot.ts`, `src/snapshot/ai-snapshot.ts`
- Ref map → `src/snapshot/ref-map.ts`
- Page interactions → `src/actions/interaction.ts`
- Navigation → `src/actions/navigation.ts`
- Security/SSRF → `src/security.ts`
- Downloads → `src/actions/download.ts`
- Traces → `src/capture/trace.ts`
- Types → `src/types.ts`
- Evaluate → `src/actions/evaluate.ts`

Type signatures alone don't reveal logic changes — always read the JS bundle implementation.

**Browserclaw will have code that OpenClaw does not.** That is expected — it's browserclaw-only functionality. If something exists in browserclaw but not in OpenClaw, that is not a diff to act on. Ignore it.

## 5. Apply diffs

For each diff identified in step 4, edit only the specific lines that changed in OpenClaw. Do not overwrite or rewrite entire files or functions. Do not remove existing code — if you didn't write it, don't delete it.

Run `npx tsc --noEmit` to verify after each file change.

## 6. Bump, build, commit

- Bump version in `package.json`
- `npm run build`
- Run `node scripts/check-exports.js` — **abort if it fails**
- Commit as `"Updates from OpenClaw YYYY.M.DD"`
- **ASK the user before running `npm publish`** — never publish without explicit approval

## 7. Update memory

Add a sync history entry to MEMORY.md with version, OpenClaw version, and summary of changes ported (and notable skips).

## Double-check checklist

Before committing, verify:
- [ ] TypeScript compiles clean (`npx tsc --noEmit`)
- [ ] New exports added to `src/index.ts` if any public API was added
- [ ] No unnecessary dependencies added
- [ ] No browserclaw-only APIs were removed (run `node scripts/check-exports.js`)
- [ ] Commit message follows format: `"Updates from OpenClaw YYYY.M.DD"`
