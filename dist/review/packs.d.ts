/**
 * Review prompt packs (roadmap E1.U2 + competitive U10): named rubric blocks
 * appended to the code-review prompt. Packs shape the rubric only — findings
 * still flow through the same severity gate, dedup, adjudication, and cap
 * path, so a pack can shift recall but cannot bypass posting policy.
 *
 * The `security` pack's deterministic half is the secrets lane
 * (`src/review/secrets.ts`) — regex candidates over the local merge-base
 * diff, adjudicated by the confidence model, masked in every output. It runs regardless of
 * profile selection; the rubric below additionally tunes the model toward
 * security-shaped defects.
 *
 * Language packs (U10 / #154) auto-select from the chunk's file extensions
 * and stack under any configured profiles. `review.langPacks: false` (or
 * `ARGUS_REVIEW_LANG_PACKS=0`) disables them.
 */
export declare const REVIEW_PROFILES: readonly ["security", "perf", "debloat"];
export type ReviewProfile = (typeof REVIEW_PROFILES)[number];
export declare function isReviewProfile(value: string): value is ReviewProfile;
/** Language pack ids in stable declaration order (U10). */
export declare const LANG_PACK_IDS: readonly ["ts", "py", "go", "sql"];
export type LangPackId = (typeof LANG_PACK_IDS)[number];
export declare function isLangPackId(value: string): value is LangPackId;
/**
 * Select language packs for a chunk from its file paths. Unknown extensions
 * contribute nothing. Order follows `LANG_PACK_IDS`.
 */
export declare function selectLangPacks(files: readonly string[]): LangPackId[];
/**
 * Render the rubric section for configured profiles and optional language
 * packs. Returns undefined when neither contributes a block so the prompt
 * stays byte-identical to the no-packs form.
 */
export declare function packRubric(profiles: readonly string[] | undefined, langIds?: readonly string[] | undefined): string | undefined;
