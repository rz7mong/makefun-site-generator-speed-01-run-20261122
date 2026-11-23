// site-generator-speed: a faster drop-in for makefun-site 1.0.0.
// Byte-identical output, written from the reference's README and code.
// Same pipeline, same order, same strings — only the hot paths are faster:
// - inline Markdown: run-based scanning, no per-character regex escape
// - block lexer: one classification pass per line with char checks, no regexes
// - front matter: manual parsing, no regexes
// - slugify: pure-ASCII fast path (NFKD is identity on ASCII)
// - wordsOf: manual run counter, no regex match array
// - templates: render into one parts array, no intermediate strings
// - CRLF normalisation skipped when the text holds no \r
// - tag slugs computed once per name

// ---------------------------------------------------------------- text

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** `text` with & < > " and ' escaped. One pass, no allocation when clean. */
export function escapeHtml(text) {
  let out = '';
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    let rep = null;
    if (c === 38) rep = '&amp;';
    else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    if (rep !== null) {
      if (out === '') out = text.slice(0, i);
      else out += text.slice(start, i);
      out += rep;
      start = i + 1;
    }
  }
  if (out === '') return text;
  return out + text.slice(start);
}

/** The most characters a slug keeps before a collision suffix. */
export const SLUG_MAX = 64;

/** The slug of `text`, for the non-ASCII case (the reference's own path). */
function slugifyUnicode(text) {
  const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run of
 * characters other than a-z and 0-9 one "-", none at either end, at most 64
 * characters (a "-" left at the cut dropped), and "untitled" when nothing is left.
 * Pure ASCII takes the fast path: NFKD is identity on ASCII and ASCII holds no
 * combining marks, so the two paths agree exactly.
 */
export function slugify(text) {
  let out = '';
  let gap = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c > 127) return slugifyUnicode(text);
    let keep = -1;
    if (c >= 65 && c <= 90) keep = c + 32;
    else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
    if (keep === -1) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += String.fromCharCode(keep);
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against `taken` (and added to it): the first of slug, slug-2, slug-3 ... not taken. */
export function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone: "2026-11-09" is "9 November 2026". */
export function longDate(date) {
  const [y, m, d] = date.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

/** Whether char code `c` is a JavaScript \s whitespace character. */
function isSpaceCode(c) {
  return c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || c === 32 || c === 160 || c === 5760 ||
    (c >= 8192 && c <= 8202) || c === 8232 || c === 8233 || c === 8239 || c === 8287 || c === 12288 || c === 65279;
}

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    // The ASCII whitespace codes are exactly 9, 10, 11, 12, 13 and 32; anything else ASCII is a word character.
    const ws = c < 128
      ? c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || c === 32
      : isSpaceCode(c);
    if (ws) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

/** Whether `line` is blank: spaces and tabs only. */
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** `line` with spaces and tabs dropped at both ends. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** `s` with trailing spaces and tabs dropped. */
function rstrip(s) {
  let b = s.length;
  while (b > 0 && (s.charCodeAt(b - 1) === 32 || s.charCodeAt(b - 1) === 9)) b--;
  return b === s.length ? s : s.slice(0, b);
}

// ---------------------------------------------------------------- front matter

/** The keys a source's front matter may give. */
const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare, the rest of the line (never opening on " or [). */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** Whether `s` is exactly YYYY-MM-DD with a real day from 1970-01-01 to 2099-12-31. */
function isDate(s) {
  if (s.length !== 10 || s.charCodeAt(4) !== 45 || s.charCodeAt(7) !== 45) return false;
  for (let i = 0; i < 10; i++) {
    if (i === 4 || i === 7) continue;
    const c = s.charCodeAt(i);
    if (c < 48 || c > 57) return false;
  }
  const y = Number(s.slice(0, 4));
  const mo = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  return !(y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo));
}

/** Whether `s` is a template name: a-z, 0-9 and `-`, at least one character. */
function isName(s) {
  if (s.length === 0) return false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return false;
  }
  return true;
}

/** Whether `s` is a slug: a-z and 0-9, single `-` between, at most 64 characters. */
function isSlug(s) {
  if (s.length === 0 || s.length > 64) return false;
  let prevDash = true; // a leading dash is not allowed
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 45) {
      if (prevDash) return false;
      prevDash = true;
    } else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) prevDash = false;
    else return false;
  }
  return !prevDash; // a trailing dash is not allowed
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date':
      return isDate(raw) ? { value: raw } : { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (const t of tags) {
        if (t === '' || t.indexOf('"') !== -1 || t.indexOf('[') !== -1 || t.indexOf(']') !== -1) {
          return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        }
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return isName(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return isSlug(raw) ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first reason it is refused. `text` has "\n"
 * line ends.
 */
function parseFrontMatter(text) {
  const lines = text.split('\n');
  if (lines[0] !== '---') return { error: 'no front matter' };
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      close = i;
      break;
    }
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (isBlank(line) || line.charCodeAt(0) === 35) continue;
    // LINE: ([a-z_]+):(?: (.*))?$
    let j = 0;
    while (j < line.length) {
      const c = line.charCodeAt(j);
      if ((c >= 97 && c <= 122) || c === 95) j++;
      else break;
    }
    if (j === 0 || j >= line.length || line.charCodeAt(j) !== 58) return { error: `line ${i + 1} is not "key: value"` };
    const key = line.slice(0, j);
    let raw;
    if (j + 1 === line.length) raw = '';
    else if (line.charCodeAt(j + 1) === 32) raw = line.slice(j + 2);
    else return { error: `line ${i + 1} is not "key: value"` };
    raw = rstrip(raw);
    if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: lines.slice(close + 1).join('\n') };
}

// ---------------------------------------------------------------- markdown

// Line kinds, one per source line, computed once per body.
const K_OTHER = 0;
const K_BLANK = 1;
const K_FENCE = 2;
const K_HEADING = 3;
const K_HR = 4;
const K_QUOTE = 5;
const K_BULLET = 6;
const K_ORDERED = 7;
const K_CONT = 8;

/** A fence line's language, or null: three backticks, a language of [A-Za-z0-9_+-]*, then spaces or tabs only. */
function fenceLangOf(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) i++;
    else break;
  }
  const lang = line.slice(3, i);
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return null;
    i++;
  }
  return lang;
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let n = 0;
  while (n < line.length && line.charCodeAt(n) === 35) n++;
  if (n === 0 || n > 6) return null;
  if (n >= line.length) return null;
  if (line.charCodeAt(n) !== 32 && line.charCodeAt(n) !== 9) return null;
  let start = n;
  while (start < line.length && (line.charCodeAt(start) === 32 || line.charCodeAt(start) === 9)) start++;
  let end = line.length;
  while (end > start && (line.charCodeAt(end - 1) === 32 || line.charCodeAt(end - 1) === 9)) end--;
  if (start >= end) return null;
  return { depth: n, text: line.slice(start, end) };
}

