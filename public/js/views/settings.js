import { api } from '../lib/api.js';
import { html, setHtml, formData } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { toast, toastError, confirmDialog, busy, showFormError, clearErrors, showFieldError, openModal, loading } from '../lib/ui.js';
import { CURRENCIES, formatMoney, invoiceNumber } from '/shared/format.js';

const BILL_COLORS = [
  ['#f26b1d', 'Studio orange'], ['#e11d48', 'Rose'], ['#7c3aed', 'Violet'],
  ['#2563eb', 'Blue'], ['#0d9488', 'Teal'], ['#16a34a', 'Green'], ['#ca8a04', 'Gold'], ['#16181d', 'Black'],
];

export default async function settings(el, { app }) {
  app.setTitle('Settings');

  function render() {
    const b = app.business;
    setHtml(el, html`
      <div class="page-header">
        <div><h1>Settings</h1><div class="subtitle">Business details, bills, payments and your account.</div></div>
      </div>
      <form class="stack" data-settings novalidate>
        <section class="card">
          <div class="form-section">
            <h3>Business profile</h3><p class="muted">Shown at the top of every invoice.</p>
            <div class="row" style="gap:16px;margin-bottom:16px;align-items:center">
              <div class="logo-preview">${b.logo_url ? html`<img src="${b.logo_url}" alt="Business logo">` : 'No logo'}</div>
              <div class="stack" style="gap:6px">
                <div class="row" style="gap:8px">
                  <button type="button" class="btn btn-sm" data-action="upload-logo">${icon('upload')}${b.logo_url ? 'Change logo' : 'Upload logo'}</button>
                  ${b.logo_url ? html`<button type="button" class="btn btn-sm btn-danger" data-action="remove-logo">Remove</button>` : ''}
                </div>
                <span class="field-hint">PNG or JPEG, up to 1 MB. A square image works best.</span>
                <input type="file" accept="image/png,image/jpeg" class="hidden" data-logo-input>
              </div>
            </div>
            <div class="form-grid">
              <div class="field span-all"><label>Business name <span class="req">*</span></label>
                <input class="input" name="name" value="${b.name}" maxlength="120" required></div>
              <div class="field"><label>Phone</label><input class="input" name="phone" type="tel" value="${b.phone}" maxlength="20"></div>
              <div class="field"><label>Email</label><input class="input" name="email" type="email" value="${b.email}" maxlength="254"></div>
              <div class="field span-all"><label>Website</label>
                <input class="input" name="website" value="${b.website}" maxlength="120" placeholder="e.g. www.yourstudio.com" autocomplete="off" spellcheck="false"></div>
              <div class="field span-all"><label>Address</label>
                <textarea class="input" name="address" rows="3" maxlength="500">${b.address}</textarea>
                <span class="field-hint">Your phone, email, website and address are printed at the bottom of every bill.</span></div>
            </div>
          </div>
        </section>

        <section class="card">
          <div class="form-section">
            <h3>Bill design</h3><p class="muted">How your bills look — on screen, in PDFs and on the customer's link.</p>
            <div class="design-grid">
              <div class="stack" style="gap:14px">
                <div class="field"><label>Tagline <span class="muted">(under your name)</span></label>
                  <input class="input" name="tagline" value="${b.tagline}" maxlength="80" placeholder="e.g. A Complete Design Solution"></div>
                <div class="field"><span class="label">Colour</span>
                  <div class="swatches">
                    ${BILL_COLORS.map(([hex, label]) => html`<button type="button" class="swatch ${hex === b.bill_color ? 'active' : ''}" data-color="${hex}" style="--sw:${hex}" title="${label}" aria-label="${label}"></button>`)}
                    <label class="swatch-custom" title="Pick any colour"><input type="color" data-color-input value="${b.bill_color}" aria-label="Custom colour"></label>
                  </div>
                  <input type="hidden" name="bill_color" value="${b.bill_color}"></div>
                <div class="field"><span class="label">Header</span>
                  <div class="segmented">
                    <button type="button" data-header="dark" class="${b.bill_header === 'dark' ? 'active' : ''}">Dark</button>
                    <button type="button" data-header="light" class="${b.bill_header === 'light' ? 'active' : ''}">Light</button>
                  </div>
                  <input type="hidden" name="bill_header" value="${b.bill_header}">
                  <span class="field-hint">Dark suits logos made for dark backgrounds; Light suits logos with dark lettering.</span></div>
              </div>
              <div class="bill-preview" data-bill-preview aria-hidden="true">
                <div class="bp-band"><span class="bp-logo">${b.logo_url ? html`<img src="${b.logo_url}" alt="">` : ''}</span>
                  <span><span class="bp-name">${b.name}</span><span class="bp-tag" data-bp-tag>${b.tagline}</span></span>
                  <span class="bp-no">BILL<br><b>INV-0001</b></span></div>
                <div class="bp-accent"></div>
                <div class="bp-body"><span class="bp-line"></span><span class="bp-line short"></span>
                  <span class="bp-stamp">Paid</span><span class="bp-balance">Balance</span></div>
                <div class="bp-film"></div>
              </div>
            </div>
          </div>
        </section>

        <section class="card">
          <div class="form-section">
            <h3>Bills &amp; payments</h3><p class="muted">Numbering, how customers pay you, and the text printed on bills.</p>
            <div class="form-grid">
              <div class="field"><label>Bill number prefix</label>
                <input class="input" name="invoice_prefix" value="${b.invoice_prefix}" maxlength="12" placeholder="INV-"></div>
              <div class="field"><label>Next bill number</label>
                <input class="input" name="next_invoice_no" inputmode="numeric" value="${b.next_invoice_no}">
                <span class="field-hint" data-next-preview></span></div>
              <div class="field span-all"><label>UPI ID for payments</label>
                <input class="input" name="upi_id" value="${b.upi_id}" maxlength="100" placeholder="e.g. deveshstudio@okaxis" autocomplete="off" spellcheck="false">
                <span class="field-hint">Bills you share include a <strong>Pay now</strong> link: the customer's UPI app (Google Pay, PhonePe, Paytm…) opens with the balance filled in. The PDF gets a QR code to scan.</span></div>
              <div class="field span-all"><label>Payment details</label>
                <textarea class="input" name="payment_details" rows="2" maxlength="500" placeholder="e.g. Bank: A/c 1234, IFSC ABCD0001234">${b.payment_details}</textarea>
                <span class="field-hint">Printed on bills so customers know how to pay.</span></div>
              <div class="field span-all"><label>Terms &amp; conditions</label>
                <textarea class="input" name="invoice_terms" rows="2" maxlength="1000">${b.invoice_terms}</textarea></div>
            </div>
          </div>
        </section>

        <section class="card">
          <div class="form-section">
            <h3>Currency &amp; rounding</h3><p class="muted">Used for new bills. Bills already created keep their amounts.</p>
            <div class="form-grid">
              <div class="field"><label>Currency</label>
                <select class="input" name="currency">${Object.entries(CURRENCIES).map(([code, c]) =>
                  html`<option value="${code}" ${code === b.currency ? 'selected' : ''}>${code} — ${c.name} (${c.symbol.trim()})</option>`)}</select>
                <span class="field-hint" data-currency-preview></span></div>
            </div>
            <div class="stack" style="gap:12px;margin-top:16px">
              <label class="check"><input type="checkbox" name="round_off" ${b.round_off ? 'checked' : ''}>
                <span>Round bill totals to the nearest whole unit<div class="check-desc">Adds a “Round off” line, e.g. ₹1,053.40 → ₹1,053.00.</div></span></label>
            </div>
          </div>
        </section>
        <div class="sticky-actions"><button type="submit" class="btn btn-primary btn-lg">${icon('check')}Save settings</button></div>
      </form>

      <section class="card" id="demo" style="margin-top:16px">
        <div class="form-section">
          <h3>Demo data</h3>
          ${app.me.has_demo_data ? html`
            <p class="muted">Your account contains sample products, customers and bills marked <span class="badge badge-demo">Demo</span>.
              Remove them before you start real billing — your own data is not touched.</p>
            <button type="button" class="btn btn-danger" data-action="remove-demo">${icon('trash')}Remove all demo data</button>`
          : html`
            <p class="muted">No demo data in this account. Load sample products and customers to practise — they're clearly marked and easy to remove.</p>
            <button type="button" class="btn" data-action="load-demo">${icon('package')}Load demo products &amp; customers</button>`}
        </div>
      </section>

      <section class="card" style="margin-top:16px">
        <form class="form-section" data-password novalidate>
          <h3>Account</h3><p class="muted">Signed in as <strong>${app.me.user.email}</strong>.</p>
          <div class="form-grid cols-3">
            <div class="field"><label>Current password</label><input class="input" type="password" name="current_password" autocomplete="current-password"></div>
            <div class="field"><label>New password</label><input class="input" type="password" name="new_password" autocomplete="new-password" minlength="8"></div>
            <div class="field"><label>Confirm new password</label><input class="input" type="password" name="confirm_password" autocomplete="new-password"></div>
          </div>
          <div style="margin-top:14px"><button type="submit" class="btn">Change password</button></div>
        </form>
      </section>

      <section class="card" id="team-login" style="margin-top:16px">
        <div class="form-section">
          <h3>Team login</h3>
          <p class="muted">A sign-in for your team that shows only <strong>Tracking</strong>, to look at: the bill number, the customer’s
            name, the last 4 digits of their mobile, the photos, what was ordered, the stage and the amount due.
            No prices, totals or payments, and nothing can be changed.</p>
          <div data-team-logins>${loading()}</div>
        </div>
      </section>`);
    bind();
    loadTeamLogins();
    if (location.hash === '#demo') setTimeout(() => el.querySelector('#demo')?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 50);
  }

  function bind() {
    const form = el.querySelector('[data-settings]');
    const updatePreviews = () => {
      const n = Number(form.elements.namedItem('next_invoice_no').value);
      el.querySelector('[data-next-preview]').textContent = Number.isInteger(n) && n > 0
        ? `Next bill will be ${invoiceNumber(form.elements.namedItem('invoice_prefix').value.trim(), n)}`
        : 'Enter a whole number';
      el.querySelector('[data-currency-preview]').textContent = `Example: ${formatMoney(12345678, form.elements.namedItem('currency').value)}`;
    };
    form.addEventListener('input', updatePreviews);
    updatePreviews();

    // Bill design: live mini preview.
    const preview = el.querySelector('[data-bill-preview]');
    const applyDesign = () => {
      const color = form.elements.namedItem('bill_color').value;
      preview.style.setProperty('--accent', color);
      preview.classList.toggle('bp-light', form.elements.namedItem('bill_header').value === 'light');
      el.querySelector('[data-bp-tag]').textContent = form.elements.namedItem('tagline').value;
      el.querySelectorAll('[data-color]').forEach((s) => s.classList.toggle('active', s.dataset.color === color));
    };
    const setColor = (hex) => {
      form.elements.namedItem('bill_color').value = hex;
      el.querySelector('[data-color-input]').value = hex;
      applyDesign();
    };
    form.addEventListener('click', (e) => {
      const sw = e.target.closest('[data-color]');
      if (sw) setColor(sw.dataset.color);
      const hd = e.target.closest('[data-header]');
      if (hd) {
        form.elements.namedItem('bill_header').value = hd.dataset.header;
        form.querySelectorAll('[data-header]').forEach((x) => x.classList.toggle('active', x === hd));
        applyDesign();
      }
    });
    el.querySelector('[data-color-input]').addEventListener('input', (e) => setColor(e.target.value));
    form.elements.namedItem('tagline').addEventListener('input', applyDesign);
    applyDesign();

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      clearErrors(form);
      const d = formData(form);
      if (!d.name.trim()) return showFieldError(form, 'name', 'Business name is required.');
      await busy(e.submitter || form.querySelector('[type=submit]'), async () => {
        try {
          const { business } = await api('/settings', { method: 'PUT', body: d });
          app.setMe({ ...app.me, business });
          toast('Settings saved.');
          render();
        } catch (err) {
          showFormError(form, err);
        }
      });
      return undefined;
    });

    const fileInput = el.querySelector('[data-logo-input]');
    el.querySelector('[data-action=upload-logo]').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      const file = fileInput.files[0];
      if (!file) return;
      if (!['image/png', 'image/jpeg'].includes(file.type)) {
        toast('Please choose a PNG or JPEG image.', 'error');
        return;
      }
      if (file.size > 1024 * 1024) {
        toast('That image is larger than 1 MB. Please choose a smaller file.', 'error');
        return;
      }
      const reader = new FileReader();
      reader.onload = async () => {
        try {
          const { business } = await api('/settings/logo', { method: 'POST', body: { data_url: reader.result } });
          app.setMe({ ...app.me, business });
          toast('Logo updated.');
          render();
        } catch (err) {
          toastError(err);
        }
      };
      reader.readAsDataURL(file);
    });
    el.querySelector('[data-action=remove-logo]')?.addEventListener('click', async () => {
      try {
        const { business } = await api('/settings/logo', { method: 'DELETE' });
        app.setMe({ ...app.me, business });
        toast('Logo removed.');
        render();
      } catch (err) {
        toastError(err);
      }
    });

    el.querySelector('[data-action=remove-demo]')?.addEventListener('click', async (e) => {
      const ok = await confirmDialog({
        title: 'Remove all demo data?',
        message: 'This permanently deletes every product, customer, bill, day book entry, booking and team member marked Demo. Your own records stay as they are.',
        confirmText: 'Remove demo data',
        danger: true,
      });
      if (!ok) return;
      await busy(e.target.closest('button'), async () => {
        try {
          const res = await api('/settings/demo/remove', { method: 'POST', body: {} });
          app.setMe(res);
          const r = res.removed;
          toast(`Removed ${r.products} demo products, ${r.customers} customers, ${r.bills} bills, ${r.entries} day book entries and ${r.bookings} bookings.`);
          render();
        } catch (err) {
          toastError(err);
        }
      });
    });
    el.querySelector('[data-action=load-demo]')?.addEventListener('click', async (e) => {
      await busy(e.target.closest('button'), async () => {
        try {
          const res = await api('/settings/demo/load', { method: 'POST', body: {} });
          app.setMe(res);
          toast(`Loaded ${res.loaded.products.length} demo products and ${res.loaded.customers.length} customers.`);
          render();
        } catch (err) {
          toastError(err);
        }
      });
    });

    const pw = el.querySelector('[data-password]');
    pw.addEventListener('submit', async (e) => {
      e.preventDefault();
      clearErrors(pw);
      const d = formData(pw);
      if (!d.current_password) return showFieldError(pw, 'current_password', 'Enter your current password.');
      if (d.new_password.length < 8) return showFieldError(pw, 'new_password', 'New password must be at least 8 characters.');
      if (d.new_password !== d.confirm_password) return showFieldError(pw, 'confirm_password', 'Passwords do not match.');
      await busy(e.submitter, async () => {
        try {
          await api('/auth/password', { method: 'POST', body: d });
          pw.reset();
          toast('Password changed. Other devices have been signed out.');
        } catch (err) {
          showFormError(pw, err);
        }
      });
      return undefined;
    });
  }

  // ---- Team logins (view only, Tracking) ------------------------------------------------
  let logins = [];

  async function loadTeamLogins() {
    try {
      logins = (await api('/settings/team-logins')).logins;
    } catch (err) {
      toastError(err);
    }
    renderTeamLogins();
  }

  function renderTeamLogins() {
    const box = el.querySelector('[data-team-logins]');
    if (!box) return;
    setHtml(box, html`
      ${logins.length ? html`<ul class="tl-list">${logins.map((l) => html`<li class="tl-row">
          <span class="tl-ic">${icon('user')}</span>
          <span class="tl-main"><b>${l.name}</b><span class="muted small">${l.email}</span></span>
          <span class="tl-actions">
            <button type="button" class="btn btn-sm" data-tl-password="${l.id}">${icon('edit', 'sm')}Change password</button>
            <button type="button" class="btn btn-sm btn-ghost btn-danger" data-tl-remove="${l.id}">${icon('trash', 'sm')}Remove</button>
          </span></li>`)}</ul>
        <p class="muted small" style="margin:10px 0 0">Your team signs in at <strong>${location.origin}/login</strong> with that email and password.</p>`
        : ''}
      <button type="button" class="btn ${logins.length ? 'btn-sm' : ''}" style="margin-top:${logins.length ? '12px' : '2px'}" data-tl-add>
        ${icon('plus')}${logins.length ? 'Add another team login' : 'Add a team login'}</button>`);
  }

  const showPassword = html`<label class="check small" style="margin-top:6px"><input type="checkbox" data-tl-show>Show password</label>`;
  const bindShow = (form) => form.querySelector('[data-tl-show]').addEventListener('change', (e) => {
    form.querySelectorAll('input[name=password], input[name=confirm]').forEach((i) => {
      i.type = e.target.checked ? 'text' : 'password';
    });
  });

  function openAddLogin() {
    const modal = openModal({
      title: 'Add a team login',
      form: true,
      body: html`<p class="muted small" style="margin-top:0">Only Tracking, to look at. The email doesn’t need to be a real inbox,
          e.g. team@yourstudio.com: it’s what your team types to sign in.</p>
        <div class="form-grid">
          <div class="field span-all"><label>Name <span class="req">*</span></label>
            <input class="input" name="name" value="Team" maxlength="80" required></div>
          <div class="field span-all"><label>Login email <span class="req">*</span></label>
            <input class="input" name="email" type="email" maxlength="254" autocomplete="off" required autofocus></div>
          <div class="field span-all"><label>Password <span class="req">*</span></label>
            <input class="input" name="password" type="password" minlength="8" autocomplete="new-password" required>
            <span class="field-hint">At least 8 characters.</span>${showPassword}</div>
        </div>`,
      footer: html`<button type="button" class="btn" data-close>Cancel</button>
        <button type="submit" class="btn btn-primary">${icon('check')}Add team login</button>`,
      onSubmit: async (form, m, submitter) => {
        clearErrors(form);
        const body = formData(form);
        if (body.password.length < 8) return showFieldError(form, 'password', 'Password must be at least 8 characters.');
        await busy(submitter, async () => {
          try {
            logins = (await api('/settings/team-logins', { method: 'POST', body })).logins;
            renderTeamLogins();
            m.close();
            toast(`Team login added. Your team signs in with ${body.email} and the password you chose.`, 'success', { timeout: 8000 });
          } catch (err) {
            showFormError(form, err);
          }
        });
        return undefined;
      },
    });
    bindShow(modal.form);
  }

  function openChangePassword(login) {
    const modal = openModal({
      title: `New password for ${login.name}`,
      size: 'sm',
      form: true,
      body: html`<p class="muted small" style="margin-top:0">${login.email}. Anyone signed in with the old password will have to sign in again.</p>
        <div class="field"><label>New password</label>
          <input class="input" name="password" type="password" minlength="8" autocomplete="new-password" required autofocus></div>
        <div class="field" style="margin-top:12px"><label>Confirm new password</label>
          <input class="input" name="confirm" type="password" autocomplete="new-password" required>${showPassword}</div>`,
      footer: html`<button type="button" class="btn" data-close>Cancel</button>
        <button type="submit" class="btn btn-primary">${icon('check')}Change password</button>`,
      onSubmit: async (form, m, submitter) => {
        clearErrors(form);
        const { password, confirm } = formData(form);
        if (password.length < 8) return showFieldError(form, 'password', 'Password must be at least 8 characters.');
        if (password !== confirm) return showFieldError(form, 'confirm', 'Passwords do not match.');
        await busy(submitter, async () => {
          try {
            logins = (await api(`/settings/team-logins/${login.id}/password`, { method: 'PUT', body: { password } })).logins;
            m.close();
            toast('Password changed. The team signs in with the new one.');
          } catch (err) {
            showFormError(form, err);
          }
        });
        return undefined;
      },
    });
    bindShow(modal.form);
  }

  el.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-tl-add], [data-tl-password], [data-tl-remove]');
    if (!b) return;
    if (b.dataset.tlAdd !== undefined) return openAddLogin();
    const login = logins.find((l) => String(l.id) === (b.dataset.tlPassword || b.dataset.tlRemove));
    if (!login) return undefined;
    if (b.dataset.tlPassword) return openChangePassword(login);
    const ok = await confirmDialog({
      title: `Remove ${login.name}?`, message: `${login.email} won’t be able to sign in any more.`, confirmText: 'Remove login', danger: true,
    });
    if (!ok) return undefined;
    try {
      logins = (await api(`/settings/team-logins/${login.id}`, { method: 'DELETE' })).logins;
      renderTeamLogins();
      toast('Team login removed.');
    } catch (err) {
      toastError(err);
    }
    return undefined;
  });

  render();
}
