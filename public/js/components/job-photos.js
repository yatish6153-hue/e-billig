// Photos of a job (bill): the customer's photo, so it's clear later which one the job is for. A photo is made smaller
// here before it's sent (up to 1600 px, with a 360 px copy for lists). It can come from the camera, the gallery, or on
// a computer a paste (Ctrl+V) or a drop. openPhotos shows a job's photos one big at a time, to add more or remove one.
import { api } from '../lib/api.js';
import { html, setHtml } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { openModal, confirmDialog, toast, toastError } from '../lib/ui.js';

export const MAX_PHOTOS = 20;
const BIG = 1600;
const SMALL = 360;
const MAX_BYTES = 1100 * 1024;

/** Phones and tablets get a "Take photo" button that opens the camera. */
export const hasCamera = () => matchMedia('(pointer: coarse)').matches;

/** The image drawn at most max px on its long side, as a JPEG data URL (white behind any transparency). */
function scaled(img, max, quality) {
  const ratio = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
  const width = Math.max(1, Math.round(img.naturalWidth * ratio));
  const height = Math.max(1, Math.round(img.naturalHeight * ratio));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, width, height);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, width, height);
  return { url: canvas.toDataURL('image/jpeg', quality), width, height };
}

/** A photo ready to send: { image, thumb } as data URLs, with the big copy's width and height. */
export async function preparePhoto(file) {
  const src = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = src;
    try {
      await img.decode();
    } catch {
      throw new Error(`${file.name || 'That file'} can’t be opened as a photo. Please choose a JPEG or PNG photo.`);
    }
    let big;
    // Smaller and smaller until it's light enough to send.
    for (const [max, quality] of [[BIG, 0.82], [BIG, 0.7], [1280, 0.7], [1024, 0.62]]) {
      big = scaled(img, max, quality);
      if (big.url.length * 0.75 <= MAX_BYTES) break;
    }
    const small = scaled(img, SMALL, 0.72);
    return { image: big.url, thumb: small.url, width: big.width, height: big.height };
  } finally {
    URL.revokeObjectURL(src);
  }
}

/** Only the photos among some files (from a picker, a paste or a drop). */
export const onlyImages = (files) => [...(files || [])].filter((f) => f.type.startsWith('image/') || /\.(jpe?g|png|webp|heic|heif)$/i.test(f.name));

/** Open the camera (camera: true) or the gallery / file chooser; resolves with the files chosen (none if closed). */
export function pickPhotos({ camera = false } = {}) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    if (camera) input.setAttribute('capture', 'environment');
    else input.multiple = true;
    input.hidden = true;
    const done = (files) => {
      input.remove();
      resolve(files);
    };
    input.addEventListener('change', () => done([...input.files]));
    input.addEventListener('cancel', () => done([]));
    document.body.append(input);
    input.click();
  });
}

/**
 * The job's first photo, small (with how many there are), or a button to add one. Tapping it opens the photos.
 * readOnly (the team's view): no photo yet is just an empty square.
 */
export function photoThumb(photos = [], { readOnly = false } = {}) {
  const first = photos[0];
  if (first) {
    return html`<button type="button" class="jp-thumb" data-photos title="See the photo${photos.length === 1 ? '' : 's'}"
        aria-label="See ${photos.length} photo${photos.length === 1 ? '' : 's'}"><img src="${first.thumb_url}" alt="" loading="lazy">
        ${photos.length > 1 ? html`<span class="jp-count">${photos.length}</span>` : ''}</button>`;
  }
  return readOnly
    ? html`<span class="jp-thumb jp-none" title="No photo yet">${icon('image')}</span>`
    : html`<button type="button" class="jp-thumb jp-add" data-photos title="Add the customer’s photo" aria-label="Add the customer’s photo">${icon('imagePlus')}</button>`;
}

/** All of a job's photos, small, then a button to add more; data-photo-at is the photo's place in the list. */
export function photoStrip(photos = []) {
  return html`<div class="jp-strip">${photos.map((p, i) => html`<button type="button" class="jp-thumb" data-photo-at="${i}" aria-label="Photo ${i + 1}">
      <img src="${p.thumb_url}" alt="" loading="lazy"></button>`)}
    ${photos.length < MAX_PHOTOS ? html`<button type="button" class="jp-thumb jp-add" data-photos title="Add a photo" aria-label="Add a photo">${icon('imagePlus')}</button>` : ''}</div>`;
}

/**
 * The job's photos: one big at a time, the rest small underneath, with buttons to add (camera or gallery; on a
 * computer also paste or drop), open full size and remove. onChange(photos) after each change. readOnly (the team's
 * view) only shows them.
 */
