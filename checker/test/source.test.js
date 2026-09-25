// Filtering, dedupe and "one URL per channel+feed" selection.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildList, buildOptions, configHash, countryOf, excludeReport, excludeRules, foldText, normalizeConfig, parseLevel, qualityOf, wordsOf } from '../source.js';

const source = {
  channels: [
    { id: 'VTV1.vn', country: 'VN', categories: ['general', 'news'], is_nsfw: false, closed: null },
    { id: 'VTV3.vn', country: 'VN', categories: ['entertainment'], is_nsfw: false, closed: null },
    { id: 'OldTV.vn', country: 'VN', categories: ['general'], is_nsfw: false, closed: '2020-01-01' },
    { id: 'Adult.vn', country: 'VN', categories: ['xxx'], is_nsfw: true, closed: null },
    { id: 'ThaiPBS.th', country: 'TH', categories: ['news'], is_nsfw: false, closed: null },
    { id: 'BBCOne.uk', country: 'UK', categories: ['general'], is_nsfw: false, closed: null },
    { id: 'AnNinhTV.vn', name: 'ANTV', alt_names: ['An Ninh Truyền Hình'], country: 'VN', categories: ['news'], is_nsfw: false, closed: null },
    { id: 'DongThapTV1.vn', name: 'Đồng Tháp TV1', country: 'VN', categories: ['general'], is_nsfw: false, closed: null },
  ],
  feeds: [
    { channel: 'VTV1.vn', id: 'HD', languages: ['vie'], is_main: true },
    { channel: 'VTV1.vn', id: 'SD', languages: ['vie'], is_main: false },
    { channel: 'VTV3.vn', id: 'HD', languages: ['vie'], is_main: true },
    { channel: 'ThaiPBS.th', id: 'SD', languages: ['tha'], is_main: true },
    { channel: 'BBCOne.uk', id: 'HD', languages: ['eng'], is_main: true },
  ],
  countries: [{ code: 'VN', name: 'Vietnam', flag: '🇻🇳' }, { code: 'TH', name: 'Thailand', flag: '🇹🇭' }, { code: 'UK', name: 'United Kingdom', flag: '🇬🇧' }],
  streams: [
    { channel: 'VTV1.vn', feed: 'HD', title: 'VTV1 geo 1080', url: 'https://a/vtv1-geo.m3u8', quality: '1080p', labels: ['Geo-blocked'], referrer: null, user_agent: null },
    { channel: 'VTV1.vn', feed: 'HD', title: 'VTV1 720', url: 'https://a/vtv1-720.m3u8', quality: '720p', labels: [], referrer: null, user_agent: null },
    { channel: 'VTV1.vn', feed: 'HD', title: 'VTV1 1080', url: 'https://a/vtv1-1080.m3u8', quality: '1080p', labels: [], referrer: 'https://ref/', user_agent: 'UA/1' },
    { channel: 'VTV1.vn', feed: 'HD', title: 'VTV1 1080 dup', url: 'https://a/vtv1-1080b.m3u8', quality: '1080p', labels: [], referrer: null, user_agent: null },
    { channel: 'VTV1.vn', feed: 'SD', title: 'VTV1 SD', url: 'https://a/vtv1-sd.m3u8', quality: null, labels: [], referrer: null, user_agent: null },
    { channel: 'VTV3.vn', feed: 'HD', title: 'VTV3', url: 'https://a/vtv3.m3u8', quality: '1080i', labels: ['Not 24/7'], referrer: null, user_agent: null },
    { channel: 'VTV3.vn', feed: 'HD', title: 'VTV3 same url', url: 'https://a/vtv3.m3u8', quality: '2160p', labels: [], referrer: null, user_agent: null },
    { channel: 'OldTV.vn', feed: 'SD', title: 'Old', url: 'https://a/old.m3u8', quality: '576p', labels: [], referrer: null, user_agent: null },
    { channel: 'Adult.vn', feed: 'SD', title: 'Adult', url: 'https://a/adult.m3u8', quality: '576p', labels: [], referrer: null, user_agent: null },
    { channel: 'ThaiPBS.th', feed: 'SD', title: 'Thai PBS', url: 'https://b/thai.m3u8', quality: '720p', labels: [], referrer: null, user_agent: null },
    { channel: 'BBCOne.uk', feed: 'HD', title: 'BBC One', url: 'https://c/bbc.m3u8', quality: '1080p', labels: [], referrer: null, user_agent: null },
    { channel: null, feed: null, title: 'Unknown', url: 'https://d/unknown.m3u8', quality: null, labels: [], referrer: null, user_agent: null },
  ],
};
// Extra channels for the Exclude tests (kept out of the list assertions above).
const withNews = {
  ...source,
  streams: [
    ...source.streams,
    { channel: 'AnNinhTV.vn', feed: 'HD', title: 'ANTV', url: 'https://liveh12.vtvprime.vn/hls/ANNINHTV/index.m3u8', quality: '720p', labels: [], referrer: null, user_agent: null },
    { channel: 'AnNinhTV.vn', feed: 'HD', title: 'ANTV backup', url: 'https://e/antv-2.m3u8', quality: '576p', labels: [], referrer: null, user_agent: null },
    { channel: 'DongThapTV1.vn', feed: 'HD', title: 'Đồng Tháp TV1', url: 'https://f/dongthap.m3u8', quality: '720p', labels: [], referrer: null, user_agent: null },
  ],
};
const vn = normalizeConfig({ countries: 'VN' });
const urls = (list) => list.map((s) => s.url);

