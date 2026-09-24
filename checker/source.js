// Downloads the iptv-org API and turns it into the list of streams to check:
// filter by the Sheet config, drop excluded / NSFW / closed channels, dedupe
// URLs and keep one best URL per channel+feed.

import { createHash } from 'node:crypto';
import { sleep } from './util.js';

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
  const [streams, channels, feeds, countries] = await Promise.all(
    ['streams', 'channels', 'feeds', 'countries'].map((name) => fetchJson(`${base}/${name}.json`)),
  );
  if (!Array.isArray(streams) || streams.length === 0) throw new Error('streams.json rỗng hoặc sai định dạng');
  if (!Array.isArray(channels) || channels.length === 0) throw new Error('channels.json rỗng hoặc sai định dạng');
  if (!Array.isArray(feeds)) throw new Error('feeds.json sai định dạng');
  return { streams, channels, feeds, countries: Array.isArray(countries) ? countries : [] };
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
// Each line of the Sheet "Exclude" (column A):
// - a full link ("…://…") removes exactly that link;
// - text removes every link whose name or channel ID has it at the start of a
//   word, ignoring case, accents, spaces and punctuation: "an ninh" / "anninh"
//   match AnNinhTV.vn and "An Ninh TV", "dong thap" matches "Đồng Tháp TV1",
//   "VTV" matches VTV1 but not "Lao SV TV" (words: lao, sv, tv);
// - text with a "." or "/" and no spaces ("vtvprime.vn", "AnNinhTV.vn") is also
//   looked for in the link. Plain text is not: most VN links are on vtvprime.vn,
//   so "VTV" would otherwise remove nearly every channel.
// Text with fewer than MIN_EXCLUDE_TEXT letters/digits is ignored ("TV").
export const MIN_EXCLUDE_TEXT = 3;

export function foldText(value) {
  return String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, 'd').toLowerCase().replace(/[^a-z0-9]/g, '');
}

const isLink = (text) => /^[a-z][a-z0-9+.-]*:\/\//i.test(text);

// "AnNinhTV.vn" → ["an", "ninh", "tv", "vn"]; "Đồng Tháp TV1" → ["dong", "thap", "tv1"]
export function wordsOf(value) {
  return String(value ?? '').replace(/(\p{Ll})(\p{Lu})/gu, '$1 $2').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, 'd').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

// `compact` (folded, no spaces) starts at a word and runs over the next words.
function startsAtWord(words, compact) {
  for (let i = 0; i < words.length; i++) {
    let joined = '';
    for (let j = i; j < words.length && joined.length < compact.length; j++) joined += words[j];
    // "vtv1" matches VTV1 / VTV1 HD, not VTV10: a number must end where the text ends
    if (joined.startsWith(compact) && !(/\d$/.test(compact) && /\d/.test(joined.charAt(compact.length)))) return true;
  }
  return false;
}

export function excludeRules(entries) {
  const rules = [];
  const seen = new Set();
  for (const raw of entries || []) {
    const entry = String(raw ?? '').trim();
    if (!entry || seen.has(entry)) continue;
    seen.add(entry);
    const link = isLink(entry);
    const folded = link ? '' : foldText(entry);
    const inLink = !link && /[./]/.test(entry) && !/\s/.test(entry) ? entry.toLowerCase() : '';
    rules.push({ entry, link, folded, inLink, tooShort: !link && folded.length < MIN_EXCLUDE_TEXT, count: 0, names: [] });
  }
  return rules;
}

// True when a rule removes the stream; every matching rule counts it (for the report).
export function applyExclude(rules, fields) {
  let hit = false;
  let folded = null;
  for (const rule of rules) {
    if (rule.tooShort) continue;
    let match;
    if (rule.link) {
      match = fields.url === rule.entry;
    } else {
      folded ||= [fields.title, fields.channel, fields.name, ...(fields.altNames || [])].map(wordsOf);
      match = folded.some((words) => startsAtWord(words, rule.folded))
        || (!!rule.inLink && String(fields.url || '').toLowerCase().includes(rule.inLink));
    }
    if (match) {
      hit = true;
      rule.count++;
      // channels, not link titles, so an unexpected match ("VTV" → ANTV on vtvprime.vn) is visible
      const name = fields.name || fields.channel || fields.title || fields.url;
      if (rule.names.length < 4 && !rule.names.includes(name)) rule.names.push(name);
    }
  }
  return hit;
}

// What each line removes, written to column C of "Exclude" after every run.
export function excludeReport(rules) {
  return rules.map((r) => {
    let text;
    if (r.tooShort) text = `Chưa dùng: cần ít nhất ${MIN_EXCLUDE_TEXT} chữ hoặc số`;
    else if (!r.count) text = r.link ? 'Không khớp link nào (link phải giống hệt)' : 'Không khớp kênh nào';
    else {
      const shown = r.names.slice(0, 3);
      text = `${r.count} link: ${shown.join(', ')}${r.names.length > 3 ? ', …' : ''}`;
    }
    return { entry: r.entry, text };
  });
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
        if (applyExclude(rules, { url, title: s.title })) {
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
    if (applyExclude(rules, { url, title: s.title, channel: s.channel, name: channel?.name, altNames: channel?.alt_names })) {
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
