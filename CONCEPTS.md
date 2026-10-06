# Concepts

> Shared domain vocabulary for this project — entities, named processes, and status concepts with project-specific meaning. Seeded with core domain vocabulary, then accretes as ce-compound and ce-compound-refresh process learnings; direct edits are fine. Glossary only, not a spec or catch-all.

## Review pipeline

### Finding
A structured issue emitted by the review model — carries a file, an optional line, a severity, a category, a message, and a suggestion. Findings flow through parsing, deterministic filters, adjudication, and optional probe linkage before any become posted comments.

### Blocking severity
A severity level the operator's configuration treats as gating. The presence of at least one blocking-severity finding in the emitted set is what turns a review into a change request; the configured set, not the model's judgment, defines what blocks.

### Gate signals
The trio of derived outputs every review produces from the same post-filter, post-union finding set: **verdict** (the outcome class — pass, approve, or needs_changes), **ok** (the commit-status boolean), and **reviewEvent** (the GitHub review event the action posts). All three are derived from one shared blocking-severity source so they cannot disagree; the model's own verdict is retained only as a divergent opinion, never trusted as the gate.

### Verdict-driving finding
A finding that must survive positional and content filters because dropping it could flip the gate open — high severities, the security category, or any configured blocking severity. Filters may be aggressive about what gets *posted* but must never erase what gets *decided*.

### Dropped finding
An audit record of a finding removed by a deterministic filter, kept on the report so precision improvements remain inspectable rather than silent.

### Rules lane
The named deterministic checks (secrets, hardcoded endpoints, leftover markers, synchronous calls) that scan the materialized merge-base diff alongside the model review. Its findings union into the emitted set after synthesis and adjudication so model output can never erase them, and every hit — surfaced or suppressed — is kept as an audit record. Enabled set comes from `review.rules`; an empty list disables the lane.

### Severity ceiling
The rule that a deterministic finding cannot claim the top severity without adjudicated confidence riding on it — only a finding carrying a confidence probability keeps that severity, everything else demotes and the demotion is audited. It exists because gate signals trust severity, so deterministic lanes must not be able to escalate on regex evidence alone.

## Review-quality corpus

### Ground-truth item
A synthetic corpus entry whose correct findings and verdict are known in advance; every finding it produces is judged, never sampled.

### precisionOnly item
A real-PR snapshot in the corpus with no planted defects — it exists to measure false-positive rate, so its findings are the ones sampled for judging rather than judged exhaustively.

### Planted finding
A defect deliberately introduced into a ground-truth fixture at a recorded location, used to measure recall — did the reviewer catch a bug it was guaranteed to face?

### Judge
The per-finding LLM scorer used by the eval harness; it reads a finding against the item's actual diff and scores whether it is real, correctly located, correctly severitied, and actionable.
