// Channel details for the Sheet "Streams" (details.js).

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { addDetails } from '../details.js';

const source = {
  channels: [
    { id: 'VTV1.vn', name: 'VTV1', network: 'VTV', owners: ['Vietnam Television', 'VTV Group'], country: 'VN', website: 'https://vtv.vn/', launched: '1970-09-07', closed: null },
    { id: 'Ten.au', name: '10', network: null, owners: [], country: 'AU', website: null, launched: 'bad date', closed: null },
  ],
  feeds: [
    { channel: 'VTV1.vn', id: 'HD', broadcast_area: ['c/VN'], languages: ['vie', 'eng'], format: '1080i' },
    { channel: 'VTV1.vn', id: 'SD', broadcast_area: ['c/VN'], languages: ['vie'], format: '576i' },
    { channel: 'Ten.au', id: 'SD', broadcast_area: ['s/AU-SA', 'ct/AUSYD', 'ct/AUMEL'], languages: ['eng'], format: '576i' },
  ],
  logos: [
    { channel: 'VTV1.vn', feed: null, in_use: false, format: 'PNG', width: 900, url: 'https://x/old.png' },
    { channel: 'VTV1.vn', feed: null, in_use: true, format: 'SVG', width: 2000, url: 'https://x/vtv1.svg' },
    { channel: 'VTV1.vn', feed: null, in_use: true, format: 'PNG', width: 400, url: 'https://x/vtv1.png' },
    { channel: 'VTV1.vn', feed: 'SD', in_use: true, format: 'JPEG', width: 100, url: 'https://x/vtv1-sd.jpg' },
    { channel: 'Ten.au', feed: 'HD', in_use: true, format: 'PNG', width: 100, url: 'https://x/ten-hd.png' },
  ],
  guides: [
    { channel: 'VTV1.vn', feed: 'SD', site: 'vtv.vn' },
    { channel: 'VTV1.vn', feed: 'SD', site: 'mytv.com.vn' },
    { channel: 'VTV1.vn', feed: 'SD', site: 'vtv.vn' },
    { channel: null, feed: null, site: 'unmapped.example' },
  ],
  regions: [
    { code: 'WW', name: 'Worldwide', countries: ['VN', 'AU'] },
    { code: 'ASEAN', name: 'ASEAN', countries: ['VN'] }, // political: not a "Khu vực"
    { code: 'ASIA', name: 'Asia', countries: ['VN', 'TH', 'CN'] },
    { code: 'SEA', name: 'Southeast Asia', countries: ['VN', 'TH'] },
    { code: 'OCE', name: 'Oceania', countries: ['AU', 'NZ'] },
  ],
  subdivisions: [{ country: 'AU', code: 'AU-SA', name: 'South Australia' }, { country: 'AU', code: 'AU-NSW', name: 'New South Wales' }],
  cities: [{ country: 'AU', subdivision: 'AU-NSW', code: 'AUSYD', name: 'Sydney' }],
  languages: [],
};
const item = (channel, feed, country) => ({ channel, feed, country });
const [hd, sd, ten, none] = addDetails(source, [item('VTV1.vn', 'HD', 'VN'), item('VTV1.vn', 'SD', 'VN'), item('Ten.au', 'SD', 'AU'), item('', '', '')]);

describe('chi tiết kênh cho sheet Streams', () => {
  test('logo: của đúng feed nếu có, không thì của kênh; đang dùng, ảnh Sheets hiện được (không SVG), lớn nhất', () => {
    assert.equal(hd.logo, 'https://x/vtv1.png');
    assert.equal(sd.logo, 'https://x/vtv1-sd.jpg');
    assert.equal(ten.logo, 'https://x/ten-hd.png'); // only another feed's logo: better than none
    assert.equal(none.logo, '');
  });
  test('khu vực: vùng địa lý nhỏ nhất chứa quốc gia (bỏ ASEAN, Toàn cầu…), tên tiếng Việt', () => {
    assert.equal(hd.region, 'Đông Nam Á');
    assert.equal(ten.region, 'Châu Đại Dương');
    assert.equal(none.region, '');
  });
  test('tỉnh/bang, thành phố: từ vùng phát sóng của feed (s/…, ct/…); mã không có trong danh mục bị bỏ qua', () => {
    assert.deepEqual([ten.subdivision, ten.city], ['South Australia, New South Wales', 'Sydney']);
    assert.deepEqual([hd.subdivision, hd.city], ['', '']);
  });
  test('ngôn ngữ, định dạng video, network, chủ sở hữu, website, ngày ra mắt / đóng', () => {
    assert.equal(hd.languageNames, 'Tiếng Việt, Tiếng Anh');
    assert.deepEqual([hd.format, sd.format], ['1080i', '576i']);
    assert.deepEqual([hd.network, hd.owners, hd.website], ['VTV', 'Vietnam Television, VTV Group', 'https://vtv.vn/']);
    assert.deepEqual([hd.launched, hd.closed], ['1970-09-07', '']);
    assert.deepEqual([ten.network, ten.owners, ten.website, ten.launched], ['', '', '', '']); // bad date dropped
  });
  test('lịch phát sóng: các trang có lịch của feed, không thì của kênh; không trùng', () => {
    assert.equal(sd.guide, 'vtv.vn, mytv.com.vn');
    assert.equal(hd.guide, 'vtv.vn, mytv.com.vn'); // no HD guide: the channel's
    assert.equal(ten.guide, '');
  });
  test('thiếu các file phụ (tải lỗi) → cột trống, không lỗi', () => {
    const [x] = addDetails({ channels: source.channels, feeds: source.feeds }, [item('VTV1.vn', 'HD', 'VN')]);
    assert.deepEqual([x.logo, x.region, x.guide, x.format], ['', '', '', '1080i']);
  });
});
