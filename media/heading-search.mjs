const headings = Array.from(document.querySelectorAll('h1[id], h2[id], h3[id], h4[id]'));
if (headings.length < 2) {
  // No point showing heading search for very short documents
} else {
  const overlay = document.createElement('div');
  overlay.className = 'heading-search-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-label', 'Jump to heading');

  const container = document.createElement('div');
  container.className = 'heading-search-container';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'heading-search-input';
  input.placeholder = 'Jump to heading...';
  input.setAttribute('aria-label', 'Search headings');

  const list = document.createElement('ul');
  list.className = 'heading-search-results';
  list.setAttribute('role', 'listbox');

  container.append(input, list);
  overlay.appendChild(container);
  document.body.appendChild(overlay);

  let activeIndex = -1;

  function buildItems(filter) {
    const query = (filter || '').toLowerCase();
    list.innerHTML = '';
    activeIndex = -1;

    const matches = headings.filter(h =>
      !query || h.textContent.toLowerCase().includes(query)
    );

    matches.forEach((h, idx) => {
      const li = document.createElement('li');
      li.setAttribute('role', 'option');
      li.className = 'heading-search-item';
      const tag = h.tagName.toLowerCase();
      const level = document.createElement('span');
      level.className = 'heading-search-level';
      level.textContent = tag;
      const text = document.createElement('span');
      text.className = 'heading-search-text';
      text.textContent = h.textContent;
      li.append(level, text);
      li.addEventListener('click', () => jumpTo(h));
      list.appendChild(li);
    });

    if (matches.length > 0) {
      activeIndex = 0;
      list.children[0].classList.add('selected');
    }
  }

  function jumpTo(heading) {
    close();
    heading.scrollIntoView({ behavior: 'smooth', block: 'start' });
    heading.focus();
  }

  function open() {
    overlay.classList.add('visible');
    input.value = '';
    buildItems('');
    input.focus();
  }

  function close() {
    overlay.classList.remove('visible');
  }

  function updateSelection(newIndex) {
    const items = list.querySelectorAll('.heading-search-item');
    if (items.length === 0) return;
    if (activeIndex >= 0 && activeIndex < items.length) {
      items[activeIndex].classList.remove('selected');
    }
    activeIndex = Math.max(0, Math.min(newIndex, items.length - 1));
    items[activeIndex].classList.add('selected');
    items[activeIndex].scrollIntoView({ block: 'nearest' });
  }

  input.addEventListener('input', () => buildItems(input.value));

  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      updateSelection(activeIndex + 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      updateSelection(activeIndex - 1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const items = list.querySelectorAll('.heading-search-item');
      if (activeIndex >= 0 && activeIndex < items.length) {
        const matchedHeadings = headings.filter(h =>
          !input.value || h.textContent.toLowerCase().includes(input.value.toLowerCase())
        );
        if (matchedHeadings[activeIndex]) {
          jumpTo(matchedHeadings[activeIndex]);
        }
      }
    } else if (e.key === 'Escape') {
      close();
    }
  });

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) { close(); }
  });

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
      e.preventDefault();
      if (overlay.classList.contains('visible')) {
        close();
      } else {
        open();
      }
    }
  });
}