/** Whether `line` is a thematic break: `---` or `***`, then spaces or tabs only. */
function isHR(line) {
  const c0 = line.charCodeAt(0);
  if (c0 !== 45 && c0 !== 42) return false;
  if (line.charCodeAt(1) !== c0 || line.charCodeAt(2) !== c0) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** An ordered-list line's number and content, or null: 1-9 digits, `. `, then text. */
function orderedOf(line) {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) >= 48 && line.charCodeAt(i) <= 57) i++;
  if (i === 0 || i > 9) return null;
  if (line.charCodeAt(i) !== 46 || line.charCodeAt(i + 1) !== 32) return null;
  return { num: Number(line.slice(0, i)), content: line.slice(i + 2) };
}

/** Whether `line` continues a list item: two or more spaces, then a non-space. */
function isContinued(line) {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) === 32) i++;
  if (i < 2 || i >= line.length) return false;
  return !isSpaceCode(line.charCodeAt(i));
}

/** `src`'s block tokens, in order. */
function lex(src) {
  const lines = src.split('\n');
  const n = lines.length;
  const kind = new Uint8Array(n);
  const data = new Array(n);
  for (let i = 0; i < n; i++) {
    const line = lines[i];
    const c0 = line.charCodeAt(0);
    if (line.length === 0 || c0 === 32 || c0 === 9) {
      if (isBlank(line)) kind[i] = K_BLANK;
      else if (isContinued(line)) kind[i] = K_CONT;
      else kind[i] = K_OTHER;
      continue;
    }
    if (c0 === 96) {
      const lang = fenceLangOf(line);
      if (lang !== null) {
        kind[i] = K_FENCE;
        data[i] = lang;
      } else kind[i] = K_OTHER;
      continue;
    }
    if (c0 === 35) {
      const h = headingOf(line);
      if (h !== null) {
        kind[i] = K_HEADING;
        data[i] = h;
      } else kind[i] = K_OTHER;
      continue;
    }
    if (c0 === 45 || c0 === 42) {
      if (isHR(line)) {
        kind[i] = K_HR;
        continue;
      }
      if (line.charCodeAt(1) === 32) {
        kind[i] = K_BULLET;
        data[i] = line.slice(2);
        continue;
      }
      kind[i] = K_OTHER;
      continue;
    }
    if (c0 === 62) {
      kind[i] = K_QUOTE;
      continue;
    }
    if (c0 >= 48 && c0 <= 57) {
      const o = orderedOf(line);
      if (o !== null) {
        kind[i] = K_ORDERED;
        data[i] = o;
        continue;
      }
      kind[i] = K_OTHER;
      continue;
    }
    kind[i] = K_OTHER;
  }
  const tokens = [];
  let i = 0;
  while (i < n) {
    const k = kind[i];
    if (k === K_BLANK) {
      i++;
      continue;
    }
    if (k === K_FENCE) {
      const lang = data[i];
      const body = [];
      i++;
      while (i < n && !(kind[i] === K_FENCE && data[i] === '')) body.push(lines[i++]);
      i++;
      tokens.push({ type: 'code', lang, lines: body });
      continue;
    }
    if (k === K_HEADING) {
      const h = data[i];
      tokens.push({ type: 'heading', depth: h.depth, text: h.text });
      i++;
      continue;
    }
    if (k === K_HR) {
      tokens.push({ type: 'hr' });
      i++;
      continue;
    }
    if (k === K_QUOTE) {
      const body = [];
      while (i < n && kind[i] === K_QUOTE) {
        const l = lines[i++];
        body.push(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1));
      }
      tokens.push({ type: 'blockquote', lines: body.map(trimLine).filter((l) => l !== '') });
      continue;
    }
    if (k === K_BULLET || k === K_ORDERED) {
      const isOrdered = k === K_ORDERED;
      const start = isOrdered ? data[i].num : 1;
      const items = [];
      while (i < n) {
        const kk = kind[i];
        if (kk === k) {
          items.push([trimLine(isOrdered ? data[i].content : data[i])]);
          i++;
        } else if (kk === K_CONT) {
          items[items.length - 1].push(trimLine(lines[i]));
          i++;
        } else break;
      }
      tokens.push({ type: 'list', ordered: isOrdered, start, items: items.map((parts) => parts.join('\n')) });
      continue;
    }
    const body = [trimLine(lines[i])];
    i++;
    while (i < n && kind[i] !== K_BLANK && kind[i] !== K_FENCE && kind[i] !== K_HEADING && kind[i] !== K_HR) {
      body.push(trimLine(lines[i++]));
    }
    tokens.push({ type: 'paragraph', text: body.join('\n') });
  }
  return tokens;
}

