import {
  BookingMessageService,
  escapeTelegramHtml,
  formatMoney,
  getTashkentDateParts,
} from './booking-message.service';

describe('BookingMessageService', () => {
  const messages = new BookingMessageService();
  const booking = {
    startTime: new Date('2026-11-25T00:30:00.000Z'),
    finalPrice: 85_000,
    discountPercent: 15,
    clientLang: 'uz' as const,
    service: { nameUz: 'Soch <olish> & parvarish', price: 100_000 },
    barber: { nameUz: 'Bobur & <usta>' },
    bonusText: 'Wash <free> & style',
  };

  it('renders Uzbek confirmation from the Tashkent date with escaped values and savings', () => {
    const text = messages.renderConfirmation(booking, '12 <Main> street');
    expect(text).toContain('✅ Yozilishingiz tasdiqlandi!');
    expect(text).toContain('📅 Chorshanba, 25-noyabr');
    expect(text).toContain('🕒 05:30');
    expect(text).toContain('Soch &lt;olish&gt; &amp; parvarish');
    expect(text).toContain('Usta: Bobur &amp; &lt;usta&gt;');
    expect(text).toContain('85 000 so\'m');
    expect(text).toContain('15 000 so\'m tejadingiz');
    expect(text).toContain('Wash &lt;free&gt; &amp; style');
    expect(text).toContain('📍 12 &lt;Main&gt; street');
    expect(text).not.toContain('2026');
  });

  it('renders Russian without discount or bonus', () => {
    const text = messages.renderConfirmation({
      ...booking,
      clientLang: 'ru',
      finalPrice: 100_000,
      discountPercent: 0,
      bonusText: null,
      service: { nameRu: 'Стрижка', price: 100_000 },
      barber: { nameRu: 'Бобур' },
    }, '');
    expect(text).toContain('✅ Ваша запись подтверждена!');
    expect(text).toContain('📅 Среда, 25-ноября');
    expect(text).toContain('💈 Мастер: Бобур');
    expect(text).toContain('100 000 сум');
    expect(text).not.toContain('Скидка');
    expect(text).not.toContain('Бонус');
    expect(text).not.toContain('📍');
  });

  it('uses Tashkent date parts around midnight UTC and renders today/tomorrow reminders', () => {
    expect(getTashkentDateParts('2026-11-24T19:30:00.000Z')).toMatchObject({
      year: 2026,
      month: 11,
      day: 25,
      hour: 0,
      minute: 30,
    });
    expect(messages.renderReminder(booking, new Date('2026-11-25T00:00:00.000Z')))
      .toContain('Eslatma: bugun soat 05:30 da');
    expect(messages.renderReminder(booking, new Date('2026-11-24T18:59:00.000Z')))
      .toContain('Eslatma: ertaga soat 05:30 da');
  });

  it('escapes Telegram HTML and groups money in thousands', () => {
    expect(escapeTelegramHtml(`<a & "b">`)).toBe('&lt;a &amp; &quot;b&quot;&gt;');
    expect(formatMoney(1_234_567)).toBe("1 234 567 so'm");
  });
});
