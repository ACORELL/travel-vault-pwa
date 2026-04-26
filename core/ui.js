// Shared DOM, formatter, and sync-status helpers.
import { s } from './state.js';

// DOM lookups + class toggles
export function $(id)     { return document.getElementById(id); }
export function $$(sel)   { return document.querySelectorAll(sel); }
export function show(id)  { $(id).classList.remove('hidden'); }
export function hide(id)  { $(id).classList.add('hidden'); }

// Pure formatters
export function pad(n)      { return String(n).padStart(2, '0'); }
export function nowHHMM()   { const d = new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }
export function nowHHMMSS() { const d = new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; }
export function esc(str)    { return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
export function fmtDate(d)  { const [y,m,day] = d.split('-').map(Number); return `${day} ${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][m-1]} ${y}`; }

// Sync dot — single source of truth for s.syncStatus + the visual indicator
export function setSyncStatus(status) {
  s.syncStatus = status;
  const dot = $('sync-dot');
  dot.className = `sync-dot ${status}`;
  dot.title = status;
}
