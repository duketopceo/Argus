test('clicks the button and asserts the marker', async (td) => {
  await td.find('the "Click me" button').click()
  await td.assert('the marker shows "clicked"')
})
