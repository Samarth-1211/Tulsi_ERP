/**
 * Script-independent phonetic search key, so an English (Latin) query finds Hindi (Devanagari)
 * data and vice versa: "Ramesh" ≈ "रमेश", "Sharma" ≈ "शर्मा", "plywood" ≈ "प्लाईवुड".
 *
 * Devanagari is romanised first, then both scripts go through the same lossy normalisation
 * (aspirates → plain, retroflex = dental, vowels folded to i/u, short "a" dropped). The stored
 * key is " word1 word2" (leading space) so `contains(' ' + queryKey)` is a word-prefix match.
 * The frontend has a copy in `src/utils/phonetic.ts` — keep both in sync.
 */

const VOWELS: Record<string, string> = {
  'अ': 'a', 'आ': 'aa', 'इ': 'i', 'ई': 'ii', 'उ': 'u', 'ऊ': 'uu', 'ऋ': 'ri',
  'ए': 'e', 'ऐ': 'ai', 'ओ': 'o', 'औ': 'au', 'ऑ': 'o', 'ऍ': 'e',
};
const MATRAS: Record<string, string> = {
  'ा': 'aa', 'ि': 'i', 'ी': 'ii', 'ु': 'u', 'ू': 'uu', 'ृ': 'ri',
  'े': 'e', 'ै': 'ai', 'ो': 'o', 'ौ': 'au', 'ॉ': 'o', 'ॅ': 'e',
};
const CONSONANTS: Record<string, string> = {
  'क': 'k', 'ख': 'kh', 'ग': 'g', 'घ': 'gh', 'ङ': 'n',
  'च': 'ch', 'छ': 'chh', 'ज': 'j', 'झ': 'jh', 'ञ': 'n',
  'ट': 't', 'ठ': 'th', 'ड': 'd', 'ढ': 'dh', 'ण': 'n',
  'त': 't', 'थ': 'th', 'द': 'd', 'ध': 'dh', 'न': 'n',
  'प': 'p', 'फ': 'f', 'ब': 'b', 'भ': 'bh', 'म': 'm',
  'य': 'y', 'र': 'r', 'ल': 'l', 'ळ': 'l', 'व': 'v',
  'श': 'sh', 'ष': 'sh', 'स': 's', 'ह': 'h',
  'क़': 'k', 'ख़': 'kh', 'ग़': 'g', 'ज़': 'z', 'ड़': 'd', 'ढ़': 'dh', 'फ़': 'f', 'य़': 'y',
};
const NUKTA = '़';
const HALANT = '्';
const SIGNS: Record<string, string> = { 'ं': 'n', 'ँ': 'n', 'ः': 'h', 'ॐ': 'om', '।': ' ', '॥': ' ' };

/** Devanagari → loose Latin (inherent "a" kept unless a matra or halant follows). */
export function romanize(text: string): string {
  const chars = Array.from(text.normalize('NFC'));
  let out = '';
  for (let i = 0; i < chars.length; i++) {
    let ch = chars[i];
    if (chars[i + 1] === NUKTA && CONSONANTS[ch + NUKTA]) ch += chars[++i];
    const cons = CONSONANTS[ch];
    if (cons !== undefined) {
      out += cons;
      while (chars[i + 1] === NUKTA) i++;
      const next = chars[i + 1];
      if (next !== undefined && MATRAS[next] !== undefined) { out += MATRAS[next]; i++; }
      else if (next === HALANT) i++;
      else out += 'a';
      continue;
    }
    if (VOWELS[ch] !== undefined) out += VOWELS[ch];
    else if (MATRAS[ch] !== undefined) out += MATRAS[ch];
    else if (SIGNS[ch] !== undefined) out += SIGNS[ch];
    else if (ch >= '०' && ch <= '९') out += String(ch.charCodeAt(0) - 0x0966);
    else if (ch === NUKTA || ch === HALANT || ch === 'ऽ') continue;
    else out += ch;
  }
  return out;
}

function wordKey(w: string): string {
  let s = w
    .replace(/ch/g, '\u0001') // protect "ch" before the c rules
    .replace(/ck/g, 'k')
    .replace(/c(?=[eiy])/g, 's')
    .replace(/c/g, 'k')
    .replace(/\u0001/g, 'c')
    .replace(/ph/g, 'f')
    .replace(/([bcdfgjklmnpqrstvwxyz])h/g, '$1') // aspirates: kh→k, sh→s, th→t, bh→b…
    .replace(/x/g, 'ks')
    .replace(/q/g, 'k')
    .replace(/w/g, 'v')
    .replace(/z/g, 'j')
    .replace(/[eiy]/g, 'i') // ee, ii, ai, e, y → i
    .replace(/[ou]/g, 'u') //  oo, uu, au, o → u
    .replace(/ai|ia/g, 'i')
    .replace(/au|ua/g, 'u')
    .replace(/m(?=[bp])/g, 'n') // anusvara: मुंबई = "mumbai"
    .replace(/ng/g, 'n')
    .replace(/(.)\1+/g, '$1');
  s = s[0] + s.slice(1).replace(/a/g, ''); // drop short "a" (schwa) except a leading one
  s = s.replace(/(.)\1+/g, '$1');
  const trimmed = s.replace(/[iu]+$/, ''); // trailing vowel: "Indore" = "इंदौर", "Tulsi" = "तुलसी"
  return trimmed || s;
}

/** " key1 key2" for the given texts (null/empty parts skipped); '' when nothing is left. */
export function phoneticKey(...parts: Array<string | null | undefined>): string {
  const words = romanize(parts.filter(Boolean).join(' '))
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map(wordKey);
  return words.length ? ' ' + words.join(' ') : '';
}

/**
 * Prisma `where` fragment matching the phonetic key of a search term at a word start,
 * or null when the term is too short to be useful.
 */
export function searchKeyFilter(search: string | undefined | null): { searchKey: { contains: string } } | null {
  const term = search?.trim();
  if (!term || term.length < 2) return null;
  const key = phoneticKey(term);
  return key ? { searchKey: { contains: key } } : null;
}
