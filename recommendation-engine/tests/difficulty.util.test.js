const { resolveDifficultyForAccuracy } = require('../src/utils/difficulty.util');

describe('resolveDifficultyForAccuracy', () => {
  test('accuracy below 40 -> EASY', () => {
    expect(resolveDifficultyForAccuracy(0)).toBe('EASY');
    expect(resolveDifficultyForAccuracy(10)).toBe('EASY');
    expect(resolveDifficultyForAccuracy(39.99)).toBe('EASY');
  });

  test('accuracy 40-75 inclusive -> MEDIUM', () => {
    expect(resolveDifficultyForAccuracy(40)).toBe('MEDIUM');
    expect(resolveDifficultyForAccuracy(60)).toBe('MEDIUM');
    expect(resolveDifficultyForAccuracy(75)).toBe('MEDIUM');
  });

  test('accuracy above 75 -> MEDIUM (defensive default)', () => {
    expect(resolveDifficultyForAccuracy(90)).toBe('MEDIUM');
  });

  test('null/NaN -> MEDIUM (no-signal default)', () => {
    expect(resolveDifficultyForAccuracy(null)).toBe('MEDIUM');
    expect(resolveDifficultyForAccuracy(NaN)).toBe('MEDIUM');
    expect(resolveDifficultyForAccuracy(undefined)).toBe('MEDIUM');
  });
});
