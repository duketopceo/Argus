// Scoring for the bake-off. Ground truth for fixtures/demo-pr (see its README):
//   T1  double-applied discount            -> finding anchored in src/discount.ts
//   T2  live-format Stripe key             -> finding anchored in .env.example
//   N1  documentation-shaped AWS key       -> a finding in docs/setup.md is a false positive
// Recall = detected planted issues / 2. Precision = findings matching T1/T2 / all findings.
// Ocellus subset has no planted bugs: "noise" is bug+risk findings (post-validation); `invalid`
// counts findings anchored at files/lines absent from the diff (pre-validation, i.e. what the
// validate step drops).
export function scoreDemo(findings) {
  const hit = (re) => findings.some((f) => re.test(f.file ?? ''))
  const t1 = hit(/(^|\/)src\/discount\.ts$/)
  const t2 = hit(/(^|\/)\.env\.example$/)
  const tp = findings.filter((f) => /src\/discount\.ts$|\.env\.example$/.test(f.file ?? '')).length
  const fpDoc = findings.filter((f) => /docs\/setup\.md$/.test(f.file ?? '')).length
  return {
    recall: (Number(t1) + Number(t2)) / 2, t1, t2,
    precision: findings.length ? tp / findings.length : 0,
    findings: findings.length, docKeyFalsePositives: fpDoc,
  }
}
export function scoreNoise(findings, validationDropped = 0) {
  const sev = (s) => findings.filter((f) => f.severity === s).length
  return {
    postFilter: findings.length, bug: sev('bug'), risk: sev('risk'), nit: sev('nit'), q: sev('q'),
    bugRisk: sev('bug') + sev('risk'), invalidDropped: validationDropped, preFilter: findings.length + validationDropped,
  }
}
