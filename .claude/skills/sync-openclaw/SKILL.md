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

## 4. Deep-compare implementations

For each potentially relevant change:
1. Read the OpenClaw type definitions: `dist/plugin-sdk/browser/*.d.ts`
2. Read the actual implementation bundles (filenames change per version): `dist/plugin-sdk/chrome-*.js`, `dist/plugin-sdk/ssrf-*.js`, `dist/plugin-sdk/pw-ai-*.js`, `dist/plugin-sdk/fs-safe-*.js`
3. Compare against browserclaw source files:
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

## 5. Apply changes

Port each relevant change to browserclaw, adapting for architecture differences. Run `npx tsc --noEmit` to verify.

**Do not remove existing code.** Only add or modify. If you didn't write it, don't delete it.

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