describe('buildList', () => {
  test('lọc theo quốc gia VN; loại NSFW + kênh đã đóng; mỗi channel+feed 1 URL', () => {
    const list = buildList(source, normalizeConfig({ countries: 'VN' }));
    assert.deepEqual(urls(list), ['https://a/vtv1-1080.m3u8', 'https://a/vtv1-sd.m3u8', 'https://a/vtv3.m3u8']);
  });
  test('ưu tiên: không label → quality cao hơn → thứ tự API', () => {
    const [vtv1] = buildList(source, normalizeConfig({ countries: 'VN' }));
    assert.equal(vtv1.title, 'VTV1 1080'); // not the geo-blocked 1080p, not the later duplicate 1080p
    assert.equal(vtv1.referrer, 'https://ref/');
    assert.equal(vtv1.userAgent, 'UA/1');
  });
  test('URL trùng: giữ bản xuất hiện đầu tiên', () => {
    const vtv3 = buildList(source, normalizeConfig({ countries: 'VN' })).find((s) => s.channel === 'VTV3.vn');
    assert.equal(vtv3.title, 'VTV3');
    assert.deepEqual(vtv3.labels, ['Not 24/7']);
  });
  test('nhiều quốc gia (OR), mã GB được hiểu là UK', () => {
    const list = buildList(source, normalizeConfig({ countries: 'th; gb' }));
    assert.deepEqual(urls(list), ['https://b/thai.m3u8', 'https://c/bbc.m3u8']);
    assert.equal(list[1].countryName, 'Vương quốc Anh');
  });
  test('ngôn ngữ và thể loại kết hợp AND', () => {
    assert.deepEqual(urls(buildList(source, normalizeConfig({ languages: 'vie', categories: 'news' }))),
      ['https://a/vtv1-1080.m3u8', 'https://a/vtv1-sd.m3u8']);
    assert.deepEqual(urls(buildList(source, normalizeConfig({ countries: 'VN', categories: 'news, entertainment' }))),
      ['https://a/vtv1-1080.m3u8', 'https://a/vtv1-sd.m3u8', 'https://a/vtv3.m3u8']);
  });
  test('stream không có channel chỉ được giữ khi không lọc gì', () => {
    assert.ok(urls(buildList(source, normalizeConfig({}))).includes('https://d/unknown.m3u8'));
    assert.ok(!urls(buildList(source, normalizeConfig({ languages: 'eng' }))).includes('https://d/unknown.m3u8'));
  });
  test('Exclude bằng link đầy đủ: chỉ bỏ đúng link đó; link tốt kế tiếp của kênh được chọn', () => {
    const list = buildList(source, vn, new Set(['https://a/vtv1-1080.m3u8']));
    assert.equal(list[0].url, 'https://a/vtv1-1080b.m3u8');
    // a link that is only a prefix does not count as the same link
    assert.equal(buildList(source, vn, new Set(['https://a/vtv1-1080']))[0].url, 'https://a/vtv1-1080.m3u8');
  });
  test('Exclude bằng chữ: "An Ninh" bỏ cả kênh AnNinhTV.vn (mọi link), không phân biệt hoa thường / khoảng trắng', () => {
    const before = urls(buildList(withNews, vn));
    assert.ok(before.includes('https://liveh12.vtvprime.vn/hls/ANNINHTV/index.m3u8'));
    for (const text of ['An Ninh', 'an ninh', 'ANNINH', 'An-Ninh', 'an ninh tv']) {
      const after = urls(buildList(withNews, vn, new Set([text])));
      assert.ok(!after.some((u) => /antv|ANNINHTV/i.test(u)), text);
      assert.equal(after.length, before.length - 1, text);
    }
  });
  test('Exclude bằng chữ: không phân biệt dấu, khớp tên / tên khác / mã kênh', () => {
    const left = (text) => urls(buildList(withNews, vn, new Set([text])));
    assert.ok(!left('dong thap').includes('https://f/dongthap.m3u8')); // "Đồng Tháp TV1"
    assert.ok(!left('Truyền Hình').some((u) => /antv|ANNINHTV/i.test(u))); // alt_names
    assert.ok(!left('AnNinhTV.vn').some((u) => /antv|ANNINHTV/i.test(u))); // channel ID
    assert.deepEqual(left('VTV3'), urls(buildList(withNews, vn)).filter((u) => u !== 'https://a/vtv3.m3u8'));
  });
  test('chữ thường không so với link ("VTV" không bỏ ANTV dù link ở vtvprime.vn); tên miền / một phần link thì có', () => {
    const left = (text) => urls(buildList(withNews, vn, new Set([text])));
    assert.ok(left('VTV').includes('https://liveh12.vtvprime.vn/hls/ANNINHTV/index.m3u8'));
    assert.ok(!left('vtvprime.vn').includes('https://liveh12.vtvprime.vn/hls/ANNINHTV/index.m3u8'));
    assert.ok(!left('vtvprime.vn/hls/ANNINHTV').includes('https://liveh12.vtvprime.vn/hls/ANNINHTV/index.m3u8'));
    assert.ok(left('vtvprime.vn').includes('https://e/antv-2.m3u8')); // the backup link is elsewhere
  });
  test('Exclude chữ quá ngắn (< 3 chữ/số) bị bỏ qua để "TV" không xoá hết', () => {
    assert.equal(buildList(withNews, vn, new Set(['TV', ' . '])).length, buildList(withNews, vn).length);
  });
  test('báo cáo cột "Đang bỏ": số link + tên kênh mỗi dòng', () => {
    const rules = excludeRules(['An Ninh', 'VTV', 'TV', 'Không có kênh này', 'https://x/khong-co.m3u8']);
    buildList(withNews, vn, rules);
    assert.deepEqual(excludeReport(rules), [
      // rows that leave the list: ANTV has a backup link in the same feed → 1
      { entry: 'An Ninh', text: '1 link: ANTV' },
      { entry: 'VTV', text: '3 link: VTV1.vn, VTV3.vn' }, // VTV1 HD + SD, VTV3 HD
      { entry: 'TV', text: 'Chưa dùng: cần ít nhất 3 chữ hoặc số' },
      { entry: 'Không có kênh này', text: 'Không khớp kênh nào' },
      { entry: 'https://x/khong-co.m3u8', text: 'Không khớp link nào (link phải giống hệt)' },
    ]);
  });
  test('chữ phải bắt đầu ở đầu một từ: "VTV" không khớp "Lao SV TV", "HTV" không khớp "An Ninh TV"', () => {
    const src = {
      ...source,
      channels: [...source.channels, { id: 'LaoSVTV.vn', name: 'Lao SV TV', country: 'VN', categories: ['general'] }],
      streams: [...withNews.streams, { channel: 'LaoSVTV.vn', feed: 'SD', title: 'Lao SV TV', url: 'https://g/laosv.m3u8', quality: '', labels: [] }],
    };
    const left = (text) => urls(buildList(src, vn, new Set([text])));
    assert.ok(left('VTV').includes('https://g/laosv.m3u8'));
    assert.ok(!left('lao sv').includes('https://g/laosv.m3u8'));
    assert.ok(left('HTV').includes('https://liveh12.vtvprime.vn/hls/ANNINHTV/index.m3u8'));
    assert.ok(!left('ninh tv').includes('https://liveh12.vtvprime.vn/hls/ANNINHTV/index.m3u8')); // từ giữa tên cũng được
  });
  test('chữ kết thúc bằng số khớp trọn số: "VTV1" không bỏ VTV10', () => {
    const src = {
      ...source,
      channels: [...source.channels, { id: 'VTV10.vn', name: 'VTV10', country: 'VN', categories: ['general'] }],
      streams: [...source.streams, { channel: 'VTV10.vn', feed: 'SD', title: 'VTV10', url: 'https://h/vtv10.m3u8', quality: '', labels: [] }],
    };
    const left = urls(buildList(src, vn, new Set(['VTV1'])));
    assert.ok(left.includes('https://h/vtv10.m3u8'));
    assert.ok(!left.some((u) => u.includes('/vtv1-')));
  });
  test('wordsOf: tách chữ hoa kiểu AnNinhTV, bỏ dấu', () => {
    assert.deepEqual(wordsOf('AnNinhTV.vn'), ['an', 'ninh', 'tv', 'vn']);
    assert.deepEqual(wordsOf('Đồng Tháp TV1'), ['dong', 'thap', 'tv1']);
    assert.deepEqual(wordsOf('VTVcab 1'), ['vtvcab', '1']);
  });
  test('foldText: bỏ dấu, đ → d, bỏ khoảng trắng / dấu câu', () => {
    assert.equal(foldText('Đồng Tháp TV-1'), 'dongthaptv1');
    assert.equal(foldText('AnNinhTV.vn'), 'anninhtvvn');
  });
  test('tên quốc gia tiếng Việt + cờ', () => {
    const [s] = buildList(source, normalizeConfig({ countries: 'VN' }));
    assert.equal(s.country, 'VN');
    assert.equal(s.countryName, 'Việt Nam');
    assert.equal(s.flag, '🇻🇳');
  });
});

