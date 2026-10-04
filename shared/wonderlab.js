/* =====================================================================
   Wonderlab — shared chrome behaviour (classic script, load with defer)
   • H toggles immersive mode: every .wl-ui element hides. Fires a
     "wl:ui" event on window with detail { hidden }.
   • .wl-hint elements fade after the first deliberate interaction, or
     after 14 s.
   • .wl-range inputs get a filled track (CSS var --p). Call
     Wonderlab.syncRanges() after changing a slider's value from code.
   • [data-wl-open="dialog-id"] opens that <dialog>; [data-wl-close]
     closes the dialog it sits in; clicking the backdrop closes too.
   ===================================================================== */
(() => {
  'use strict';

  const isTextEntry = (el) =>
    el instanceof Element &&
    !!el.closest('input:not([type="range"]):not([type="checkbox"]):not([type="radio"]):not([type="button"]), textarea, select, [contenteditable=""], [contenteditable="true"]');

  // ---- immersive mode -------------------------------------------------
  function setUIHidden(hidden) {
    document.body.classList.toggle('wl-ui-hidden', hidden);
    window.dispatchEvent(new CustomEvent('wl:ui', { detail: { hidden } }));
  }
  const toggleUI = () => setUIHidden(!document.body.classList.contains('wl-ui-hidden'));

  window.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.repeat || e.metaKey || e.ctrlKey || e.altKey || isTextEntry(e.target)) return;
    if (e.key === 'h' || e.key === 'H') toggleUI();
  });

  // ---- hints ----------------------------------------------------------
  let hintsHidden = false;
  function hideHints() {
    if (hintsHidden) return;
    hintsHidden = true;
    document.querySelectorAll('.wl-hint').forEach((el) => el.classList.add('is-hidden'));
  }
  const loadedAt = performance.now();
  const onInteract = () => { if (performance.now() - loadedAt > 1200) hideHints(); };
  ['pointerdown', 'keydown', 'wheel'].forEach((type) => window.addEventListener(type, onInteract, { passive: true }));
  setTimeout(hideHints, 14000);

  // ---- range fill -------------------------------------------------------
  function syncRange(el) {
    const min = parseFloat(el.min || '0');
    const max = parseFloat(el.max || '100');
    const val = parseFloat(el.value);
    const p = max > min ? ((val - min) / (max - min)) * 100 : 0;
    el.style.setProperty('--p', `${Math.min(100, Math.max(0, p))}%`);
  }
  const syncRanges = () => document.querySelectorAll('input.wl-range').forEach(syncRange);
  document.addEventListener('input', (e) => { if (e.target instanceof HTMLInputElement && e.target.matches('.wl-range')) syncRange(e.target); });

  // ---- dialogs ----------------------------------------------------------
  document.addEventListener('click', (e) => {
    if (!(e.target instanceof Element)) return;
    const opener = e.target.closest('[data-wl-open]');
    if (opener) {
      const dlg = document.getElementById(opener.getAttribute('data-wl-open'));
      if (dlg instanceof HTMLDialogElement && !dlg.open) dlg.showModal();
      return;
    }
    const closer = e.target.closest('[data-wl-close]');
    if (closer) { closer.closest('dialog')?.close(); return; }
    // click on the ::backdrop lands on the dialog element itself
    if (e.target instanceof HTMLDialogElement && e.target.matches('.wl-dialog')) {
      const r = e.target.getBoundingClientRect();
      const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      if (!inside) e.target.close();
    }
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', syncRanges);
  else syncRanges();

  window.Wonderlab = Object.freeze({ toggleUI, setUIHidden, hideHints, syncRanges, syncRange });
})();
