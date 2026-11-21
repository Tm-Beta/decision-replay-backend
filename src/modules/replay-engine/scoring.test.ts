import { describe, it, expect } from 'vitest';
import {
  parseMetric,
  evaluateAssumption,
  assumptionMatchRate,
  predictionAccuracy,
  calibrationDelta,
  brierTerm,
  brierScore,
  calibrationScore,
  estimationScore,
  estimationScoreFromText,
} from './scoring';

describe('parseMetric', () => {
  it('parses operators, units and currency', () => {
    expect(parseMetric('< 2 weeks')).toEqual({ comparator: '<', value: 14, unit: 'days' });
    expect(parseMetric('$5k')).toEqual({ comparator: '=', value: 5000, unit: 'currency' });
    expect(parseMetric('1,200 users')).toEqual({ comparator: '=', value: 1200, unit: 'users' });
  });
  it('does not treat "km" as thousands', () => {
    expect(parseMetric('5 km')).toEqual({ comparator: '=', value: 5, unit: 'km' });
  });
  it('returns null for free text', () => {
    expect(parseMetric('it went fine')).toBeNull();
    expect(parseMetric('')).toBeNull();
  });
});

describe('evaluateAssumption', () => {
  it('handles time targets', () => {
    expect(evaluateAssumption('< 2 weeks', '10 days')).toBe(true);
    expect(evaluateAssumption('< 2 weeks', '3 weeks')).toBe(false);
  });
  it('handles targets without an operator (+/-10%)', () => {
    expect(evaluateAssumption('$500', '$520')).toBe(true);
    expect(evaluateAssumption('$500', '$600')).toBe(false);
  });
  it('returns null when not comparable', () => {
    expect(evaluateAssumption('< 2 weeks', '$5')).toBeNull();
    expect(evaluateAssumption('< 2 weeks', 'about right')).toBeNull();
  });
});

describe('prediction accuracy (2.2)', () => {
  it('matches rate', () => {
    expect(assumptionMatchRate([{ validated: true }, { validated: false }])).toBe(0.5);
    expect(assumptionMatchRate([{ validated: true }, { validated: null }])).toBe(0.5);
    expect(assumptionMatchRate([])).toBeNull();
  });
  it('0.5*80 + 0.5*50 = 65', () => {
    expect(predictionAccuracy(80, 0.5)).toBe(65);
  });
  it('falls back to outcome score with no assumptions', () => {
    expect(predictionAccuracy(70, null)).toBe(70);
  });
});

describe('calibration (2.1)', () => {
  it('delta and Brier term for confidence 90, outcome 40', () => {
    expect(calibrationDelta(90, 40)).toBe(50);
    expect(brierTerm(90, 40)).toBeCloseTo(0.25, 10);
  });
  it('mean Brier of (80 vs 100) and (60 vs 0) = (0.04 + 0.36) / 2 = 0.2', () => {
    const b = brierScore([
      { confidence: 80, outcomeScore: 100 },
      { confidence: 60, outcomeScore: 0 },
    ]);
    expect(b).toBeCloseTo(0.2, 10);
    expect(calibrationScore(b!)).toBeCloseTo(80, 10);
  });
  it('empty list gives null', () => {
    expect(brierScore([])).toBeNull();
  });
});

describe('estimation (2.3)', () => {
  it('10 vs 15 -> 50, 10 vs 30 -> 0 (floored), target 0 -> null', () => {
    expect(estimationScore(10, 15)).toBe(50);
    expect(estimationScore(10, 30)).toBe(0);
    expect(estimationScore(0, 5)).toBeNull();
  });
  it('2 weeks target, 3 weeks actual -> 50', () => {
    expect(estimationScoreFromText('2 weeks', '3 weeks')).toBeCloseTo(50, 10);
  });
});
