test('click sets the marker', async (td) => {
  await td.find('the "Click me" button').click()
  const result = await td.assert('the marker shows "clicked"')
  if (result.verdict !== 'pass') throw new Error('marker did not show clicked')
})
