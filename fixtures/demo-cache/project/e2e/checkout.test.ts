test('checkout', async (td) => {
  await td.find('the "Place order" button').click()
  await td.assert('the page says the order is confirmed')
})
