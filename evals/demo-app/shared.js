// behaviour shared by index.html (recorded UI) and drifted.html (changed UI)
const $ = (id) => document.getElementById(id)
let items = 0
$('add').addEventListener('click', () => {
  items += 1
  $('cart').textContent = `Cart: ${items} item${items === 1 ? '' : 's'}`
})
$('gift').addEventListener('change', (e) => {
  $('giftstate').textContent = `Gift wrap: ${e.target.checked ? 'on' : 'off'}`
})
$('save').addEventListener('click', () => {
  const n = $('name').value.trim()
  const a = $('address').value.trim()
  $('shipstate').textContent = n && a ? `Address saved for ${n}, ${a}` : 'Enter a name and address'
})
$('subscribe').addEventListener('click', () => {
  const v = $('email').value.trim()
  $('substate').textContent = v ? `Subscribed: ${v}` : 'Enter an email address'
})
$('theme').addEventListener('click', () => {
  const dark = document.body.classList.toggle('dark')
  $('themestate').textContent = `Theme: ${dark ? 'dark' : 'light'}`
})
$('order').addEventListener('click', () => {
  $('orderstate').textContent =
    items > 0
      ? `Order confirmed: ${items} item${items === 1 ? '' : 's'}${$('gift').checked ? ', gift wrapped' : ''}`
      : 'Your cart is empty'
})
$('contact-send').addEventListener('click', () => {
  const n = $('contact-name').value.trim()
  const p = $('contact-phone').value.trim()
  $('contactstate').textContent = n && p ? `Message sent for ${n}, phone ${p}` : 'Enter a full name and phone'
})
