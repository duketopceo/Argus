test('click: switch to dark mode', async (td) => {
  await td.find('the "Dark mode" button').click()
  await td.assert('the page shows Theme: dark')
})