/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/**
 * `s` rendered inline; `env.link(target)` is a link's href. Plain runs of text
 * are copied whole: only the characters that open a construct or need escaping
 * break the run, and a construct that finds no closer stays in the run as text.
 */
function inline(s, env) {
  // A string with no mark or HTML-special character renders as itself.
  if (!/[\\`*\[&<>"']/.test(s)) return s;
  const parts = [];
  let i = 0;
  let run = 0;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c === 92) {
      // backslash: an escapable character after it is written (escaped); any other backslash is itself.
      if (i + 1 < s.length && ESCAPABLE.has(s[i + 1])) {
        if (i > run) parts.push(s.slice(run, i));
        parts.push(s[i + 1] === '>' ? '&gt;' : s[i + 1]);
        i += 2;
        run = i;
      } else {
        i++;
      }
      continue;
    }
    if (c === 96) {
      // backtick: a code span closed by the next backtick, with at least one character between.
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        if (i > run) parts.push(s.slice(run, i));
        parts.push('<code>' + escapeHtml(s.slice(i + 1, j)) + '</code>');
        i = j + 1;
        run = i;
      } else {
        i++;
      }
      continue;
    }
    if (c === 42) {
      if (s[i + 1] === '*') {
        const j = findUnescaped(s, '**', i + 2);
        if (j > i + 2) {
          if (i > run) parts.push(s.slice(run, i));
          parts.push('<strong>' + inline(s.slice(i + 2, j), env) + '</strong>');
          i = j + 2;
          run = i;
        } else {
          i += 2;
        }
        continue;
      }
      const j = findSingleStar(s, i + 1);
      if (j > i + 1) {
        if (i > run) parts.push(s.slice(run, i));
        parts.push('<em>' + inline(s.slice(i + 1, j), env) + '</em>');
        i = j + 1;
        run = i;
      } else {
        i++;
      }
      continue;
    }
    if (c === 91) {
      const k = findUnescaped(s, ']', i + 1);
      const m = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = m === -1 ? '' : s.slice(k + 2, m);
      if (target !== '' && !/\s/.test(target)) {
        if (i > run) parts.push(s.slice(run, i));
        parts.push('<a href="' + escapeHtml(env.link(target)) + '">' + inline(s.slice(i + 1, k), env) + '</a>');
        i = m + 1;
        run = i;
        continue;
      }
      i++;
      continue;
    }
    if (c === 38 || c === 60 || c === 62 || c === 34 || c === 39) {
      if (i > run) parts.push(s.slice(run, i));
      parts.push(c === 38 ? '&amp;' : c === 60 ? '&lt;' : c === 62 ? '&gt;' : c === 34 ? '&quot;' : '&#39;');
      i++;
      run = i;
      continue;
    }
    i++;
  }
  if (s.length > run) parts.push(s.slice(run));
  return parts.join('');
}

/**
 * `src` rendered: its HTML (each block on its own lines, a "\n" after the last), its table of contents (every level 2
 * and 3 heading: level, id and its inline HTML) and its excerpt (the first paragraph's inline HTML, or "").
 */
function renderMarkdown(src, env) {
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  for (const t of lex(src)) {
    switch (t.type) {
      case 'heading': {
        const id = uniqueSlug(slugify(t.text), ids);
        const html = inline(t.text, env);
        blocks.push(`<h${t.depth} id="${id}">${html}</h${t.depth}>`);
        if (t.depth === 2 || t.depth === 3) toc.push({ level: t.depth, id, html });
        break;
      }
      case 'code': {
        const cls = t.lang === '' ? '' : ` class="language-${escapeHtml(t.lang)}"`;
        const code = [];
        for (const l of t.lines) code.push(escapeHtml(l));
        blocks.push(`<pre><code${cls}>${code.join('\n')}${t.lines.length === 0 ? '' : '\n'}</code></pre>`);
        break;
      }
      case 'hr':
        blocks.push('<hr>');
        break;
      case 'blockquote':
        blocks.push(t.lines.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inline(t.lines.join('\n'), env)}</p>\n</blockquote>`);
        break;
      case 'list': {
        const tag = t.ordered ? 'ol' : 'ul';
        const open = t.ordered && t.start !== 1 ? `<ol start="${t.start}">` : `<${tag}>`;
        const inner = [];
        for (const item of t.items) inner.push(`<li>${inline(item, env)}</li>`);
        blocks.push(`${open}\n${inner.join('\n')}${inner.length === 0 ? '' : '\n'}</${tag}>`);
        break;
      }
      case 'paragraph': {
        const html = inline(t.text, env);
        if (excerpt === null) excerpt = html;
        blocks.push(`<p>${html}</p>`);
        break;
      }
    }
  }
  return { html: blocks.length === 0 ? '' : blocks.join('\n') + '\n', toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF = /^if (not )?(\S+)$/;
const INCLUDE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/**
 * The names a template's render reads from outside itself: the root names of every path it (and the templates it
 * includes) reads, except names a for inside it binds (its loop variable and `loop`). A template's rendered output
 * depends only on those names' values, the include depth, and the templates — so two renders of one template with
 * the same values at the same depth render the same string. A name already on the include chain is not walked again.
 */
function externalDeps(nodes, templates) {
  const out = new Set();
  const walk = (ns, bound, chain) => {
    for (const n of ns) {
      if (n.kind === 'var' || n.kind === 'raw') {
        if (!bound.has(n.path[0])) out.add(n.path[0]);
      } else if (n.kind === 'if') {
        if (!bound.has(n.path[0])) out.add(n.path[0]);
        walk(n.then, bound, chain);
        if (n.else !== null) walk(n.else, bound, chain);
      } else if (n.kind === 'for') {
        if (!bound.has(n.path[0])) out.add(n.path[0]);
        const b2 = new Set(bound);
        b2.add(n.name);
        b2.add('loop');
        walk(n.body, b2, chain);
      } else if (n.kind === 'include') {
        const t = templates.get(n.name);
        if (t !== undefined && !chain.includes(n.name)) walk(t, bound, [...chain, n.name]);
      }
    }
  };
  walk(nodes, new Set(), []);
  return [...out].sort();
}

/** A template's external names, computed once per build and cached on `ctx`. */
function depNames(ctx, name) {
  let deps = ctx.depCache.get(name);
  if (deps === undefined) {
    deps = externalDeps(ctx.templates.get(name), ctx.templates);
    ctx.depCache.set(name, deps);
  }
  return deps;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * `nodes` rendered in `scope` ({ vars, parent }) into `out` (an array of string
 * parts). `ctx` holds the parsed templates (`templates`, a Map of name to nodes,
 * a template that did not parse absent), the HTML escape and the include depth.
 */
function renderNodes(nodes, scope, ctx, depth, out) {
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        out.push(n.text);
        break;
      case 'var':
        out.push(escapeHtml(textOf(lookup(scope, n.path))));
        break;
      case 'raw':
        out.push(textOf(lookup(scope, n.path)));
        break;
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderNodes(branch, scope, ctx, depth, out);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        // One scope for the whole loop: rendering is synchronous, so the loop variable and `loop` can be updated
        // in place per element instead of building a scope per element.
        const vars = { [n.name]: undefined, loop: { index: 0, first: false, last: false, length: xs.length } };
        const child = { vars, parent: scope };
        const loop = vars.loop;
        for (let k = 0; k < xs.length; k++) {
          vars[n.name] = xs[k];
          loop.index = k + 1;
          loop.first = k === 0;
          loop.last = k === xs.length - 1;
          renderNodes(n.body, child, ctx, depth, out);
        }
        break;
      }
      case 'include': {
        const t = ctx.templates.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) {
          const deps = depNames(ctx, n.name);
          const d = depth + 1;
          if (deps.length === 0) {
            // The template reads nothing from outside: one render per depth serves every include of it.
            const key = `${n.name} ${d}`;
            let s = ctx.memoText.get(key);
            if (s === undefined) {
              const parts = [];
              renderNodes(t, scope, ctx, d, parts);
              s = parts.join('');
              ctx.memoText.set(key, s);
            }
            out.push(s);
          } else {
            // The template's output is a function of its external names' values: look them up, and cache the
            // render under them (all must be objects, to key the cache by identity) and the depth.
            const values = new Array(deps.length);
            let ok = true;
            for (let i = 0; i < deps.length; i++) {
              const v = lookup(scope, [deps[i]]);
              if (v === null || typeof v !== 'object') {
                ok = false;
                break;
              }
              values[i] = v;
            }
            if (!ok) {
              renderNodes(t, scope, ctx, d, out);
            } else {
              let node = ctx.memo.get(n.name);
              if (node === undefined) {
                node = new WeakMap();
                ctx.memo.set(n.name, node);
              }
              for (let i = 0; i < values.length - 1; i++) {
                let next = node.get(values[i]);
                if (next === undefined) {
                  next = new WeakMap();
                  node.set(values[i], next);
                }
                node = next;
              }
              let leaf = node.get(values[values.length - 1]);
              if (leaf === undefined) {
                leaf = new Map();
                node.set(values[values.length - 1], leaf);
              }
              let s = leaf.get(d);
              if (s === undefined) {
                const start = out.length;
                renderNodes(t, scope, ctx, d, out);
                s = out.slice(start).join('');
                out.length = start;
                out.push(s);
                leaf.set(d, s);
              } else {
                out.push(s);
              }
            }
          }
        }
        break;
      }
    }
  }
}

