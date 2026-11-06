// Sign in / create account.
import { api } from '../lib/api.js';
import { html, setHtml, formData } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { busy, showFormError, clearErrors } from '../lib/ui.js';

export default async function authView(root, { mode, query, onAuthed }) {
  document.title = mode === 'register' ? 'Create account · eBilling' : 'Sign in · eBilling';
  let config = { demo: null };
  try {
    config = await api('/auth/config');
  } catch {
    // Demo hint is optional.
  }

  const loginForm = html`
    <h2>Welcome back</h2>
    <p class="sub">Sign in to manage your bills and stock.</p>
    <form novalidate data-form="login">
      <div class="field"><label for="email">Email</label>
        <input class="input" id="email" name="email" type="email" autocomplete="username" required autofocus></div>
      <div class="field"><label for="password">Password</label>
        <input class="input" id="password" name="password" type="password" autocomplete="current-password" required></div>
      <button class="btn btn-primary btn-lg btn-block" type="submit">Sign in</button>
    </form>
    ${config.demo ? html`
      <div class="demo-box">
        <strong>Just exploring?</strong> Open the demo store — it's filled with sample products, customers and bills
        (all clearly marked <span class="badge badge-demo">Demo</span>).
        <div><button type="button" class="btn btn-sm" data-demo>${icon('eye')}Use demo account</button></div>
      </div>` : ''}
    <p class="auth-switch">New here? <a href="/register">Create a free account</a></p>`;

  const registerForm = html`
    <h2>Create your account</h2>
    <p class="sub">Set up your business in under a minute.</p>
    <form novalidate data-form="register">
      <div class="field"><label for="business_name">Business name</label>
        <input class="input" id="business_name" name="business_name" required autofocus maxlength="120" placeholder="e.g. Sharma General Store"></div>
      <div class="field"><label for="name">Your name</label>
        <input class="input" id="name" name="name" autocomplete="name" required maxlength="80"></div>
      <div class="field"><label for="email">Email</label>
        <input class="input" id="email" name="email" type="email" autocomplete="email" required></div>
      <div class="field"><label for="password">Password</label>
        <input class="input" id="password" name="password" type="password" autocomplete="new-password" minlength="8" required>
        <span class="field-hint">At least 8 characters.</span></div>
      <label class="check"><input type="checkbox" name="load_demo" checked>
        <span>Add sample products &amp; customers<div class="check-desc">Marked as demo data so you can practise billing. Remove them any time from Settings.</div></span></label>
      <button class="btn btn-primary btn-lg btn-block" type="submit">Create account</button>
    </form>
    <p class="auth-switch">Already have an account? <a href="/login">Sign in</a></p>`;

  setHtml(root, html`
    <div class="auth">
      <section class="auth-side">
        <div class="logo"><span class="brand-mark">${icon('rupee')}</span>eBilling</div>
        <div>
          <h1>Bills, stock and payments — in one simple place.</h1>
          <p>Create bills in seconds, keep inventory accurate automatically, and share bills on WhatsApp.</p>
          <ul>
            <li>${icon('check')}Fast billing with product search &amp; barcode entry</li>
            <li>${icon('check')}Stock updates the moment a bill is finalized</li>
            <li>${icon('check')}Track paid, partly paid and unpaid bills</li>
            <li>${icon('check')}Secure, revocable invoice links for customers</li>
          </ul>
        </div>
        <div style="color:#bfdbfe;font-size:13px">Your business data is private to your account.</div>
      </section>
      <section class="auth-main"><div class="auth-card">${mode === 'register' ? registerForm : loginForm}</div></section>
    </div>`);

  const form = root.querySelector('form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearErrors(form);
    const data = formData(form);
    const required = mode === 'register' ? ['business_name', 'name', 'email', 'password'] : ['email', 'password'];
    const missing = required.find((k) => !String(data[k] || '').trim());
    if (missing) {
      showFormError(form, { field: missing, message: 'This field is required.' });
      return;
    }
    await busy(e.submitter || form.querySelector('[type=submit]'), async () => {
      try {
        const me = await api(mode === 'register' ? '/auth/register' : '/auth/login', { method: 'POST', body: data });
        onAuthed(me, query.next);
      } catch (err) {
        showFormError(form, err);
      }
    });
  });

  root.querySelector('[data-demo]')?.addEventListener('click', (e) => {
    form.email.value = config.demo.email;
    form.password.value = config.demo.password;
    form.requestSubmit();
    e.currentTarget.disabled = true;
  });

  if (query.next && mode === 'login') {
    root.querySelectorAll('a[href="/register"]').forEach((a) => a.setAttribute('href', `/register?next=${encodeURIComponent(query.next)}`));
  }
  return () => {};
}
