test('click: add to cart', async (td) => {
  await td.find('the "Add to cart" button').click()
  await td.assert('the cart shows 1 item')
})
