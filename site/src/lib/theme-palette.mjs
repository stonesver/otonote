const colorTokens = {
  text: 'text', textSoft: 'text-soft', canvas: 'canvas', surface: 'surface', surfaceDeep: 'surface-deep',
  accent: 'accent', accentBright: 'accent-bright', secondary: 'secondary', secondaryInk: 'secondary-ink',
  border: 'border', muted: 'muted', onAccent: 'on-accent', warning: 'warning', warningInk: 'warning-ink',
  success: 'success', successInk: 'success-ink', danger: 'danger', dangerInk: 'danger-ink', info: 'info', infoInk: 'info-ink',
  inverseSurface: 'inverse-surface', inverseText: 'inverse-text', inverseMuted: 'inverse-muted',
  mediaShade: 'media-shade', mediaText: 'media-text', shadowColor: 'shadow-color',
  chart1: 'chart-1', chart2: 'chart-2', chart3: 'chart-3', chart4: 'chart-4', chart5: 'chart-5'
};

/** Resolve CSS colors for Canvas/WebGL, including token aliases and color-mix(). */
export function readThemePalette(element = document.documentElement) {
  const ownerDocument = element.ownerDocument;
  const probe = ownerDocument.createElement('span');
  probe.style.display = 'none';
  (element.isConnected ? element : ownerDocument.documentElement).appendChild(probe);
  let colorContext;
  const normalizedColors = new Map();
  const compatibleColor = color => {
    // Three/PIXI accept legacy rgb(), but computed CSS can retain color()/oklch().
    if (/^rgba?\(\s*[\d.]+\s*,/.test(color)) return color;
    if (normalizedColors.has(color)) return normalizedColors.get(color);
    if (!colorContext) {
      const canvas = ownerDocument.createElement('canvas');
      canvas.width = canvas.height = 1;
      colorContext = canvas.getContext('2d', {colorSpace:'srgb', willReadFrequently:true});
    }
    colorContext.clearRect(0, 0, 1, 1);
    colorContext.fillStyle = color;
    colorContext.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = colorContext.getImageData(0, 0, 1, 1).data;
    const resolved = a === 255 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${a / 255})`;
    normalizedColors.set(color, resolved);
    return resolved;
  };
  try {
    return Object.fromEntries(Object.entries(colorTokens).map(([key, token]) => {
      probe.style.color = `var(--theme-${token})`;
      return [key, compatibleColor(ownerDocument.defaultView.getComputedStyle(probe).color)];
    }));
  } finally { probe.remove(); }
}

/** Redraw mounted graphics once per frame; disconnect also cancels queued work. */
export function observeTheme(element, redraw) {
  const root = element.ownerDocument.documentElement;
  const view = element.ownerDocument.defaultView;
  let frame = 0;
  const observer = new view.MutationObserver(() => {
    if (frame) return;
    frame = view.requestAnimationFrame(() => { frame = 0; redraw(); });
  });
  observer.observe(root, {attributes:true, attributeFilter:['style', 'class', 'data-theme', 'data-site-theme']});
  return () => { observer.disconnect(); view.cancelAnimationFrame(frame); frame = 0; };
}
