test('double click sets the marker', async (td) => {
  await td.find('the "Double click me" button').doubleClick()
  const result = await td.assert('the marker shows "dblclicked"')
  if (result.verdict !== 'pass') throw new Error('marker did not show dblclicked')
})
