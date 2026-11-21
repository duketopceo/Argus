test('form: shipping address', async (td) => {
  await td.find('the "Name" input').click()
  await td.type('Ada Lovelace')
  await td.find('the "Address" input').click()
  await td.type('12 Elm Street')
  await td.find('the "Save address" button').click()
  await td.assert('the page says the address was saved for Ada Lovelace')
})
