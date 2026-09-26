// Exclude matching, shared by the checker (Node) and the dashboard (browser)
// so the settings preview removes exactly what a run removes. Pure functions,
// no imports.
//
// Each exclude line:
// - a full link ("…://…") removes exactly that link;
// - text removes every link whose name or channel ID has it at the start of a
//   word, ignoring case, accents, spaces and punctuation: "an ninh" / "anninh"
//   match AnNinhTV.vn and "An Ninh TV", "dong thap" matches "Đồng Tháp TV1",
//   "VTV" matches VTV1 but not "Lao SV TV" (words: lao, sv, tv); text ending in
//   a number matches the whole number ("VTV1" keeps VTV10);
// - text with a "." or "/" and no spaces ("vtvprime.vn", "AnNinhTV.vn") is also
//   looked for in the link. Plain text is not: most VN links are on vtvprime.vn,
//   so "VTV" would otherwise remove nearly every channel.
// Text with fewer than MIN_EXCLUDE_TEXT letters/digits is ignored ("TV").

export const MIN_EXCLUDE_TEXT = 3;

export function foldText(value) {
  return String(value ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[đĐ]/g, 'd').toLowerCase().replace(/[^a-z0-9]/g, '');
}

export const isLink = (text) => /^[a-z][a-z0-9+.-]*:\/\//i.test(String(text ?? ''));

// "AnNinhTV.vn" → ["an", "ninh", "tv", "vn"]; "Đồng Tháp TV1" → ["dong", "thap", "tv1"]
export function wordsOf(value) {
  return String(value ?? '').replace(/(\p{Ll})(\p{Lu})/gu, '$1 $2').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[đĐ]/g, 'd').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

// `compact` (folded, no spaces) starts at a word and runs over the next words.
export function startsAtWord(words, compact) {
  for (let i = 0; i < words.length; i++) {
    let joined = '';
    for (let j = i; j < words.length && joined.length < compact.length; j++) joined += words[j];
    // "vtv1" matches VTV1 / VTV1 HD, not VTV10: a number must end where the text ends
    if (joined.startsWith(compact) && !(/\d$/.test(compact) && /\d/.test(joined.charAt(compact.length)))) return true;
  }
  return false;
}

export function makeRule(entry) {
  const text = String(entry ?? '').trim();
  const link = isLink(text);
  const folded = link ? '' : foldText(text);
  const inLink = !link && /[./]/.test(text) && !/\s/.test(text) ? text.toLowerCase() : '';
  return { entry: text, link, folded, inLink, tooShort: !link && folded.length < MIN_EXCLUDE_TEXT };
}

// fields: { url, title, channel, name, altNames }. `words` is an optional cache
// (array) of wordsOf() for the name fields, reused across rules for one link.
export function ruleMatches(rule, fields, words) {
  if (rule.tooShort) return false;
  if (rule.link) return fields.url === rule.entry;
  const w = words || nameWords(fields);
  return w.some((list) => startsAtWord(list, rule.folded))
    || (!!rule.inLink && String(fields.url || '').toLowerCase().includes(rule.inLink));
}

export function nameWords(fields) {
  return [fields.title, fields.channel, fields.name, ...(fields.altNames || [])].map(wordsOf);
}

// The channel shown for a match: channels, not link titles, so an unexpected
// match ("VTV" → ANTV on vtvprime.vn) is visible.
export const matchName = (fields) => fields.name || fields.channel || fields.title || fields.url;

// "2 link: An Ninh TV", "Không khớp kênh nào"… from { tooShort, link, count, names }.
export function reportText(r) {
  if (r.tooShort) return `Chưa dùng: cần ít nhất ${MIN_EXCLUDE_TEXT} chữ hoặc số`;
  if (!r.count) return r.link ? 'Không khớp link nào (link phải giống hệt)' : 'Không khớp kênh nào';
  const shown = r.names.slice(0, 3);
  return `${r.count} link: ${shown.join(', ')}${r.names.length > 3 ? ', …' : ''}`;
}
