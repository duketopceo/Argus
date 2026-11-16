// Two plain <label for> inputs with no aria-label: grounded through their label text.
test('form: contact (label-only inputs)', async (td) => {
  await td.find('the "Full name" input').click()
  await td.type('Grace Hopper')
  await td.find('the "Phone" input').click()
  await td.type('555-0100')
  await td.find('the "Send message" button').click()
  await td.assert('the page says the message was sent for Grace Hopper')
})
