test('click: order with empty cart is refused', async (td) => {
  await td.find('the "Place order" button').click()
  await td.assert('the page says the cart is empty')
})