/**
 * A template's nodes rendered into `out`: its compiled function when one was built, else the tree walk. A template
 * that fails to compile renders through the tree walk, so a codegen fault costs speed, never the answer.
 */
function renderTemplate(name, scope, ctx, depth, out) {
  const fn = compileTemplate(name, ctx);
  if (fn !== null) fn(scope, ctx, depth, out, lookup, textOf, truthy, escapeHtml, renderInclude);
  else renderNodes(ctx.templates.get(name), scope, ctx, depth, out);
}

/** One include, with the same memoization as the tree walk: the render is cached under its external names' values. */
function renderInclude(name, scope, ctx, depth, out) {
  const t = ctx.templates.get(name);
  if (t === undefined || depth >= INCLUDE_DEPTH) return;
  const deps = depNames(ctx, name);
  const d = depth + 1;
  if (deps.length === 0) {
    // The template reads nothing from outside: one render per depth serves every include of it.
    const key = `${name} ${d}`;
    let s = ctx.memoText.get(key);
    if (s === undefined) {
      const parts = [];
      renderTemplate(name, scope, ctx, d, parts);
      s = parts.join('');
      ctx.memoText.set(key, s);
    }
    out.push(s);
    return;
  }
  const values = new Array(deps.length);
  let ok = true;
  for (let i = 0; i < deps.length; i++) {
    const v = lookup(scope, [deps[i]]);
    if (v === null || typeof v !== 'object') {
      ok = false;
      break;
    }
    values[i] = v;
  }
  if (!ok) {
    renderTemplate(name, scope, ctx, d, out);
    return;
  }
  let node = ctx.memo.get(name);
  if (node === undefined) {
    node = new WeakMap();
    ctx.memo.set(name, node);
  }
  for (let i = 0; i < values.length - 1; i++) {
    let next = node.get(values[i]);
    if (next === undefined) {
      next = new WeakMap();
      node.set(values[i], next);
    }
    node = next;
  }
  let leaf = node.get(values[values.length - 1]);
  if (leaf === undefined) {
    leaf = new Map();
    node.set(values[values.length - 1], leaf);
  }
  let s = leaf.get(d);
  if (s === undefined) {
    const start = out.length;
    renderTemplate(name, scope, ctx, d, out);
    s = out.slice(start).join('');
    out.length = start;
    out.push(s);
    leaf.set(d, s);
  } else {
    out.push(s);
  }
}

