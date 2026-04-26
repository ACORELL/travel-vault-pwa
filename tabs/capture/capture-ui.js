// Raw capture sheet — open/close, save handler with offline queue + auth-error redirect.
import { $, pad, show, hide, setSyncStatus } from '../../core/ui.js';
import { putFile, GitHubAuthError } from '../../services/github.js';
import * as queue from '../../services/queue.js';
import * as geoloc from '../../services/location.js';
import * as settingsUi from '../../settings/settings-ui.js';

export function initCaptureUi() {
  $('wiki-capture-btn').addEventListener('click', openCaptureSheet);
  $('capture-cancel').addEventListener('click', closeCaptureSheet);
  $('capture-save').addEventListener('click', saveRawCapture);
}

export function openCaptureSheet() {
  $('capture-text').value = '';
  $('capture-status').style.display = 'none';
  $('capture-save').disabled = false;
  $('capture-save').textContent = 'Save';
  show('raw-capture-form');
  $('capture-text').focus();
}

export function closeCaptureSheet() {
  hide('raw-capture-form');
  $('capture-text').value = '';
  $('capture-status').style.display = 'none';
}

export async function saveRawCapture() {
  const text = $('capture-text').value;
  if (!text.trim()) return;

  const btn = $('capture-save');
  btn.disabled = true;
  btn.textContent = 'Saving…';

  const gps = await geoloc.sample({ timeout: 5000, maximumAge: 60000 });

  const now = new Date();
  const datePart = now.toISOString().slice(0, 10);
  const hh = pad(now.getHours()), mm = pad(now.getMinutes()), ss = pad(now.getSeconds());
  const datetime = `${datePart} ${hh}:${mm}`;
  const filename = `${datePart}_${hh}-${mm}-${ss}_raw.md`;
  const path = `wiki/raw/${filename}`;

  const geoLine = gps ? `\ngeo: ${gps.lat.toFixed(6)},${gps.lon.toFixed(6)}` : '';
  const content = `# Raw capture — ${datetime}\n\n${text.trim()}\n\n---\ncaptured: ${datetime}${geoLine}\n`;
  const message = `Raw capture ${datetime}`;

  const st = $('capture-status');
  try {
    await putFile(path, content, message);
    await queue.flush();
    setSyncStatus('synced');
    st.textContent = 'Saved to raw ✓';
    st.style.color = '#166534';
    st.style.display = 'block';
    setTimeout(closeCaptureSheet, 2000);
  } catch (e) {
    if (e instanceof GitHubAuthError) {
      setSyncStatus('offline');
      // Don't discard the user's text — park it in the queue. The next
      // successful capture (after the PAT is fixed) will drain it via flush().
      try { await queue.enqueue({ path, content, message }); } catch {}
      btn.disabled = false;
      btn.textContent = 'Save';
      st.textContent = 'Capture saved — fix PAT to send';
      st.style.color = '#92400e';
      st.style.display = 'block';
      setTimeout(() => {
        closeCaptureSheet();
        settingsUi.openSettings();
      }, 1200);
      return;
    }
    // Network or unknown error — queue locally and confirm.
    try {
      await queue.enqueue({ path, content, message });
      setSyncStatus('offline');
      st.textContent = 'Saved offline ✓';
      st.style.color = '#92400e';
      st.style.display = 'block';
      setTimeout(closeCaptureSheet, 2000);
    } catch (qe) {
      console.error('Raw capture + queue both failed:', e, qe);
      btn.disabled = false;
      btn.textContent = 'Save';
      st.textContent = 'Save failed — try again';
      st.style.color = '#dc2626';
      st.style.display = 'block';
    }
  }
}
