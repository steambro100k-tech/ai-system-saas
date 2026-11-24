import { BargainService } from './bargain.service';

describe('BargainService (Asia/Tashkent, UTC+5)', () => {
  let service: BargainService;
  const basePrice = 100_000;

  beforeEach(() => {
    service = new BargainService();
  });

  const isoUtc = (s: string) => s;

  it('Mon 10:00 Tashkent is dead hours (max 15%)', () => {
    // 2026-11-23 is Monday. 10:00 +05 => 05:00Z
    const res = service.evaluate(isoUtc('2026-11-23T05:00:00.000Z'), basePrice);
    expect(res.canDiscount).toBe(true);
    expect(res.maxDiscountPercent).toBe(15);
    expect(res.finalPriceAtMax).toBe(85_000);
    expect(res.bonus).toBe('Free hair wash & styling');
  });

  it('Thu 14:59 Tashkent is dead hours', () => {
    // 2026-11-26 Thu 14:59 +05 => 09:59Z
    const res = service.evaluate(isoUtc('2026-11-26T09:59:00.000Z'), basePrice);
    expect(res.canDiscount).toBe(true);
    expect(res.maxDiscountPercent).toBe(15);
  });

  it('Mon 09:59 Tashkent is outside dead hours (no discount)', () => {
    // 09:59 +05 => 04:59Z
    const res = service.evaluate(isoUtc('2026-11-23T04:59:00.000Z'), basePrice);
    expect(res.canDiscount).toBe(false);
    expect(res.maxDiscountPercent).toBe(0);
    expect(res.finalPriceAtMax).toBe(basePrice);
    expect(res.bonus).toBeNull();
  });

  it('Mon 15:00 Tashkent is not dead hours (boundary, no discount)', () => {
    // 15:00 +05 => 10:00Z
    const res = service.evaluate(isoUtc('2026-11-23T10:00:00.000Z'), basePrice);
    expect(res.canDiscount).toBe(false);
    expect(res.maxDiscountPercent).toBe(0);
  });

  it('Fri 15:59 Tashkent is other time (no discount, no bonus)', () => {
    // 2026-11-27 Fri 15:59 +05 => 10:59Z
    const res = service.evaluate(isoUtc('2026-11-27T10:59:00.000Z'), basePrice);
    expect(res.canDiscount).toBe(false);
    expect(res.maxDiscountPercent).toBe(0);
    expect(res.bonus).toBeNull();
  });

  it('Fri 16:00 Tashkent is prime time (coffee/tea only)', () => {
    // 16:00 +05 => 11:00Z
    const res = service.evaluate(isoUtc('2026-11-27T11:00:00.000Z'), basePrice);
    expect(res.canDiscount).toBe(false);
    expect(res.maxDiscountPercent).toBe(0);
    expect(res.bonus).toBe('Free coffee or tea');
  });

  it('Saturday is prime time', () => {
    // 2026-11-28 Sat 12:00 +05 => 07:00Z
    const res = service.evaluate(isoUtc('2026-11-28T07:00:00.000Z'), basePrice);
    expect(res.canDiscount).toBe(false);
    expect(res.maxDiscountPercent).toBe(0);
    expect(res.bonus).toBe('Free coffee or tea');
  });

  it('Sunday is prime time', () => {
    // 2026-11-29 Sun 12:00 +05 => 07:00Z
    const res = service.evaluate(isoUtc('2026-11-29T07:00:00.000Z'), basePrice);
    expect(res.canDiscount).toBe(false);
    expect(res.maxDiscountPercent).toBe(0);
    expect(res.bonus).toBe('Free coffee or tea');
  });

  it('handles Tashkent midnight offset around UTC boundary', () => {
    // 2026-11-24 Tue 00:30 in Tashkent is 2026-11-23 19:30:00Z (still Mon in UTC)
    const res = service.evaluate(isoUtc('2026-11-23T19:30:00.000Z'), basePrice);
    expect(res.canDiscount).toBe(false);
    expect(res.maxDiscountPercent).toBe(0);
    // ensure it is treated as Tuesday early morning Tashkent, not Monday UTC
    // dead hours only start at 10:00 Tashkent
  });

  it('Tashkent midnight offset: late UTC previous day can be next-day morning Tashkent dead hour boundary context', () => {
    // 2026-11-24 Tue 10:00 in Tashkent = 2026-11-24 05:00:00Z
    const res = service.evaluate(isoUtc('2026-11-24T05:00:00.000Z'), basePrice);
    expect(res.canDiscount).toBe(true);
    expect(res.maxDiscountPercent).toBe(15);
  });

  it('normalizes discount and rejects above max', () => {
    const start = isoUtc('2026-11-23T05:00:00.000Z'); // dead hours
    expect(service.normalizeDiscount(start, basePrice, 10)).toEqual({
      discountPercent: 10,
      finalPrice: 90_000,
      maxDiscountPercent: 15,
    });
    expect(() => service.normalizeDiscount(start, basePrice, 20)).toThrow();
  });

  it('rejects any discount in prime/other time', () => {
    const start = isoUtc('2026-11-27T11:00:00.000Z'); // Fri 16:00 prime
    expect(service.normalizeDiscount(start, basePrice, 0).finalPrice).toBe(100_000);
    expect(() => service.normalizeDiscount(start, basePrice, 5)).toThrow();
  });
});
