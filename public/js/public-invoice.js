// Print button on the public invoice page (kept out of the HTML so the CSP can forbid inline scripts).
document.addEventListener('click', (event) => {
  if (event.target.closest('[data-print]')) window.print();
});