export function openPhotos({ bill, photos = [], start = 0, onChange, readOnly = false }) {
  let list = photos.slice();
  let index = Math.max(0, Math.min(start, list.length - 1));
  let working = '';
  const camera = hasCamera();
  const modal = openModal({
    title: `Photos · ${bill.invoice_no || `Draft #${bill.id}`}${bill.customer_name ? ` · ${bill.customer_name}` : ''}`,
    size: 'lg',
    body: html`<div class="ph" data-ph></div>`,
  });
  const box = modal.el.querySelector('[data-ph]');

  function paint() {
    const p = list[index];
    setHtml(box, html`
      ${p ? html`<div class="ph-stage">
          <img class="ph-big" src="${p.url}" alt="Photo ${index + 1} of ${list.length}">
          ${list.length > 1 ? html`
            <button type="button" class="ph-nav ph-prev" data-step="-1" aria-label="Previous photo">${icon('chevronLeft')}</button>
            <button type="button" class="ph-nav ph-next" data-step="1" aria-label="Next photo">${icon('chevronRight')}</button>` : ''}
          <span class="ph-count">${index + 1} / ${list.length}</span>
        </div>
        ${list.length > 1 ? html`<div class="ph-strip">${list.map((x, i) => html`<button type="button" class="ph-thumb ${i === index ? 'active' : ''}"
          data-show="${i}" aria-label="Photo ${i + 1}" aria-current="${i === index}"><img src="${x.thumb_url}" alt=""></button>`)}</div>` : ''}`
      : readOnly ? html`<div class="ph-drop">${icon('image')}<strong>No photo on this job yet</strong></div>`
      : html`<div class="ph-drop">${icon('imagePlus')}<strong>Add the customer’s photo</strong>
          <span class="muted small">So it’s clear later which photo this job is for.
            ${camera ? 'Take a photo, or choose one from the gallery.' : 'Choose a photo, or paste (Ctrl+V) or drop one here.'}</span></div>`}
      ${working ? html`<p class="ph-busy"><span class="spinner"></span>${working}</p>` : ''}
      ${readOnly ? (p ? html`<div class="ph-actions"><span class="ph-gap"></span>
        <a class="btn btn-ghost" href="${p.url}" target="_blank" rel="noopener">${icon('external')}Full size</a></div>` : '') : html`<div class="ph-actions">
        ${camera ? html`<button type="button" class="btn ${p ? '' : 'btn-primary'}" data-add="camera" ${working ? 'disabled' : ''}>${icon('camera')}Take photo</button>` : ''}
        <button type="button" class="btn ${p || camera ? '' : 'btn-primary'}" data-add="files" ${working ? 'disabled' : ''}>${icon('imagePlus')}${camera ? 'From gallery' : p ? 'Add more' : 'Choose photos'}</button>
        ${p ? html`<span class="ph-gap"></span>
          <a class="btn btn-ghost" href="${p.url}" target="_blank" rel="noopener">${icon('external')}Full size</a>
          <button type="button" class="btn btn-ghost btn-danger" data-remove ${working ? 'disabled' : ''}>${icon('trash')}Remove</button>` : ''}
      </div>`}`);
  }

  async function add(files) {
    const images = onlyImages(files);
    if (!images.length) {
      if (files.length) toast('Please choose a photo.', 'error');
      return;
    }
    if (working) return;
    const room = MAX_PHOTOS - list.length;
    if (room <= 0) {
      toast(`A job can have up to ${MAX_PHOTOS} photos. Remove one to add another.`, 'error');
      return;
    }
    const take = images.slice(0, room);
    let added = 0;
    try {
      for (const [i, file] of take.entries()) {
        working = take.length > 1 ? `Adding photo ${i + 1} of ${take.length}…` : 'Adding the photo…';
        paint();
        const body = await preparePhoto(file);
        ({ photos: list } = await api(`/bills/${bill.id}/photos`, { method: 'POST', body }));
        added++;
        index = list.length - 1;
        onChange?.(list);
      }
      if (images.length > take.length) toast(`Only ${MAX_PHOTOS} photos fit on one job.`, 'info');
      else toast(added > 1 ? `${added} photos added.` : 'Photo added.');
    } catch (err) {
      toastError(err);
    } finally {
      working = '';
      paint();
    }
  }

  async function remove() {
    const p = list[index];
    const ok = await confirmDialog({ title: 'Remove this photo?', message: 'It will be deleted from this job.', confirmText: 'Remove photo', danger: true });
    if (!ok) return;
    try {
      ({ photos: list } = await api(`/bills/${bill.id}/photos/${p.id}`, { method: 'DELETE' }));
      index = Math.max(0, Math.min(index, list.length - 1));
      onChange?.(list);
      toast('Photo removed.');
      paint();
    } catch (err) {
      toastError(err);
    }
  }

  const step = (by) => {
    if (list.length < 2) return;
    index = (index + by + list.length) % list.length;
    paint();
  };
  modal.el.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-step], [data-show], [data-add], [data-remove]');
    if (!t || t.disabled) return;
    if (t.dataset.step) step(Number(t.dataset.step));
    else if (t.dataset.show) {
      index = Number(t.dataset.show);
      paint();
    } else if (t.dataset.add) add(await pickPhotos({ camera: t.dataset.add === 'camera' }));
    else remove();
  });
  modal.el.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') step(-1);
    else if (e.key === 'ArrowRight') step(1);
  });
  if (!readOnly) addByPasteOrDrop(modal, box, add);
  paint();
  return modal;
}

/** On a computer a copied photo (from WhatsApp Web, say) can be pasted, or a photo dropped onto the dialog. */
function addByPasteOrDrop(modal, box, add) {
  const onPaste = (e) => {
    const files = onlyImages(e.clipboardData?.files);
    if (!files.length) return;
    e.preventDefault();
    add(files);
  };
  document.addEventListener('paste', onPaste);
  modal.el.addEventListener('close', () => document.removeEventListener('paste', onPaste));
  modal.el.addEventListener('dragover', (e) => {
    if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
    e.preventDefault();
    box.classList.add('is-over');
  });
  modal.el.addEventListener('dragleave', (e) => {
    if (!modal.el.contains(e.relatedTarget)) box.classList.remove('is-over');
  });
  modal.el.addEventListener('drop', (e) => {
    e.preventDefault();
    box.classList.remove('is-over');
    add([...(e.dataTransfer?.files || [])]);
  });
}
