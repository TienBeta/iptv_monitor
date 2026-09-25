// Downloads the iptv-org API and turns it into the list of streams to check:
// filter by the Sheet config, drop excluded / NSFW / closed channels, dedupe
// URLs and keep one best URL per channel+feed.

import { createHash } from 'node:crypto';
import { makeRule, matchName, nameWords, reportText, ruleMatches } from '../site/match.js';
import { hostOf, sleep } from './util.js';

export const API_BASE = 'https://iptv-org.github.io/api';

async function fetchJson(url) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
      if (!res.ok) throw new Error(`HTTP ${res.status} khi tải ${url}`);
      return await res.json();
    } catch (err) {
      if (attempt >= 2) throw err;
      await sleep(5000);
    }
  }
}

export async function fetchSource(base = API_BASE) {
  const optional = (name) => fetchJson(`${base}/${name}.json`).catch(() => []); // names for the dashboard only
  const [streams, channels, feeds, countries, languages, categories] = await Promise.all([
    ...['streams', 'channels', 'feeds', 'countries'].map((name) => fetchJson(`${base}/${name}.json`)),
    optional('languages'),
    optional('categories'),
  ]);
  if (!Array.isArray(streams) || streams.length === 0) throw new Error('streams.json rỗng hoặc sai định dạng');
  if (!Array.isArray(channels) || channels.length === 0) throw new Error('channels.json rỗng hoặc sai định dạng');
  if (!Array.isArray(feeds)) throw new Error('feeds.json sai định dạng');
  const list = (v) => (Array.isArray(v) ? v : []);
  return { streams, channels, feeds, countries: list(countries), languages: list(languages), categories: list(categories) };
}

// ---- Config from the Sheet ----

// iptv-org uses "UK" for the United Kingdom; accept the ISO code too.
const COUNTRY_ALIASES = { GB: 'UK' };

export function parseLevel(value) {
  const m = /^\s*(4a|4b|1|2|3)(?![0-9a-z])/i.exec(String(value ?? ''));
  return m ? m[1].toLowerCase() : '3';
}

export function normalizeConfig(raw = {}) {
  const list = (value, map) => [...new Set(
    String(value ?? '').split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean).map(map),
  )];
  return {
    countries: list(raw.countries, (s) => COUNTRY_ALIASES[s.toUpperCase()] || s.toUpperCase()),
    languages: list(raw.languages, (s) => s.toLowerCase()),
    categories: list(raw.categories, (s) => s.toLowerCase()),
    level: parseLevel(raw.level),
  };
}

// Changes when the filters or the exclude list change (not the level), so a
// deliberate change in scope is never mistaken for a broken source.
export function configHash(config, exclude) {
  const key = JSON.stringify([
    [...config.countries].sort(), [...config.languages].sort(), [...config.categories].sort(), [...exclude].sort(),
  ]);
  return createHash('sha1').update(key).digest('hex').slice(0, 12);
}

// ---- Building the list ----

export function qualityOf(q) {
  const m = /(\d+)/.exec(String(q ?? ''));
  return m ? Number(m[1]) : 0;
}

export function countryOf(channelId) {
  const dot = String(channelId ?? '').lastIndexOf('.');
  return dot > 0 ? channelId.slice(dot + 1).toUpperCase() : '';
}

const VI_REGIONS = new Intl.DisplayNames(['vi'], { type: 'region' });

function countryInfo(code, countries) {
  if (!code) return { countryName: '', flag: '' };
  const entry = countries.get(code);
  let name = '';
  try {
    name = VI_REGIONS.of(code === 'UK' ? 'GB' : code) || '';
  } catch {
    // not a region code Intl knows
  }
  if (!name || name === code) name = entry?.name || code;
  return { countryName: name, flag: entry?.flag || '' };
}

// Lower sorts first: no label, then higher quality, then API order.
function rank(stream, index) {
  return [stream.labels?.length ? 1 : 0, -qualityOf(stream.quality), index];
}
function better(a, b) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
}

