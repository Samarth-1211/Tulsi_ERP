import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { phoneticKey, romanize, searchKeyFilter } from '../../src/common/utils/phonetic-key.util';

describe('phoneticKey', () => {
  const pairs: Array<[string, string]> = [
    ['Ramesh', 'रमेश'], ['Sharma', 'शर्मा'], ['Kumar', 'कुमार'], ['Gupta', 'गुप्ता'], ['Singh', 'सिंह'],
    ['Plywood', 'प्लाईवुड'], ['Tulsi', 'तुलसी'], ['Mumbai', 'मुंबई'], ['Indore', 'इंदौर'], ['Laxmi', 'लक्ष्मी'],
    ['Krishna', 'कृष्ण'], ['Akash', 'आकाश'], ['Cement', 'सीमेंट'], ['Chandan', 'चंदन'], ['Delhi', 'दिल्ली'],
    ['Pooja', 'पूजा'], ['Agarwal', 'अग्रवाल'], ['Greenply', 'ग्रीनप्लाई'], ['Ram Kumar', 'राम कुमार'],
  ];
  for (const [en, hi] of pairs) {
    it(`${en} ≈ ${hi}`, () => assert.equal(phoneticKey(en), phoneticKey(hi)));
  }

  it('is case-insensitive and ignores punctuation', () => {
    assert.equal(phoneticKey('RAMESH  kumar!'), phoneticKey('ramesh-kumar'));
  });

  it('joins parts and skips empty ones', () => {
    assert.equal(phoneticKey('Green', null, undefined, 'Ply'), phoneticKey('Green Ply'));
    assert.equal(phoneticKey(null, ''), '');
  });

  it('romanizes digits and halant clusters', () => {
    assert.equal(romanize('१८'), '18');
    assert.equal(romanize('क्ष'), 'ksha');
  });
});

describe('searchKeyFilter', () => {
  it('matches a word prefix: "ram" finds "राम कुमार" and "रमेश"', () => {
    const f = searchKeyFilter('ram')!;
    assert.ok(phoneticKey('राम कुमार').includes(f.searchKey.contains));
    assert.ok(phoneticKey('रमेश').includes(f.searchKey.contains));
    assert.ok(!phoneticKey('श्रीराम').includes(f.searchKey.contains));
  });

  it('works Hindi → English too', () => {
    const f = searchKeyFilter('शर्मा')!;
    assert.ok(phoneticKey('Anil Sharma').includes(f.searchKey.contains));
  });

  it('ignores terms shorter than 2 characters', () => {
    assert.equal(searchKeyFilter('r'), null);
    assert.equal(searchKeyFilter('  '), null);
    assert.equal(searchKeyFilter(undefined), null);
  });
});
