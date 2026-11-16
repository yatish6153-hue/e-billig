// Edit a list of names: the product categories (Settings) and the day book's expense types (Settings and the
// day book). Rename, add, remove or reorder; renames are sent along so what's already saved can follow.
import { api } from '../lib/api.js';
import { html, setHtml } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { openModal, toast, busy, showFormError, clearErrors } from '../lib/ui.js';

const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

/**
 * Opens the editor.
 * - names: the list now; max: the longest name; placeholder: for the new name's box.
 * - note(name): a small hint beside a saved name, like "4 items".
 * - beforeSave({ names, renames, removed }): may resolve false to go back to the list (to confirm a removal, say).
 * - save({ names, renames, removed }): sends it; an error shows in the dialog.
 * - allowEmpty: the list may be left empty.
 * Resolves with save()'s result once saved, or null.
 */
export function openNameListEditor({
  title, intro, names, max = 40, placeholder = '', saveText = 'Save', note, beforeSave, save, allowEmpty = false,
}) {
  let rows = names.map((name) => ({ orig: name, name }));
  return new Promise((resolve) => {
    let result = null;
    const modal = openModal({
      title,
      form: true,
      body: html`${intro ? html`<p class="muted small" style="margin:0 0 12px">${intro}</p>` : ''}
        <div class="type-list" data-type-list></div>
        <div class="type-add"><input class="input" data-new-type maxlength="${max}" placeholder="${placeholder}" aria-label="New name">
          <button type="button" class="btn" data-add-type>${icon('plus', 'sm')}Add</button></div>`,
      footer: html`<button type="button" class="btn" data-close>Cancel</button>
        <button type="submit" class="btn btn-primary">${saveText}</button>`,
      onClose: () => resolve(result),
      onSubmit: async (form, m, submitter) => {
        clearErrors(form);
        readNames();
        const kept = rows.filter((r) => r.name);
        const seen = new Set();
        for (const r of kept) {
          if (seen.has(r.name.toLowerCase())) {
            toast(`“${r.name}” is on the list twice. Change or remove one.`, 'error');
            return;
          }
          seen.add(r.name.toLowerCase());
        }
        if (!kept.length && !allowEmpty) {
          toast('Keep at least one.', 'error');
          return;
        }
        const keptOrigs = new Set(kept.map((r) => r.orig).filter(Boolean));
        const change = {
          names: kept.map((r) => r.name),
          renames: kept.filter((r) => r.orig && r.orig !== r.name).map((r) => ({ from: r.orig, to: r.name })),
          removed: names.filter((n) => !keptOrigs.has(n)),
        };
        if (beforeSave && (await beforeSave(change)) === false) return;
        await busy(submitter, async () => {
          try {
            result = await save(change);
            m.close();
          } catch (err) {
            showFormError(form, err);
          }
        });
      },
    });
    const list = modal.el.querySelector('[data-type-list]');
    const newName = modal.el.querySelector('[data-new-type]');
    function readNames() {
      list.querySelectorAll('[data-type-name]').forEach((input, i) => { rows[i].name = clean(input.value); });
    }
    function paint() {
      setHtml(list, rows.length ? html`${rows.map((r, i) => html`<div class="type-row">
        <input class="input" data-type-name value="${r.name}" maxlength="${max}" aria-label="Name ${i + 1}">
        <span class="muted small type-note">${r.orig && note ? note(r.orig) : r.orig ? '' : 'New'}</span>
        <button type="button" class="btn btn-ghost btn-icon btn-sm" data-move data-at="${i}" title="Move up" aria-label="Move ${r.name} up" ${i === 0 ? 'disabled' : ''}>${icon('chevronUp', 'sm')}</button>
        <button type="button" class="btn btn-ghost btn-icon btn-sm btn-danger" data-remove-type="${i}" title="Remove" aria-label="Remove ${r.name}">${icon('trash', 'sm')}</button>
      </div>`)}` : html`<p class="muted small" style="margin:0">Nothing on the list yet. Add one below.</p>`);
    }
    function add() {
      const name = clean(newName.value);
      if (!name) return newName.focus();
      readNames();
      if (rows.some((r) => r.name.toLowerCase() === name.toLowerCase())) {
        toast(`“${name}” is already on the list.`, 'info');
        return newName.focus();
      }
      rows.push({ orig: null, name });
      newName.value = '';
      paint();
      list.scrollTop = list.scrollHeight;
      return newName.focus();
    }
    modal.el.addEventListener('click', (e) => {
      const remove = e.target.closest('[data-remove-type]');
      const move = e.target.closest('[data-move]');
      if (remove) {
        readNames();
        rows.splice(Number(remove.dataset.removeType), 1);
        paint();
      } else if (move && !move.disabled) {
        readNames();
        const i = Number(move.dataset.at);
        [rows[i - 1], rows[i]] = [rows[i], rows[i - 1]];
        paint();
      } else if (e.target.closest('[data-add-type]')) add();
    });
    // Enter in the new name's box adds it, rather than saving the list.
    newName.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      add();
    });
    paint();
  });
}

/** The day book's expense types; renaming one renames it on saved expenses. Resolves with { types, renames } or null. */
export async function editExpenseTypes(app) {
  const types = app.business.expense_types?.length ? app.business.expense_types : [];
  return openNameListEditor({
    title: 'Expense types',
    intro: 'The types you pick from when you add an expense in the day book. Change a name and the expenses already saved under it change too. A type you remove stays on its old expenses.',
    names: types,
    placeholder: 'New type, e.g. Courier',
    saveText: 'Save types',
    save: async ({ names, renames }) => {
      const res = await api('/settings/expense-types', { method: 'PUT', body: { types: names, renames } });
      app.business.expense_types = res.business.expense_types.slice();
      toast('Expense types saved.');
      return { types: res.business.expense_types, renames };
    },
  });
}