// ---------------------------------------------------------------- Exclude
// The matching rules live in site/match.js, shared with the dashboard preview.
export { MIN_EXCLUDE_TEXT, foldText, wordsOf } from '../site/match.js';

export function excludeRules(entries) {
  const rules = [];
  const seen = new Set();
  for (const raw of entries || []) {
    const entry = String(raw ?? '').trim();
    if (!entry || seen.has(entry)) continue;
    seen.add(entry);
    rules.push({ ...makeRule(entry), count: 0, names: [], keys: new Set() });
  }
  return rules;
}

// True when a rule removes the stream; every matching rule counts it (for the
// report). `fields.key` (channel@feed) makes the count "rows that leave the list",
// not candidate links: a channel with a backup link still counts once.
export function applyExclude(rules, fields) {
  let hit = false;
  let words = null;
  for (const rule of rules) {
    if (rule.tooShort) continue;
    if (!rule.link) words ||= nameWords(fields);
    if (!ruleMatches(rule, fields, words)) continue;
    hit = true;
    if (!fields.key || !rule.keys.has(fields.key)) rule.count++;
    if (fields.key) rule.keys.add(fields.key);
    const name = matchName(fields);
    if (rule.names.length < 4 && !rule.names.includes(name)) rule.names.push(name);
  }
  return hit;
}

// What each line removes, shown next to it after every run.
export function excludeReport(rules) {
  return rules.map((r) => ({ entry: r.entry, text: reportText(r) }));
}

/**
 * The stream list for the config. `exclude`: Exclude lines (Set/array of
 * strings) or rules from excludeRules() when the caller wants the report.
 */
export function buildList(source, config, exclude = new Set()) {
  const rules = Array.isArray(exclude) && exclude.every((r) => typeof r === 'object') ? exclude : excludeRules(exclude);
  const channels = new Map(source.channels.map((c) => [c.id, c]));
  const feeds = new Map(source.feeds.map((f) => [`${f.channel}@${f.id}`, f]));
  const countries = new Map((source.countries || []).map((c) => [c.code, c]));
  const noFilter = !config.countries.length && !config.languages.length && !config.categories.length;

  const seen = new Set();
  const excluded = new Set();
  const best = new Map();
  const withoutChannel = [];

  source.streams.forEach((s, index) => {
    const url = String(s.url ?? '').trim();
    if (!url || seen.has(url) || excluded.has(url)) return;

    if (!s.channel) {
      // No metadata: can't be filtered or grouped, so only kept when nothing is filtered.
      if (noFilter) {
        if (applyExclude(rules, { url, title: s.title, key: url })) {
          excluded.add(url);
          return;
        }
        seen.add(url);
        withoutChannel.push({ s, index });
      }
      return;
    }
    const channel = channels.get(s.channel);
    if (channel && (channel.is_nsfw || channel.closed)) return;
    if (config.countries.length && !config.countries.includes(countryOf(s.channel))) return;
    if (config.languages.length) {
      const feed = feeds.get(`${s.channel}@${s.feed}`);
      if (!feed?.languages?.some((l) => config.languages.includes(l))) return;
    }
    if (config.categories.length && !channel?.categories?.some((c) => config.categories.includes(c))) return;
    // Checked inside the scope, so the report counts only links the Sheet would list.
    const feedKey = `${s.channel}@${s.feed ?? ''}`;
    if (applyExclude(rules, { url, title: s.title, channel: s.channel, name: channel?.name, altNames: channel?.alt_names, key: feedKey })) {
      excluded.add(url);
      return;
    }

    seen.add(url);
    const key = `${s.channel}@${s.feed ?? ''}`;
    const candidate = { s, index, rank: rank(s, index) };
    const current = best.get(key);
    if (!current || better(candidate.rank, current.rank)) best.set(key, candidate);
  });

  const toItem = ({ s }) => {
    const country = countryOf(s.channel);
    return {
      url: String(s.url).trim(),
      channel: s.channel || '',
      feed: s.feed || '',
      title: s.title || s.channel || '',
      country,
      ...countryInfo(country, countries),
      quality: s.quality || '',
      labels: Array.isArray(s.labels) ? s.labels : [],
      referrer: s.referrer || '',
      userAgent: s.user_agent || '',
    };
  };

  return [...best.values()].sort((a, b) => a.index - b.index).concat(withoutChannel).map(toItem);
}

