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

export function buildList(source, config, exclude = new Set()) {
  const channels = new Map(source.channels.map((c) => [c.id, c]));
  const feeds = new Map(source.feeds.map((f) => [`${f.channel}@${f.id}`, f]));
  const countries = new Map((source.countries || []).map((c) => [c.code, c]));
  const noFilter = !config.countries.length && !config.languages.length && !config.categories.length;

  const seen = new Set();
  const best = new Map();
  const withoutChannel = [];

  source.streams.forEach((s, index) => {
    const url = String(s.url ?? '').trim();
    if (!url || seen.has(url) || exclude.has(url)) return;

    if (!s.channel) {
      // No metadata: can't be filtered or grouped, so only kept when nothing is filtered.
      if (noFilter) {
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
