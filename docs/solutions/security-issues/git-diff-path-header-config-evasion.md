---
title: Machine-parsed git diffs must pin diff.* path config — ambient gitconfig silently empties the scan surface
module: review-pipeline
date: '2026-10-05'
problem_type: security_issue
component: tooling
symptoms:
  - 'deterministic scan lanes report "ran clean" while silently scanning zero files'
  - 'rulesScan/secretsScan records empty on diffs that visibly contain hits'
  - 'findings absent for files whose paths need git C-quoting (spaces, non-ASCII, control bytes)'
  - 'a dotted-quad-prefixed hostname (127.0.0.1.evil.com) suppressed as "loopback"'
root_cause: missing_validation
resolution_type: code_fix
severity: high
related_components:
  - development_workflow
tags:
  - git-diff
  - parser-hardening
  - ambient-config
  - evasion
  - c-quote-escape
  - loopback-boundary
  - deterministic-rules
---

# Machine-parsed git diffs must pin diff.* path config — ambient gitconfig silently empties the scan surface

## Problem

Adversarial review of the U8 deterministic ruleset lane found three parse-layer evasions where the scanner reported success while scanning nothing (or the wrong file): git C-quoted `+++ "b/..."` headers were not parsed, ambient `diff.*` gitconfig rewrote the `+++ b/` prefixes the walker keys on, and a dotted-quad-prefixed domain captured its IP prefix and suppressed as loopback. Every one is silent: no error, no skipped reason, just absent findings.

## Symptoms

- A file named `my f.ts` or `f\u00E9e.ts` (git C-quotes such paths) produced zero audit records — the walker never attributed its added lines.
- On a host with `[diff] noprefix = true` or `dstPrefix`/`mnemonicPrefix` set, `git diff` emits `+++ path` or `+++ custom/path` — the `+++ b/` matcher misses every file and the lane reports a clean scan.
- `const u = 'https://127.0.0.1.evil.com/x'` matched the IP-URL regex at the `127.0.0.1` prefix and was suppressed as `loopback/unspecified host` — a domain literal posing as a loopback IP.
- `materializeMergeBaseDiff` (the local merge-base producer feeding the secrets+rules lanes) ran `git diff` with no `diff.*` pins even though the other two producers already carried `DIFF_PREFIX_FLAGS`.

## What Didn't Work

Nothing attempted — the class was latent. Per-file review missed it because each file looked correct in isolation: the walker handled `+++ b/` faithfully, and the producers each had some subset of pins. It took adversarial review checking *every producer* against *every config knob* to see the shared invariant was enforced nowhere consistently.

## Solution

Three coordinated fixes on `feat/u8-ruleset-lane`:

**Pin the path-header schema on every producer** — `src/review/difftext.ts` exports `GIT_DIFF_PATH_FLAGS` and every `git diff` invocation that feeds a machine-parsed lane must spread it into argv:

```ts
export const GIT_DIFF_PATH_FLAGS = [
  'diff.mnemonicPrefix=false',
  'diff.noprefix=false',
  'diff.srcPrefix=a/',
  'diff.dstPrefix=b/',
  'core.quotePath=false',
].flatMap((kv) => ['-c', kv])

// every producer:
['git', [...GIT_DIFF_PATH_FLAGS, '-C', cwd, 'diff', `${baseSha}..HEAD`]]
```

**Accept the quoted form in the walker** — `parsePlusPlus` handles both `+++ b/path` and `+++ "b/path"`, and `unquoteGitPath` decodes git's C-escapes *byte-wise*: `\NNN` octal escapes are raw UTF-8 bytes, so the decode goes through a byte array (`Buffer.from(bytes).toString('utf8')`) — `String.fromCharCode` per escape produces `fÃ©e.ts`, not `fée.ts`. The walker also resets `file` on each `diff --git` so a section with no parseable `+++` can't inherit the previous file's path.

**Right-boundary the IP capture** — a dotted quad followed by `.` or a word char is a domain, not an IP literal:

```ts
const IP_URL_RE = /https?:\/\/(\d{1,3}(?:\.\d{1,3}){3})(?![\w.])/
const IP_ASSIGN_RE =
  /\b(?:host|addr|address|ip|endpoint|server|url|baseurl|base_url)\w*\s*[:=]\s*['"`]?(\d{1,3}(?:\.\d{1,3}){3})(?![\w.])/i
```

## Why This Works

A machine-parsed `git diff` is a schema contract, and git makes that schema user-configurable: `diff.noprefix`, `diff.srcPrefix`/`dstPrefix`, `diff.mnemonicPrefix`, and `core.quotePath` all rewrite the headers the parser keys on. Trusting ambient config is trusting the environment — pinning `-c` flags makes the emitted schema the parser's own contract regardless of host gitconfig. The quoted-header acceptance is belt-and-suspenders for producers a future author adds without the flags (or for diffs produced elsewhere), and the byte-wise unescape mirrors git's actual quoting semantics (byte-level, not codepoint-level). The IP right-boundary closes a suppression-channel evasion: suppression must never be reachable from an attacker-controlled string prefix.

## Prevention

- **Audit rule**: grep for `'diff'` inside every `exec('git', ...)` call — if the output is parsed for `+++`/`---`/`@@` headers, the argv must include `GIT_DIFF_PATH_FLAGS`. `tests/unit/secrets.test.ts` asserts all five pins on `materializeMergeBaseDiff`'s argv; extend that assertion to any new producer.
- **Walker edge coverage**: `tests/unit/difftext.test.ts` pins quoted/escaped headers, `+++ /dev/null`, multi-hunk numbering, malformed hunks, metadata lines, `+++`-inside-hunk content, and section-reset carryover.
- **Suppression boundary rule**: any regex whose capture drives a suppression reason needs a right boundary — verify a hostile suffix (`<literal>.evil.com`, `<literal>-bad`) cannot reach the suppression path. `tests/unit/review-rules.test.ts` covers the loopback-suffix case.
- **When reviewing a new diff consumer**, ask which gitconfig knobs could reshape its output and whether each is pinned or accepted.

## Related Issues

- `docs/solutions/architecture-patterns/deterministic-post-parse-filters-and-verdict-derivation.md` — sibling contract: the other half of "the report must describe what the deterministic lanes actually saw" is that status signals derive from the post-filter, post-union finding set.
- `src/review/difftext.ts` — the shared added-line walker and `GIT_DIFF_PATH_FLAGS`; `src/review/secrets.ts` `materializeMergeBaseDiff` was the unpinned producer.
- Issue #152 / PR for `feat/u8-ruleset-lane` — the U8 ruleset lane where adversarial review surfaced the class.