describe('options.json (danh mục cho trang Cài đặt)', () => {
  const o = buildOptions({ ...withNews, languages: [{ code: 'tha', name: 'Thai' }], categories: [{ id: 'news', name: 'News' }] });
  test('quốc gia / ngôn ngữ / thể loại có tên tiếng Việt và số link', () => {
    const vnEntry = o.countries.find((c) => c.code === 'VN');
    assert.deepEqual(vnEntry, { code: 'VN', name: 'Việt Nam', flag: '🇻🇳', n: 5 }); // VTV1 ×2 feeds, VTV3, ANTV, Đồng Tháp
    assert.equal(o.languages.find((l) => l.code === 'vie').name, 'Tiếng Việt');
    assert.equal(o.categories.find((c) => c.id === 'news').name, 'Tin tức');
    assert.equal(o.countries.reduce((n, c) => n + c.n, 0) + o.links.filter((r) => r[0] === -1).length, o.links.length);
  });
  test('mỗi link một dòng: quốc gia, ngôn ngữ, thể loại, tên, mã kênh, tên kênh, tên miền', () => {
    const antv = o.links.find((r) => r[4] === 'AnNinhTV.vn');
    assert.equal(o.countries[antv[0]].code, 'VN');
    assert.deepEqual(antv.slice(3), ['ANTV', 'AnNinhTV.vn', 'ANTV', 'liveh12.vtvprime.vn', ['An Ninh Truyền Hình']]);
    assert.deepEqual(antv[2].map((i) => o.categories[i].id), ['news']);
    const unknown = o.links.find((r) => r[3] === 'Unknown');
    assert.equal(unknown[0], -1); // no channel: only in the "no filter" scope
    assert.equal(o.links.length, buildList(withNews, normalizeConfig({})).length);
  });
});

