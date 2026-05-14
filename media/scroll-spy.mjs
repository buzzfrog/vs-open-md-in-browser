const toc = document.querySelector('.toc-sidebar');
if (toc) {
  const tocLinks = toc.querySelectorAll('a');
  const headingIds = Array.from(tocLinks).map(a => a.getAttribute('href')?.slice(1)).filter(Boolean);

  // Resolve heading elements by ID rather than tag selector. This is
  // resilient to DOM mutations by collapsible-sections.mjs, which clones
  // h2 elements into <summary> and removes the originals. The cloned
  // headings retain their IDs, so getElementById still finds them.
  function resolveHeadings() {
    return headingIds
      .map(id => document.getElementById(id))
      .filter(el => el !== null);
  }

  let headings = resolveHeadings();

  if (headings.length > 0) {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            tocLinks.forEach(link => link.classList.remove('active'));
            const active = toc.querySelector(`a[href="#${CSS.escape(entry.target.id)}"]`);
            if (active) {
              active.classList.add('active');
              // Scroll TOC to keep active item visible
              active.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            }
          }
        }
      },
      { rootMargin: '-20% 0px -80% 0px' }
    );
    headings.forEach(h => observer.observe(h));

    // Re-observe after DOM mutations (e.g. collapsible-sections.mjs)
    const body = document.querySelector('.markdown-body');
    if (body) {
      const mutationObs = new MutationObserver(() => {
        observer.disconnect();
        headings = resolveHeadings();
        headings.forEach(h => observer.observe(h));
      });
      mutationObs.observe(body, { childList: true, subtree: true });
      // Stop watching after initial mutations settle (5 seconds)
      setTimeout(() => mutationObs.disconnect(), 5000);
    }
  }
}
