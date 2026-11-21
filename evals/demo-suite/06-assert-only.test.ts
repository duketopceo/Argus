// A failing td.assert marks the test failed by itself (td.assert returns a result
// object, not a boolean), so these are positive assertions only.
test('assertion: initial state', async (td) => {
  await td.assert('the page lists a Field notebook priced at $12.00')
  await td.assert('the cart shows 0 items')
  await td.assert('the page has Shipping and Newsletter sections')
})
