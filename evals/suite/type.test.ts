test('typing fills the name field', async (td) => {
  await td.find('the "Name" input').click()
  await td.type('argus')
  const result = await td.assert('the name input contains the text "argus"')
  if (result.verdict !== 'pass') throw new Error('name input was not filled')
})
