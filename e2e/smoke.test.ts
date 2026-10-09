// Dogfood target for `argus run` — this is the td-DSL (ambient `test`/`td`
// globals, src/api.ts), NOT vitest. The root argus-reviewer.config.ts points
// `testsDir` here; running it needs a model key. Do NOT move this file under
// tests/: the vitest glob would pick it up and fail (`td` is undefined
// there). tests/unit/test-coverage-glob.test.ts pins this location.
test('fixture click', async (td) => {
  await td.find('the "Click me" button').click()
  await td.assert('the marker element shows "clicked"')
})
