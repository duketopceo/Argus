/**
 * U7 — the standalone audit report for `argus scan <path>`. Deliberately
 * not CodeReviewReport (which is PR/headBinding-shaped) and not the run
 * manifest (which is replay-shaped): a tree audit has no PR, no head
 * binding, and no gate — findings and lane audit trails are the payload.
 */
export const SCAN_REPORT_SCHEMA_VERSION = 1;
