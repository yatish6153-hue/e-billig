// Single-series column chart (SVG) with per-bar hover/focus tooltips and a table twin.
// Marks: <=24px columns with a 4px rounded data-end, hairline solid gridlines,
// one label on the highest column, values otherwise in the tooltip and the table.
import { escapeHtml as e } from '/shared/format.js';

function niceStep(max, ticks) {
  const raw = max / ticks;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const n = raw / pow;
  const nice = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
  return nice * pow;
}

function columnPath(x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

/**
 * data: [{ label, title, value }] — label is the short axis text, title the tooltip heading.
 * Returns { setTableView(bool), destroy() }.
 */
export function columnChart(host, data, { formatValue, formatTick, height = 220, ariaLabel = 'Column chart' }) {
  host.innerHTML = '';
  const chartEl = document.createElement('div');
  chartEl.className = 'chart';
  const tableEl = document.createElement('div');
  tableEl.className = 'chart-table table-wrap hidden';
  host.append(chartEl, tableEl);

  tableEl.innerHTML = `<table class="table"><thead><tr><th>Period</th><th class="r">Value</th></tr></thead><tbody>${data
    .map((d) => `<tr><td>${e(d.title || d.label)}</td><td class="r">${e(formatValue(d.value))}</td></tr>`).join('')}</tbody></table>`;

  const tooltip = document.createElement('div');
  tooltip.className = 'chart-tooltip hidden';
  tooltip.innerHTML = '<div class="tt-value"></div><div class="tt-label"></div>';

  function draw() {
    const width = Math.max(260, chartEl.clientWidth || host.clientWidth || 600);
    const max = Math.max(0, ...data.map((d) => d.value));
    const ticks = 4;
    const step = max > 0 ? niceStep(max, ticks) : 1;
    const top = step * Math.max(1, Math.ceil(max / step));
    const tickValues = [];
    for (let v = 0; v <= top + step / 2; v += step) tickValues.push(v);

    const tickText = tickValues.map((v) => formatTick(v));
    const left = Math.max(28, ...tickText.map((t) => t.length * 6.4)) + 10;
    const m = { top: 22, right: 6, bottom: 26, left };
    const plotW = width - m.left - m.right;
    const plotH = height - m.top - m.bottom;
    const n = data.length || 1;
    const band = plotW / n;
    const barW = Math.max(2, Math.min(24, band * 0.62, band - 2));
    const y = (v) => m.top + plotH - (v / top) * plotH;

    const maxLabels = Math.max(2, Math.floor(plotW / 48));
    const labelEvery = Math.ceil(n / maxLabels);
    const maxIndex = max > 0 ? data.findIndex((d) => d.value === max) : -1;

    let svg = `<svg viewBox="0 0 ${width} ${height}" height="${height}" role="img" aria-label="${e(ariaLabel)}">`;
    tickValues.forEach((v, i) => {
      const yy = Math.round(y(v)) + 0.5;
      svg += `<line class="grid-line" x1="${m.left}" x2="${width - m.right}" y1="${yy}" y2="${yy}"/>`;
      svg += `<text class="axis-text" x="${m.left - 8}" y="${yy + 4}" text-anchor="end">${e(tickText[i])}</text>`;
    });
    data.forEach((d, i) => {
      const cx = m.left + band * i + band / 2;
      const h = d.value > 0 ? Math.max(1, (d.value / top) * plotH) : 0;
      const label = `${d.title || d.label}: ${formatValue(d.value)}`;
      svg += `<rect class="hit" data-i="${i}" x="${m.left + band * i}" y="${m.top}" width="${band}" height="${plotH}" tabindex="0" role="img" aria-label="${e(label)}"/>`;
      svg += h > 0 ? `<path class="bar" data-bar="${i}" d="${columnPath(cx - barW / 2, m.top + plotH - h, barW, h, 4)}"/>` : `<g data-bar="${i}"></g>`;
      if ((n - 1 - i) % labelEvery === 0) {
        svg += `<text class="axis-text" x="${cx}" y="${height - 8}" text-anchor="middle">${e(d.label)}</text>`;
      }
      if (i === maxIndex) {
        svg += `<text class="value-label" x="${cx}" y="${m.top + plotH - h - 6}" text-anchor="middle">${e(formatTick(d.value))}</text>`;
      }
    });
    svg += '</svg>';
    chartEl.innerHTML = svg;
    chartEl.append(tooltip);

    const show = (i) => {
      const d = data[i];
      const cx = m.left + band * i + band / 2;
      const h = d.value > 0 ? (d.value / top) * plotH : 0;
      tooltip.querySelector('.tt-value').textContent = formatValue(d.value);
      tooltip.querySelector('.tt-label').textContent = d.title || d.label;
      tooltip.classList.remove('hidden');
      const scale = chartEl.clientWidth / width;
      const tipW = tooltip.offsetWidth;
      const px = Math.min(Math.max(cx * scale, tipW / 2 + 2), chartEl.clientWidth - tipW / 2 - 2);
      tooltip.style.left = `${px}px`;
      tooltip.style.top = `${(m.top + plotH - h) * scale}px`;
      chartEl.querySelectorAll('.bar.is-active').forEach((b) => b.classList.remove('is-active'));
      chartEl.querySelector(`[data-bar="${i}"]`)?.classList.add('is-active');
    };
    const hide = () => {
      tooltip.classList.add('hidden');
      chartEl.querySelectorAll('.bar.is-active').forEach((b) => b.classList.remove('is-active'));
    };
    chartEl.querySelectorAll('.hit').forEach((hit) => {
      const i = Number(hit.dataset.i);
      hit.addEventListener('pointerenter', () => show(i));
      hit.addEventListener('focus', () => show(i));
      hit.addEventListener('pointerleave', hide);
      hit.addEventListener('blur', hide);
    });
  }

  draw();
  let lastWidth = chartEl.clientWidth;
  const ro = new ResizeObserver(() => {
    if (Math.abs(chartEl.clientWidth - lastWidth) > 4) {
      lastWidth = chartEl.clientWidth;
      draw();
    }
  });
  ro.observe(chartEl);

  return {
    setTableView(on) {
      chartEl.classList.toggle('hidden', on);
      tableEl.classList.toggle('hidden', !on);
      if (!on) draw();
    },
    destroy() {
      ro.disconnect();
    },
  };
}

/** Compact axis ticks, e.g. ₹0 / ₹2K / ₹1.5L (Indian) or $2K / $1.5M. */
export function compactMoney(minor, currency, symbol) {
  const locale = currency === 'INR' || currency === 'NPR' || currency === 'BDT' ? 'en-IN' : 'en-US';
  const value = minor / 100;
  const s = new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(value);
  return `${symbol.trim()}${s}`;
}
