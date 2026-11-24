/** Visible choices drive the original fields; validation and calculation stay there. */
export function selectedOptionText(field) {
  if (!field) return '';
  const options = [...field.options], all = options.find(o => o.value === field.dataset.quickAll);
  const choices = options.filter(o => o !== all && !o.disabled && !o.hidden);
  if (field.multiple && all && (all.selected || choices.length && choices.every(o => o.selected))) return all.textContent.trim();
  return [...field.selectedOptions].map(o => o.textContent.trim()).join('＋');
}

export function setupQuickOptions(root) {
  const groups = [];
  const document = root.ownerDocument;
  for (const field of root.querySelectorAll('select, [data-quick]')) {
    if (field.dataset.quickReady || field.hidden || (field.multiple && !field.hasAttribute('data-quick')) || field.hasAttribute('data-inline-filter') || field.hasAttribute('data-quick-native')) continue;
    const isSelect = field.tagName === 'SELECT';
    const explicit = field.hasAttribute('data-quick');
    if (!explicit && (!isSelect || field.options.length < 2 || field.options.length > 6)) continue;
    const values = (field.dataset.quick ?? '').split(',').filter(Boolean);
    // Small numeric ranges have one complete set, not a dropdown plus presets.
    const complete = isSelect && (!values.length || field.options.length <= 12);
    const prefix = field.dataset.quickPrefix ?? '';
    const suffix = field.dataset.quickSuffix ?? '';
    const options = isSelect
      ? [...field.options].filter(o => complete || values.includes(o.value)).map(option => ({value:option.value, label:option.textContent.trim(), shortLabel:option.dataset?.shortLabel, option}))
      : values.map(value => ({value, label:`${prefix}${value}${suffix}`}));
    if (!options.length) continue;
    const label = field.closest('label');
    const name = field.getAttribute('aria-label') || [...(label?.childNodes ?? [])].filter(n => n.nodeType === 3).map(n => n.textContent.trim()).join(' ').trim()
      || label?.querySelector('span')?.textContent.trim() || (document.documentElement.lang.startsWith('en') ? 'Choices' : '选项');
    const group = document.createElement('div');
    if (!isSelect) {
      group.className = 'tool-options tool-choice-group ui-quick-presets';
    } else if (field.hasAttribute('data-quick-segmented')) {
      group.className = `tool-options tool-choice-group ui-segmented${field.dataset.quickSegmented === 'pill' ? '' : ' ui-segmented--block'}`;
    } else {
      group.className = 'tool-options tool-choice-group';
    }
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', name);
    const hadAriaLabel = field.hasAttribute('aria-label');
    const buttons = options.map(({value, label, shortLabel, option}) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.setAttribute('aria-label', label);
      button.title = label;
      const text = document.createElement('span');
      text.textContent = shortLabel || label;
      const icon = option?.dataset.icon;
      if (icon) {
        const image = document.createElement('img');
        image.src = icon; image.alt = ''; image.width = 28; image.height = 28;
        button.dataset.icon = 'true';
        if (option.dataset.round === 'true') button.dataset.round = 'true';
        const iconOnly = option.hasAttribute('data-icon-only') && option.dataset.iconOnly !== 'false';
        if (iconOnly) text.className = 'tool-choice-label';
        let fallbackTried = false;
        image.addEventListener('error', () => {
          if (!fallbackTried && option.dataset?.fallbackIcon) {
            fallbackTried = true;
            image.src = option.dataset.fallbackIcon;
            delete button.dataset.round;
            button.dataset.iconShape = 'logo';
            return;
          }
          image.hidden = true; text.className = ''; delete button.dataset.icon; delete button.dataset.round; delete button.dataset.iconShape;
        });
        button.append(image);
      }
      const difficulty = option?.dataset.difficulty || (/^(easy|normal|hard|expert)$/.test(value) ? value : null);
      if (difficulty) button.dataset.difficulty = difficulty;
      button.append(text);
      button.addEventListener('click', () => {
        if (field.multiple) {
          const choices = options.filter(o => o.value !== field.dataset.quickAll && !o.option.disabled && !o.option.hidden);
          if (value === field.dataset.quickAll) {
            for (const choice of choices) choice.option.selected = field.hasAttribute('data-quick-required');
            option.selected = !field.hasAttribute('data-quick-required');
          } else {
            // Keep one playable difficulty selected; "all" is a shortcut only.
            if (field.hasAttribute('data-quick-required') && option.selected && choices.filter(o => o.option.selected).length <= 1) return;
            option.selected = !option.selected;
            const all = options.find(o => o.value === field.dataset.quickAll);
            if (all) all.option.selected = !choices.some(o => o.option.selected);
          }
        } else field.value = value;
        field.dispatchEvent(new Event('input', {bubbles:true}));
        field.dispatchEvent(new Event('change', {bubbles:true}));
        sync();
      });
      group.append(button);
      return {button, value, option};
    });
    if (!hadAriaLabel) field.setAttribute('aria-label', name);
    field.dataset.quickReady = 'true';
    field.after(group);
    if (complete) field.hidden = true;
    groups.push({field, group, buttons, complete, hadAriaLabel});
  }
  function sync() {
    for (const {field, buttons} of groups) for (const {button, value, option} of buttons) {
      const selected = field.multiple
        ? value === field.dataset.quickAll
          ? option.selected || buttons.filter(b => b.value !== field.dataset.quickAll && !b.option.disabled && !b.option.hidden).every(b => b.option.selected)
          : option.selected
        : field.value === value;
      button.setAttribute('aria-pressed', String(selected));
      button.disabled = field.disabled || Boolean(option?.disabled);
      button.hidden = Boolean(option?.hidden);
    }
  }
  root.addEventListener('change', sync);
  root.addEventListener('input', sync);
  sync();
  return {sync, destroy() {
    root.removeEventListener('change', sync);
    root.removeEventListener('input', sync);
    for (const {field, group, complete, hadAriaLabel} of groups) {
      group.remove();
      delete field.dataset.quickReady;
      if (complete) field.hidden = false;
      if (!hadAriaLabel) field.removeAttribute('aria-label');
    }
  }};
}
