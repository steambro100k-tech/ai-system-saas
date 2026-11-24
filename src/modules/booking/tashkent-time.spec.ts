import { parseIsoToDate } from './tashkent-time';

describe('parseIsoToDate', () => {
  it('preserves an explicit Asia/Tashkent offset', () => {
    expect(parseIsoToDate('2026-11-25T13:00:00+05:00').toISOString()).toBe(
      '2026-11-25T08:00:00.000Z',
    );
  });

  it('accepts a UTC offset', () => {
    expect(parseIsoToDate('2026-11-25T08:00:00Z').toISOString()).toBe(
      '2026-11-25T08:00:00.000Z',
    );
  });

  it('treats a datetime without an offset as Asia/Tashkent', () => {
    expect(parseIsoToDate('2026-11-25T13:00:00').toISOString()).toBe(
      '2026-11-25T08:00:00.000Z',
    );
  });

  it('rejects invalid input with an actionable message', () => {
    expect(() => parseIsoToDate('tomorrow at 13:00')).toThrow(
      'Invalid datetime. Use ISO 8601 with Z/+05:00',
    );
  });
});
