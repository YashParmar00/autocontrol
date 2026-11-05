// These functions are injected into the page with chrome.scripting.executeScript.
// Each must be self-contained (no closures over module scope).

export function extractPage() {
  const SENSITIVE = /(pass(word|wd|code)?|otp|one.?time|cvv|cvc|card.?(number|no)|security.?code|secret|token|api.?key|private.?key|\bpin\b|ssn|aadhaar|\bpan\b|iban|account.?number)/i
  const visible = (el) => {
    const style = getComputedStyle(el)
    const rect = el.getBoundingClientRect()
    return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0
  }
  const labelFor = (el) => {
    if (el.labels && el.labels[0]) return el.labels[0].innerText.trim()
    const aria = el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title')
    if (aria) return aria.trim()
    const labelledBy = el.getAttribute('aria-labelledby')
    if (labelledBy) { const ref = document.getElementById(labelledBy); if (ref) return ref.innerText.trim() }
    const wrapper = el.closest('label, [class*="field"], [class*="form-group"]')
    return wrapper ? wrapper.innerText.trim().split('\n')[0] : ''
  }
  const isSensitive = (el, label) => {
    const type = (el.getAttribute('type') || '').toLowerCase()
    const auto = (el.getAttribute('autocomplete') || '').toLowerCase()
    if (type === 'password' || type === 'hidden') return true
    if (/cc-|one-time-code|current-password|new-password/.test(auto)) return true
    return SENSITIVE.test(`${el.name || ''} ${el.id || ''} ${label}`)
  }
  let counter = 0
  document.querySelectorAll('[data-devc-ref]').forEach((el) => el.removeAttribute('data-devc-ref'))
  const fields = []
  for (const el of document.querySelectorAll('input, textarea, select')) {
    const type = (el.getAttribute('type') || el.tagName).toLowerCase()
    if (['hidden', 'submit', 'button', 'image', 'reset', 'file'].includes(type) || !visible(el)) continue
    const label = labelFor(el).slice(0, 80)
    const sensitive = isSensitive(el, label)
    const ref = `f${++counter}`
    el.setAttribute('data-devc-ref', ref)
    let value = ''
    if (el.tagName === 'SELECT') value = el.options[el.selectedIndex] ? el.options[el.selectedIndex].text : ''
    else if (type === 'checkbox' || type === 'radio') value = el.checked ? 'checked' : 'unchecked'
    else value = el.value || ''
    fields.push({ ref, label, type, name: (el.name || el.id || '').slice(0, 60), value: sensitive ? (value ? '•' : '') : value.slice(0, 200), sensitive })
    if (fields.length >= 80) break
  }
  const buttons = []
  counter = 0
  for (const el of document.querySelectorAll('button, input[type=submit], input[type=button], [role=button], a[role=button]')) {
    if (!visible(el)) continue
    const text = (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 60)
    if (!text) continue
    const ref = `b${++counter}`
    el.setAttribute('data-devc-ref', ref)
    buttons.push({ ref, text, tag: el.tagName.toLowerCase() })
    if (buttons.length >= 60) break
  }
  const links = [...document.querySelectorAll('a[href]')].filter(visible).slice(0, 40)
    .map((a) => ({ text: a.innerText.trim().replace(/\s+/g, ' ').slice(0, 50), href: a.href })).filter((l) => l.text)
  const headings = [...document.querySelectorAll('h1, h2, h3')].filter(visible).map((h) => h.innerText.trim()).filter(Boolean).slice(0, 20)
  // Visible text without the values of inputs (innerText never includes input values).
  const text = (document.body ? document.body.innerText : '').replace(/\n{3,}/g, '\n\n').slice(0, 12000)
  return { url: location.href, title: document.title, headings, text, fields, buttons, links, capturedAt: new Date().toISOString() }
}

export function fillFields(fields) {
  const SENSITIVE = /(pass(word|wd|code)?|otp|one.?time|cvv|cvc|card.?(number|no)|security.?code|secret|token|api.?key|private.?key|\bpin\b|ssn|aadhaar|\bpan\b|iban|account.?number)/i
  const results = []
  for (const { ref, value, allowSensitive } of fields) {
    const el = document.querySelector(`[data-devc-ref="${CSS.escape(ref)}"]`)
    if (!el) { results.push({ ref, ok: false, error: 'field not found — read the tab again' }); continue }
    const type = (el.getAttribute('type') || '').toLowerCase()
    const label = (el.labels && el.labels[0] ? el.labels[0].innerText : el.getAttribute('aria-label') || el.getAttribute('placeholder') || '')
    const sensitive = type === 'password' || /cc-|one-time-code|password/.test(el.getAttribute('autocomplete') || '') || SENSITIVE.test(`${el.name} ${el.id} ${label}`)
    if (sensitive && !allowSensitive) { results.push({ ref, ok: false, error: 'sensitive field — the developer must fill it (or use a vault secret)' }); continue }
    if (el.tagName === 'SELECT') {
      const option = [...el.options].find((o) => o.value === value || o.text.trim() === value)
      if (!option) { results.push({ ref, ok: false, error: 'option not found' }); continue }
      el.value = option.value
    } else if (type === 'checkbox' || type === 'radio') {
      el.checked = value === true || value === 'true' || value === 'checked'
    } else {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set
      el.focus()
      setter.call(el, String(value))
    }
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    el.blur()
    results.push({ ref, ok: true })
  }
  return results
}

export function clickRef(ref) {
  const el = document.querySelector(`[data-devc-ref="${CSS.escape(ref)}"]`)
  if (!el) return { ok: false, error: 'element not found — read the tab again' }
  const text = (el.innerText || el.value || '').trim().slice(0, 60)
  el.scrollIntoView({ block: 'center' })
  el.click()
  return { ok: true, text }
}
