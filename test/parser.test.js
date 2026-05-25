'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  extractCodesFromText,
  hashString,
  normalizeText
} = require('../extension/shared/parser');

test('extractCodesFromText extracts stakecom Code lines', () => {
  assert.deepEqual(
    extractCodesFromText('Bonus Drop Alert\n- Code: stakecomD6nrMahwmZGN\n- Value: $1'),
    [
      {
        code: 'stakecomD6nrMahwmZGN',
        rawLine: '- Code: stakecomD6nrMahwmZGN'
      }
    ]
  );
});

test('extractCodesFromText ignores non-stakecom Code lines', () => {
  assert.deepEqual(extractCodesFromText('Code: hello12345'), []);
});

test('extractCodesFromText deduplicates code matches per text block', () => {
  const text = 'Code: stakecomSame123\nCode: stakecomSame123';
  assert.equal(extractCodesFromText(text).length, 1);
});

test('normalizeText trims whitespace and non-breaking spaces', () => {
  assert.equal(normalizeText('  Code:\u00a0stakecomA123  \n\nValue: $1  '), 'Code: stakecomA123\nValue: $1');
});

test('hashString is deterministic', () => {
  assert.equal(hashString('abc'), hashString('abc'));
  assert.notEqual(hashString('abc'), hashString('abcd'));
});
