const content = document.querySelector('.markdown-body');
if (content) {
  const headings = content.querySelectorAll('h2[id]');

  // Only activate for documents with 3+ h2 sections
  if (headings.length >= 3) {
    // Wrap each h2 + its content in <details open>
    headings.forEach(heading => {
      const details = document.createElement('details');
      details.open = true;
      details.className = 'collapsible-section';

      const summary = document.createElement('summary');
      // Move the heading inside summary
      summary.appendChild(heading.cloneNode(true));

      // Collect siblings until next h2 or h1
      const siblings = [];
      let sib = heading.nextElementSibling;
      while (sib && !sib.matches('h1, h2')) {
        siblings.push(sib);
        sib = sib.nextElementSibling;
      }

      // Insert details element where heading was
      heading.parentNode.insertBefore(details, heading);
      details.appendChild(summary);
      siblings.forEach(s => details.appendChild(s));
      heading.remove();
    });

    // Collapse/Expand All controls
    const controls = document.createElement('div');
    controls.className = 'collapse-controls';

    const collapseBtn = document.createElement('button');
    collapseBtn.textContent = 'Collapse All';
    collapseBtn.setAttribute('aria-label', 'Collapse all sections');
    collapseBtn.addEventListener('click', () => {
      content.querySelectorAll('details.collapsible-section').forEach(d => { d.open = false; });
    });

    const expandBtn = document.createElement('button');
    expandBtn.textContent = 'Expand All';
    expandBtn.setAttribute('aria-label', 'Expand all sections');
    expandBtn.addEventListener('click', () => {
      content.querySelectorAll('details.collapsible-section').forEach(d => { d.open = true; });
    });

    controls.append(collapseBtn, expandBtn);

    // Insert controls before first collapsible section
    const firstDetails = content.querySelector('details.collapsible-section');
    if (firstDetails) {
      firstDetails.parentNode.insertBefore(controls, firstDetails);
    }
  }
}
