// Channel details for the Sheet "Streams" (logo, region, subdivision, city,
// language, video format, network, owners, website, launch / close dates,
// programme guide), looked up in the optional iptv-org files. A file that did
// not load only leaves its column empty.

import { languageName } from './source.js';

// Vietnamese names of the iptv-org regions (the rest keep the API name).
const REGION_NAMES = {
  AFR: 'Châu Phi', AMER: 'Châu Mỹ', ASIA: 'Châu Á', EUR: 'Châu Âu', OCE: 'Châu Đại Dương',
  SEA: 'Đông Nam Á', EAS: 'Đông Á', SAS: 'Nam Á', CAS: 'Trung Á', WAS: 'Tây Á', MIDEAST: 'Trung Đông',
  NEU: 'Bắc Âu', WER: 'Tây Âu', SER: 'Nam Âu', CEU: 'Trung Âu', CEE: 'Trung và Đông Âu',
  EAF: 'Đông Phi', WAF: 'Tây Phi', SAF: 'Miền nam châu Phi', SSA: 'Châu Phi hạ Sahara', MAGHREB: 'Maghreb (Bắc Phi)',
  NAM: 'Bắc Mỹ', NORAM: 'Bắc Mỹ', CENAMER: 'Trung Mỹ', CARIB: 'Caribe', SOUTHAM: 'Nam Mỹ',
};
// Geographic regions only (not UN, EU, ASEAN, APAC, Worldwide…): the smallest
// one that contains the channel's country is its "Khu vực".
const GEO_REGIONS = new Set(Object.keys(REGION_NAMES));
const RASTER = new Set(['PNG', 'JPEG', 'GIF', 'WEBP']); // shown by the Sheet's IMAGE()

const join = (list) => [...new Set(list.filter(Boolean))].join(', ');
const isoDate = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v ?? '')) ? String(v) : '');

// Best logo of a channel+feed: this feed's, else the channel's; in use; an
// image format the Sheet can show; largest.
function pickLogo(logos, feed) {
  const score = (l) => [l.feed === feed ? 0 : l.feed ? 2 : 1, l.in_use === false ? 1 : 0,
    RASTER.has(String(l.format || '').toUpperCase()) ? 0 : 1, -(Number(l.width) || 0)];
  const lower = (a, b) => {
    const i = a.findIndex((v, k) => v !== b[k]);
    return i >= 0 && a[i] < b[i];
  };
  let best = null;
  for (const l of logos) {
    if (!/^https?:\/\/\S+$/.test(String(l.url || ''))) continue;
    const s = score(l);
    if (!best || lower(s, best.score)) best = { url: l.url, score: s };
  }
  return best ? best.url : '';
}

function groupBy(list, key) {
  const map = new Map();
  for (const x of list || []) {
    const k = key(x);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(x);
  }
  return map;
}

/** Adds the detail fields to each item of buildList() (returns the same items). */
export function addDetails(source, items) {
  const channels = new Map(source.channels.map((c) => [c.id, c]));
  const feeds = new Map(source.feeds.map((f) => [`${f.channel}@${f.id}`, f]));
  const logos = groupBy(source.logos, (l) => l.channel);
  const guides = groupBy((source.guides || []).filter((g) => g.channel), (g) => g.channel);
  const subdivisions = new Map((source.subdivisions || []).map((s) => [s.code, s]));
  const cities = new Map((source.cities || []).map((c) => [c.code, c]));
  const langNames = new Map((source.languages || []).map((l) => [l.code, l.name]));
  const regionOf = new Map();
  const regionFor = (country) => {
    if (!regionOf.has(country)) {
      const r = (source.regions || [])
        .filter((x) => GEO_REGIONS.has(x.code) && Array.isArray(x.countries) && x.countries.includes(country))
        .sort((a, b) => a.countries.length - b.countries.length)[0];
      regionOf.set(country, r ? REGION_NAMES[r.code] || r.name : '');
    }
    return regionOf.get(country);
  };

  for (const it of items) {
    const channel = channels.get(it.channel);
    const feed = feeds.get(`${it.channel}@${it.feed}`);
    // Broadcast area codes: c/VN, r/SEA, s/AU-NSW (subdivision), ct/AUSYD (city)
    const area = (feed?.broadcast_area || []).map(String);
    const cityList = area.filter((a) => a.startsWith('ct/')).map((a) => cities.get(a.slice(3))).filter(Boolean);
    const subCodes = [...area.filter((a) => a.startsWith('s/')).map((a) => a.slice(2)), ...cityList.map((c) => c.subdivision)];
    const channelGuides = guides.get(it.channel) || [];
    const feedGuides = channelGuides.filter((g) => g.feed === it.feed);
    Object.assign(it, {
      logo: channel ? pickLogo(logos.get(it.channel) || [], it.feed) : '',
      region: it.country ? regionFor(it.country) : '',
      subdivision: join(subCodes.map((code) => subdivisions.get(code)?.name)),
      city: join(cityList.map((c) => c.name)),
      languageNames: join((feed?.languages || []).map((code) => languageName(code, langNames))),
      format: String(feed?.format || ''),
      network: String(channel?.network || ''),
      owners: join(channel?.owners || []),
      website: String(channel?.website || ''),
      launched: isoDate(channel?.launched),
      closed: isoDate(channel?.closed),
      // Sites the iptv-org EPG takes this channel's schedule from ("lịch phát sóng")
      guide: join((feedGuides.length ? feedGuides : channelGuides).map((g) => g.site)),
    });
  }
  return items;
}
