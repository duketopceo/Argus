test('form: newsletter signup', async (td) => {
  await td.find('the "Email" input').click()
  await td.type('ada@example.com')
  await td.find('the "Subscribe" button').click()
  await td.assert('the page says Subscribed: ada@example.com')
})
