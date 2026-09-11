test('double click sets the marker', async (td) => {
  await td.find('the "Double click me" button').doubleClick()
  const ok = await td.assert('the marker shows "dblclicked"')
  if (!ok) throw new Error('marker did not show dblclicked')
})
