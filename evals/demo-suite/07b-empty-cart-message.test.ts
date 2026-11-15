// Replaces 07-empty-cart-guard. 07's assertion ("the cart is empty") is already true on the
// untouched page ("Cart: 0 items"), so it could pass without the click landing. This one
// asserts text that only exists after "Place order" is clicked.
test('click: order with empty cart shows a refusal message', async (td) => {
  await td.find('the "Place order" button').click()
  await td.assert('the page shows the message "Your cart is empty"')
})
