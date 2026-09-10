test('fixture click', async (td) => {
  await td.find('the "Click me" button').click()
  await td.assert('the marker text shows "marker:clicked"')
})
