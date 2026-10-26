const icons = {
  team: 'M4 7h6v10H4z M14 7h6v10h-6z M8 3h8 M8 21h8',
  trophy: 'M8 4h8v5a4 4 0 0 1-8 0V4z M8 6H4v2a4 4 0 0 0 4 4 M16 6h4v2a4 4 0 0 1-4 4 M12 13v5 M8 21h8 M10 18h4',
  bolt: 'm13 3-8 11h6l-1 7 9-12h-6l1-6z',
  compare: 'M4 4h6v16H4z M14 4h6v16h-6z M6 8h2 M16 8h2 M6 12h2 M16 12h2',
  library: 'M4 5h16v15H4z M8 5V3h8v2 M8 10h8 M8 14h5',
  score: 'M5 20V4h14v16z M8 8h8 M8 12h3 M8 16h3 M14 12h2 M14 16h2',
  songs: 'M4 6h8 M4 11h8 M4 16h4 M17 17V4l4 2 M17 17a3 2 0 1 1-6 0 3 2 0 0 1 6 0',
};

/** Shared task navigation appearance; callers retain buttons, labels and behavior. */
export function enhanceTaskSwitcher(container, entries) {
  container.classList.add('ds-task-switcher');
  for (const {button, icon, label = button.textContent} of entries) {
    const document = button.ownerDocument;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    path.setAttribute('d', icons[icon]);
    svg.append(path);
    const text = document.createElement('span');
    text.textContent = label;
    button.replaceChildren(svg, text);
  }
}
