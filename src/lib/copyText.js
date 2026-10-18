// Text helpers shared by the copy library (reference selection) and the AI Copy Assistant (claim guard, reference masking). Pure functions, no I/O.
//
// WNDRR's copy often writes product names in decorative "mathematical bold" lettering (𝐇𝐢𝐣𝐚𝐜𝐤 𝐂𝐚𝐫𝐠𝐨 𝐒𝐡𝐨𝐫𝐭, 𝟑 𝐅𝐎𝐑 $𝟏𝟓𝟎). To a person that is plain text; to a program it is
// a different set of characters, so nothing would match. NFKC normalisation maps those letters and digits back to ordinary ones.

// Decorative lettering -> plain text; also drops zero-width characters. Does not change case.
function normalizeUnicode(s) {
  return String(s == null ? '' : s).normalize('NFKC').replace(/[​-‍﻿]/g, '');
}

// Lower-case, decorative lettering resolved, punctuation turned into spaces, whitespace collapsed.
function plain(s) {
  return normalizeUnicode(s).toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9$%'\s-]/g, ' ').replace(/['-]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Whole-word comparison: "tees" and "tee" are the same word, "boxy" and "box" are not, "fits" is "fit".
function singular(w) {
  if (w.length <= 3) return w;
  if (/(ss|us|is)$/.test(w)) return w;
  if (/ies$/.test(w)) return `${w.slice(0, -3)}y`;
  if (/(ches|shes|xes)$/.test(w)) return w.slice(0, -2);
  if (/s$/.test(w)) return w.slice(0, -1);
  return w;
}

function wordList(s) {
  return plain(s).split(' ').filter(Boolean).map(singular);
}

const STOPWORDS = new Set('a an the and or of to in on for with at by from is are was be it its this that you your we our us as but if so not no can will just all more than then them they their have has had do does did i me my new now get'.split(' '));

// Distinct content words (stop-words and one-letter words removed).
function contentWords(s) {
  return [...new Set(wordList(s).filter((w) => w.length > 1 && !STOPWORDS.has(w)))];
}

// Jaccard similarity of two texts' content words (0..1). Used to avoid choosing near-identical references.
function similarity(a, b) {
  const A = new Set(contentWords(a)); const B = new Set(contentWords(b));
  if (!A.size || !B.size) return 0;
  let inter = 0; A.forEach((w) => { if (B.has(w)) inter += 1; });
  return inter / (A.size + B.size - inter);
}

// Does `phrase` (several words, in order) occur as whole words inside `text`?
function hasPhrase(text, phrase) {
  const t = ` ${wordList(text).join(' ')} `;
  const p = wordList(phrase).join(' ');
  return !!p && t.includes(` ${p} `);
}

function hasWord(text, word) {
  return hasPhrase(text, word);
}

module.exports = { normalizeUnicode, plain, singular, wordList, contentWords, similarity, hasPhrase, hasWord, STOPWORDS };
