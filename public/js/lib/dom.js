// Tiny templating: html`...` escapes every interpolated value unless it is
// itself an html`` result (or raw()). Arrays are joined. null/undefined/false render nothing.
import { escapeHtml } from '/shared/format.js';

class SafeHtml {
  constructor(value) {
    this.value = value;
  }
  toString() {
    return this.value;
  }
}

export const raw = (value) => new SafeHtml(String(value));

function render(value) {
  if (value === null || value === undefined || value === false) return '';
  if (value instanceof SafeHtml) return value.value;
  if (Array.isArray(value)) return value.map(render).join('');
  return escapeHtml(value);
}

export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += render(values[i]) + strings[i + 1];
  return new SafeHtml(out);
}

export function setHtml(el, content) {
  el.innerHTML = String(content);
  return el;
}

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

/** Delegated event listener: handler(event, matchedElement). */
export function on(root, type, selector, handler, options) {
  const listener = (event) => {
    const target = event.target.closest(selector);
    if (target && root.contains(target)) handler(event, target);
  };
  root.addEventListener(type, listener, options);
  return () => root.removeEventListener(type, listener, options);
}

/**
 * handler(input) once a date input's value is settled. Chromium reports each typed part of a date as a change
 * (0002, 0020, 0202, 2026…), so a typed date counts when the field is left or Enter is pressed, while a date
 * picked from the calendar counts at once.
 */
export function onDateCommit(root, selector, handler) {
  const keyed = new WeakSet();
  let pending = null;
  const settle = (input) => {
    pending = null;
    keyed.delete(input);
    handler(input);
  };
  root.addEventListener('keydown', (e) => {
    const input = e.target.closest?.(selector);
    if (!input) return;
    if (e.key === 'Enter' && pending === input) {
      e.preventDefault();
      settle(input);
    } else if (e.key !== 'Enter') keyed.add(input);
  });
  root.addEventListener('change', (e) => {
    const input = e.target.closest?.(selector);
    if (!input) return;
    if (keyed.has(input) && document.activeElement === input) pending = input;
    else settle(input);
  });
  root.addEventListener('focusout', (e) => {
    const input = e.target.closest?.(selector);
    if (input && pending === input) settle(input);
  });
}

export function debounce(fn, ms = 200) {
  let timer;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
  wrapped.cancel = () => clearTimeout(timer);
  return wrapped;
}

/** Read a form into a plain object (checkboxes -> booleans). */
export function formData(form) {
  const data = {};
  for (const el of form.elements) {
    if (!el.name || el.disabled) continue;
    if (el.type === 'checkbox') data[el.name] = el.checked;
    else if (el.type === 'radio') {
      if (el.checked) data[el.name] = el.value;
    } else data[el.name] = el.value;
  }
  return data;
}