/** The source lines rendering `nodes` in the scope held by `scopeVar`, appended to `lines`. */
function genNodes(nodes, scopeVar, lines) {
  for (const n of nodes) {
    if (n.kind === 'text') {
      lines.push(`out.push(${JSON.stringify(n.text)});`);
    } else if (n.kind === 'var') {
      lines.push(`out.push(escapeHtml(textOf(lookup(${scopeVar}, ${JSON.stringify(n.path)}))));`);
    } else if (n.kind === 'raw') {
      lines.push(`out.push(textOf(lookup(${scopeVar}, ${JSON.stringify(n.path)})));`);
    } else if (n.kind === 'if') {
      lines.push(`if (truthy(lookup(${scopeVar}, ${JSON.stringify(n.path)})) !== ${n.not}) {`);
      genNodes(n.then, scopeVar, lines);
      if (n.else !== null) {
        lines.push('} else {');
        genNodes(n.else, scopeVar, lines);
      }
      lines.push('}');
    } else if (n.kind === 'for') {
      lines.push('{');
      lines.push(`const xs = lookup(${scopeVar}, ${JSON.stringify(n.path)});`);
      lines.push('if (Array.isArray(xs)) {');
      lines.push(`const vars = { ${n.name}: undefined, loop: { index: 0, first: false, last: false, length: xs.length } };`);
      lines.push(`const child = { vars: vars, parent: ${scopeVar} };`);
      lines.push('const loop = vars.loop;');
      lines.push('for (let k = 0; k < xs.length; k++) {');
      lines.push(`vars.${n.name} = xs[k];`);
      lines.push('loop.index = k + 1;');
      lines.push('loop.first = k === 0;');
      lines.push('loop.last = k === xs.length - 1;');
      genNodes(n.body, 'child', lines);
      lines.push('}');
      lines.push('}');
      lines.push('}');
    } else if (n.kind === 'include') {
      lines.push(`renderInclude(${JSON.stringify(n.name)}, ${scopeVar}, ctx, depth, out);`);
    }
  }
}

