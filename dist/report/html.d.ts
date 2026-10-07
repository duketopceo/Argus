/**
 * Offline HTML evidence report (plan U14, R22; DESIGN.md 7.6, A17).
 *
 * One self-contained `report.html` beside `run-manifest.json`: verdict,
 * lanes, findings, flow timeline, heals and spend ledger. Every asset is
 * inline (tokens, WOFF2 subsets as data URIs, the glyph sprite), so the file
 * opens from an artifact zip with no network. Assets come from the generated
 * module, never from assets/ on disk, so a packed install renders it too.
 *
 * Pure: the caller reads the files, this shapes them. Every interpolated
 * string goes through `esc`, which masks secret-shaped tokens and escapes
 * HTML. Inputs are untrusted JSON; a corrupt manifest renders the unreadable
 * state and a missing lane renders unavailable, never a throw.
 */
export declare const REPORT_HTML = "report.html";
export interface ReportHtmlInput {
    /** run-manifest.json file text; undefined when the file is absent. */
    manifestText: string | undefined;
    /** Parsed code-review.json of this run, when the review lane wrote one. */
    codeReview?: unknown;
    /** Parsed run.json of this run, when the flow lane wrote one. */
    run?: unknown;
    /** Argus version shown in the footer. */
    version: string;
    /** Workflow run page (evidence and artifacts). */
    runUrl?: string;
}
export declare function renderReportHtml(input: ReportHtmlInput): string;
