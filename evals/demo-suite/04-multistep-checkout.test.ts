test('multi-step: checkout with gift wrap', async (td) => {
  await td.find('the "Add to cart" button').click()
  await td.find('the "Gift wrap" checkbox').click()
  await td.find('the "Place order" button').click()
  await td.assert('the page says the order is confirmed with 1 item, gift wrapped')
})