/** A template compiled to a function, cached per build; null when it fails to compile (the tree walk is used then). */
function compileTemplate(name, ctx) {
  let fn = ctx.compiled.get(name);
  if (fn === undefined) {
    fn = null;
    const nodes = ctx.templates.get(name);
    if (nodes !== undefined) {
      try {
        const lines = [];
        genNodes(nodes, 'scope', lines);
        fn = new Function('scope', 'ctx', 'depth', 'out', 'lookup', 'textOf', 'truthy', 'escapeHtml', 'renderInclude', lines.join('\n'));
      } catch {
        fn = null;
      }
    }
    ctx.compiled.set(name, fn);
  }
  return fn;
}

// ---------------------------------------------------------------- the build

/** The report file every build writes. */
const REPORT_FILE = 'build-report.txt';

/** The top-level directories the generator writes itself, which no page's slug at the root may take. */
const RESERVED = ['posts', 'tags', 'page'];

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** 1. The sources, in code-unit order of their paths, line ends made "\n"; a source that is not .md is static. */
function readSources(b) {
  const files = [...b.input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const text = f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n');
      b.sources.push({ path: f.path, text });
    } else b.statics.push({ path: f.path, content: f.content });
  }
}

/** 2. Each source's front matter: a refused source is reported and dropped, and so is a draft. */
function frontMatter(b) {
  const kept = [];
  for (const s of b.sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      b.report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) {
      b.report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      b.report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!b.templates.has(layout)) {
      b.report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      b.report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  b.sources = kept;
}

/** 3. Each page's output directory and url: its slug made unique in its directory, in source order. */
function permalinks(b) {
  const taken = new Map();
  const takenIn = (dir) => {
    if (!taken.has(dir)) taken.set(dir, new Set(dir === '' ? RESERVED : []));
    return taken.get(dir);
  };
  for (const s of b.sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${b.base}/${s.outDir}/`;
    b.bySource.set(s.path, s);
  }
}

/** 4. Each body's Markdown, its links resolved to the pages and static files they name. */
function markdown(b) {
  const staticPaths = new Set(b.statics.map((f) => f.path));
  for (const s of b.sources) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && b.bySource.has(path)) return `${b.bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${b.base}/${path}${frag}`;
        b.broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }
}

/** 5. The posts, newest first and then by slug; each post's newer and older neighbours. */
function collections(b) {
  const posts = b.sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  b.posts = posts;
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });
}

/** 6. The tags: grouped by their slug, each named as first met in the posts' order, ordered by count and then slug. */
function tags(b) {
  const bySlug = new Map();
  /** A source's tags, each slug once, in its own order (each slug computed once). */
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of (s.data.tags ?? [])) {
      const slug = slugify(name);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push({ name, slug });
      }
    }
    return out;
  };
  for (const p of b.posts) {
    p.tagRefs = [];
    for (const { name, slug } of ownTags(p)) {
      if (!bySlug.has(slug)) bySlug.set(slug, { name, slug, url: `${b.base}/tags/${slug}/`, posts: [] });
      const tag = bySlug.get(slug);
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  // A page's tags link to the posts' tag of the same slug, and to nothing (url "") where no post has it.
  for (const s of b.sources) {
    if (!s.post) s.tagRefs = ownTags(s).map(({ name, slug }) => bySlug.get(slug) ?? { name, slug, url: '', posts: [] });
  }
  b.tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));
}

/** A page's link record as templates read it. */
const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });

/** A tag as templates read it (its posts as cards). */
const tagOf = (b, t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => b.cards.get(p)) });

/** A post's card, as lists show it. */
function cardOf(s) {
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };
}

/** A page as its layout reads it. `card` is the page's card (a post's is reused from the cards map). */
function pageOf(s, card) {
  return {
    ...card,
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  };
}

/** 7. Every page through its layout, the index pages and the tag pages through theirs. */
function layouts(b) {
  b.cards = new Map(b.posts.map((p) => [p, cardOf(p)]));
  const site = { title: b.input.site.title, base_url: b.base };
  const allTags = b.tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = b.posts.slice(0, b.input.site.recent).map((p) => b.cards.get(p));
  const ctx = { templates: b.templates, memo: new Map(), memoText: new Map(), depCache: new Map(), compiled: new Map() };
  const render = (name, vars) => {
    const nodes = b.templates.get(name);
    if (nodes === undefined) return null;
    const parts = [];
    renderTemplate(name, { vars: { site, tags: allTags, recent, ...vars }, parent: null }, ctx, 0, parts);
    return parts.join('');
  };
  for (const s of b.sources) b.output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s, s.post ? b.cards.get(s) : cardOf(s)) });
  const per = b.input.site.per_page;
  const pages = Math.max(1, Math.ceil(b.posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${b.base}/` : `${b.base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: b.posts.slice((k - 1) * per, k * per).map((p) => b.cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) b.output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of b.tags) {
    const html = render('tag', { tag: tagOf(b, t) });
    if (html !== null) b.output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) b.output['tags/index.html'] = tagsHtml;
  for (const f of b.statics) {
    if (Object.hasOwn(b.output, f.path)) b.report.push(`shadowed ${f.path}: a built page has its path`);
    else b.output[f.path] = f.content;
  }
}

/** 8. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts. */
function report(b) {
  const lines = [...b.report, ...b.broken].sort(byCodeUnits);
  const pages = b.sources.filter((s) => !s.post).length;
  lines.push(`built ${pages} pages, ${b.posts.length} posts, ${b.tags.length} tags and ${b.statics.length} static files`);
  b.output[REPORT_FILE] = `${lines.join('\n')}\n`;
}

/** One site's output tree: path -> text. */
function build(input) {
  const templates = new Map();
  const reportLines = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      reportLines.push(err.message);
    }
  }
  const b = {
    input,
    base: input.site.base_url.replace(/\/+$/, ''),
    templates,
    sources: [],
    statics: [],
    bySource: new Map(),
    broken: new Set(),
    report: reportLines,
    posts: [],
    tags: [],
    cards: new Map(),
    output: {},
  };
  readSources(b);
  frontMatter(b);
  permalinks(b);
  markdown(b);
  collections(b);
  tags(b);
  layouts(b);
  report(b);
  return b.output;
}

/** makefun-site 1.0.0's answer for one case's input — faster. */
export function run(input) {
  return build(input);
}
