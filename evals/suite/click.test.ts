test('click sets the marker', async (td) => {
  await td.find('the "Click me" button').click()
  const ok = await td.assert('the marker shows "clicked"')
  if (!ok) throw new Error('marker did not show clicked')
})