// ---------------------------------------------------------------- options.json
// The catalog for the dashboard settings: what can be picked (with Vietnamese
// names and link counts) and a small index of every link, so the page can
// count a scope and preview exclude lines without the 20 MB iptv-org API.
// Index rows: [countryIdx | -1, [languageIdx], [categoryIdx], title, channel ID,
// channel name, host, altNames?] — indexes into the three lists, which keep
// their first-seen order (the page sorts for display).

const CATEGORY_NAMES = {
  general: 'Tổng hợp', news: 'Tin tức', entertainment: 'Giải trí', religious: 'Tôn giáo', music: 'Âm nhạc',
  movies: 'Phim', series: 'Phim bộ', sports: 'Thể thao', kids: 'Thiếu nhi', documentary: 'Tài liệu',
  comedy: 'Hài', education: 'Giáo dục', culture: 'Văn hoá', legislative: 'Quốc hội, chính phủ',
  animation: 'Hoạt hình', lifestyle: 'Đời sống', classic: 'Kinh điển', shop: 'Mua sắm', outdoor: 'Ngoài trời',
  business: 'Kinh doanh', family: 'Gia đình', travel: 'Du lịch', cooking: 'Nấu ăn', public: 'Công cộng',
  auto: 'Ô tô, xe', science: 'Khoa học', weather: 'Thời tiết', relax: 'Thư giãn', interactive: 'Tương tác',
};
const VI_LANGUAGES = new Intl.DisplayNames(['vi'], { type: 'language' });

function languageName(code, apiNames) {
  let name = '';
  try {
    name = VI_LANGUAGES.of(code) || '';
  } catch {
    // not a code Intl knows
  }
  if (!name || name === code || name === 'root') name = apiNames.get(code) || code;
  return name;
}

export function buildOptions(source) {
  const all = buildList(source, normalizeConfig({}));
  const feeds = new Map(source.feeds.map((f) => [`${f.channel}@${f.id}`, f]));
  const channels = new Map(source.channels.map((c) => [c.id, c]));
  const langNames = new Map((source.languages || []).map((l) => [l.code, l.name]));
  const catNames = new Map((source.categories || []).map((c) => [c.id, c.name]));
  const lists = { countries: [], languages: [], categories: [] };
  const index = { countries: new Map(), languages: new Map(), categories: new Map() };
  const add = (kind, key, make) => {
    if (!index[kind].has(key)) {
      index[kind].set(key, lists[kind].length);
      lists[kind].push({ ...make(), n: 0 });
    }
    const i = index[kind].get(key);
    lists[kind][i].n++;
    return i;
  };
  const links = all.map((s) => {
    const channel = channels.get(s.channel);
    const feed = feeds.get(`${s.channel}@${s.feed}`);
    const c = s.country ? add('countries', s.country, () => ({ code: s.country, name: s.countryName, flag: s.flag })) : -1;
    const l = (feed?.languages || []).map((code) => add('languages', code, () => ({ code, name: languageName(code, langNames) })));
    const k = (channel?.categories || []).map((id) => add('categories', id, () => ({ id, name: CATEGORY_NAMES[id] || catNames.get(id) || id })));
    const row = [c, l, k, s.title, s.channel, channel?.name || '', hostOf(s.url) || ''];
    if (channel?.alt_names?.length) row.push(channel.alt_names);
    return row;
  });
  return { ...lists, links };
}
