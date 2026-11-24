export const SAVDO_RULES = Object.freeze({
  timezone: 'Asia/Tashkent',
  utcOffsetHours: 5,
  maxDeadHoursDiscountPercent: 15,
  deadHours: Object.freeze({
    days: [1, 2, 3, 4] as const,
    startMinute: 10 * 60,
    endMinuteExclusive: 15 * 60,
    bonus: 'Free hair wash & styling',
  }),
  primeTime: Object.freeze({
    fridayStartMinute: 16 * 60,
    bonus: 'Free coffee or tea',
  }),
});