describe('config', () => {
  test('parseLevel đọc được giá trị dropdown', () => {
    assert.equal(parseLevel('3 - Tải được dữ liệu video'), '3');
    assert.equal(parseLevel('4a - Có hình hoặc tiếng'), '4a');
    assert.equal(parseLevel('4B'), '4b');
    assert.equal(parseLevel(''), '3');
    assert.equal(parseLevel('9'), '3');
  });
  test('normalizeConfig: tách dấu phẩy/khoảng trắng, bỏ trùng', () => {
    const c = normalizeConfig({ countries: ' vn,TH  vn ', languages: 'VIE', categories: '' });
    assert.deepEqual(c.countries, ['VN', 'TH']);
    assert.deepEqual(c.languages, ['vie']);
    assert.deepEqual(c.categories, []);
  });
  test('configHash đổi khi đổi bộ lọc hoặc Exclude, không đổi khi đổi mức kiểm tra', () => {
    const a = normalizeConfig({ countries: 'VN', level: '3' });
    const b = normalizeConfig({ countries: 'VN', level: '4a' });
    const c = normalizeConfig({ countries: 'VN, TH' });
    assert.equal(configHash(a, new Set()), configHash(b, new Set()));
    assert.notEqual(configHash(a, new Set()), configHash(c, new Set()));
    assert.notEqual(configHash(a, new Set()), configHash(a, new Set(['https://x'])));
  });
  test('qualityOf / countryOf', () => {
    assert.equal(qualityOf('1080i'), 1080);
    assert.equal(qualityOf(null), 0);
    assert.equal(countryOf('AnGiangTV1.vn'), 'VN');
    assert.equal(countryOf(null), '');
  });
});
