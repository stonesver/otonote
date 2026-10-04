/** Close only after a press and release outside the same top-level panel. */
export function installWorkspaceDismiss(panel, launcher, onDismiss = () => panel.close()) {
  const doc = panel.ownerDocument;
  let beganOutside = false;
  function outside(event) {
    if (!panel.open || panel.isConnected === false || panel.querySelector('dialog[open]')) return false;
    if (launcher?.contains(event.target)) return false;
    if (event.target !== panel) return !panel.contains(event.target);
    const bounds = panel.getBoundingClientRect();
    return event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom;
  }
  const down = event => { beganOutside = event.button === 0 && outside(event); };
  const click = event => { const dismiss = beganOutside && outside(event); beganOutside = false; if (dismiss) onDismiss(); };
  const cancel = () => { beganOutside = false; };
  doc.addEventListener('pointerdown', down, {capture:true});
  doc.addEventListener('click', click, {capture:true});
  doc.addEventListener('pointercancel', cancel, {capture:true});
  panel.addEventListener('close', cancel);
  return () => { doc.removeEventListener('pointerdown', down, {capture:true}); doc.removeEventListener('click', click, {capture:true}); doc.removeEventListener('pointercancel', cancel, {capture:true}); panel.removeEventListener('close', cancel); };
}
