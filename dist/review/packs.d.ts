/**
 * Review prompt packs (roadmap E1.U2): named rubric blocks appended to the
 * code-review prompt. Packs shape the rubric only — findings still flow
 * through the same severity gate, dedup, adjudication, and cap path, so a
 * pack can shift recall but cannot bypass posting policy.
 *
 * The `security` pack's deterministic half is the secrets lane
 * (`src/review/secrets.ts`) — regex candidates over the local merge-base
 * diff, adjudicated by the confidence model, masked in every output. It runs regardless of
 * profile selection; the rubric below additionally tunes the model toward
 * security-shaped defects.
 */
export declare const REVIEW_PROFILES: readonly ["security", "perf", "debloat"];
export type ReviewProfile = (typeof REVIEW_PROFILES)[number];
export declare function isReviewProfile(value: string): value is ReviewProfile;
/**
 * Render the rubric section for the configured profiles. Returns undefined
 * when no valid profile is configured so the prompt stays byte-identical to
 * the no-packs form.
 */
export declare function packRubric(profiles: readonly string[] | undefined): string | undefined;
