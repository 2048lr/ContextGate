function toast(msg, type = 'info') {
  const container = document.getElementById('toast-container')
  if (!container) return
  const el = document.createElement('div')
  el.className = `toast toast-${type}`
  el.textContent = msg
  container.appendChild(el)
  requestAnimationFrame(() => el.classList.add('show'))
  setTimeout(() => {
    el.classList.remove('show')
    el.addEventListener('transitionend', () => el.remove())
  }, 3000)
}

module.exports = { toast }
