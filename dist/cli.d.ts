#!/usr/bin/env node
import { type CliDeps } from './cli/shared.js';
export declare function main(argv: string[], deps?: CliDeps): Promise<number>;
export { filesFromUnifiedDiff, loadFixture, loadLocalDiff, buildPatchChunks, buildCodeReviewMessages, parseCodeReview, carryForwardSuggestions, diffLineRanges, diffLineTexts, filterRevertNits, filterToDiffLines, P_TRUE_POSITIVE_THRESHOLD, computeReviewEvent, renderReviewComments } from './cli/review-shared.js';
export type { ReviewFinding, ReviewComment, DroppedFinding, ReviewBatch, ReviewScope } from './cli/review-shared.js';
export type { CliDeps } from './cli/shared.js';
