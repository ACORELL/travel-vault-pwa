// Tab activation. Wires .tab-btn click handlers to toggle .active on
// .tab-btn buttons and .tab-panel sections. No knowledge of what tabs do.
import { $$ } from './ui.js';

export function setupTabs() {
  $$('.tab-btn').forEach(btn => btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;
    $$('.tab-btn').forEach(b   => b.classList.toggle('active', b.dataset.tab === tab));
    $$('.tab-panel').forEach(p => p.classList.toggle('active', p.id === `tab-${tab}`));
  }));
}
