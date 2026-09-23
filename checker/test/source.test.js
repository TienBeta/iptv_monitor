// Filtering, dedupe and "one URL per channel+feed" selection.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildList, configHash, countryOf, normalizeConfig, parseLevel, qualityOf } from '../source.js';

const source = {
  channels: [
    { id: 'VTV1.vn', country: 'VN', categories: ['general', 'news'], is_nsfw: false, closed: null },
    { id: 'VTV3.vn', country: 'VN', categories: ['entertainment'], is_nsfw: false, closed: null },
    { id: 'OldTV.vn', country: 'VN', categories: ['general'], is_nsfw: false, closed: '2020-01-01' },
    { id: 'Adult.vn', country: 'VN', categories: ['xxx'], is_nsfw: true, closed: null },
    { id: 'ThaiPBS.th', country: 'TH', categories: ['news'], is_nsfw: false, closed: null },
    { id: 'BBCOne.uk', country: 'UK', categories: ['general'], is_nsfw: false, closed: null },
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
  test('danh sách Exclude bị bỏ qua; URL tốt kế tiếp được chọn', () => {
    const list = buildList(source, normalizeConfig({ countries: 'VN' }), new Set(['https://a/vtv1-1080.m3u8']));
    assert.equal(list[0].url, 'https://a/vtv1-1080b.m3u8');
  });
  test('tên quốc gia tiếng Việt + cờ', () => {
    const [s] = buildList(source, normalizeConfig({ countries: 'VN' }));
    assert.equal(s.country, 'VN');
    assert.equal(s.countryName, 'Việt Nam');
    assert.equal(s.flag, '🇻🇳');
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
