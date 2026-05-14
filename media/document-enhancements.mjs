// Scroll progress bar
const bar = document.createElement('div');
bar.className = 'progress-bar';
bar.setAttribute('role', 'progressbar');
bar.setAttribute('aria-label', 'Reading progress');
bar.setAttribute('aria-valuemin', '0');
bar.setAttribute('aria-valuemax', '100');
document.body.prepend(bar);

function updateProgress() {
  const scrollTop = document.documentElement.scrollTop;
  const scrollHeight = document.documentElement.scrollHeight - window.innerHeight;
  const pct = scrollHeight > 0 ? (scrollTop / scrollHeight) * 100 : 0;
  bar.style.width = `${Math.min(pct, 100)}%`;
  bar.setAttribute('aria-valuenow', String(Math.round(pct)));
}
window.addEventListener('scroll', updateProgress, { passive: true });
updateProgress();

// Back to top button
const btn = document.createElement('button');
btn.className = 'back-to-top';
btn.textContent = '\u2191';
btn.setAttribute('aria-label', 'Back to top');
btn.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
document.body.appendChild(btn);

function updateBackToTop() {
  btn.classList.toggle('visible', window.scrollY > 300);
}
window.addEventListener('scroll', updateBackToTop, { passive: true });
updateBackToTop();
