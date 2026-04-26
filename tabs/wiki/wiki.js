// Wiki tab — data loading. Pulls pages from the wiki service, populates state,
// and asks the two UI modules (today-strip, wiki-ui) to re-render.
import { s } from '../../core/state.js';
import * as settings from '../../services/settings.js';
import { GITHUB_PAT, GITHUB_REPO } from '../../services/settings.js';
import * as wikiService from '../../services/wiki.js';
import { renderWikiList } from './wiki-ui.js';
import { renderTodayStrip } from './today-strip.js';

export async function loadWiki() {
  if (!settings.get(GITHUB_PAT) || !settings.get(GITHUB_REPO)) return;
  try {
    s.wikiPages = await wikiService.loadWikiPages();
    renderTodayStrip();
    renderWikiList('');
  } catch {}
}
