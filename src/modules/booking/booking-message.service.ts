import { Injectable } from '@nestjs/common';
import { formatTashkentDate } from './tashkent-time';

const UZ_WEEKDAYS = ['yakshanba', 'dushanba', 'seshanba', 'chorshanba', 'payshanba', 'juma', 'shanba'];
const RU_WEEKDAYS = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
const UZ_MONTHS = ['yanvar', 'fevral', 'mart', 'aprel', 'may', 'iyun', 'iyul', 'avgust', 'sentabr', 'oktabr', 'noyabr', 'dekabr'];
const RU_MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

export type BookingMessageData = {
  startTime: Date | string;
  finalPrice: number;
  discountPercent: number;
  clientLang?: 'uz' | 'ru' | null;
  service?: { nameUz?: string | null; nameRu?: string | null; price?: number | null } | null;
  barber?: { name?: string | null; nameUz?: string | null; nameRu?: string | null } | null;
  bonusText?: string | null;
};

export function escapeTelegramHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function formatMoney(value: number, lang: 'uz' | 'ru' = 'uz'): string {
  const formatted = Math.round(value).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return lang === 'ru' ? `${formatted} сум` : `${formatted} so'm`;
}

export function getTashkentDateParts(value: Date | string) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid booking datetime');
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Tashkent',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? '';
  const weekdayIndex = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(part('weekday'));
  return {
    year: Number(part('year')),
    month: Number(part('month')),
    day: Number(part('day')),
    hour: Number(part('hour')),
    minute: Number(part('minute')),
    weekdayIndex,
  };
}

function serviceName(booking: BookingMessageData, lang: 'uz' | 'ru'): string {
  return String((lang === 'ru' ? booking.service?.nameRu : booking.service?.nameUz) || booking.service?.nameUz || booking.service?.nameRu || '');
}

function barberName(booking: BookingMessageData, lang: 'uz' | 'ru'): string {
  return String((lang === 'ru' ? booking.barber?.nameRu : booking.barber?.nameUz) || booking.barber?.nameUz || booking.barber?.name || '');
}

function formatDateAndTime(value: Date | string, lang: 'uz' | 'ru') {
  const parts = getTashkentDateParts(value);
  const weekday = (lang === 'ru' ? RU_WEEKDAYS : UZ_WEEKDAYS)[parts.weekdayIndex];
  const month = (lang === 'ru' ? RU_MONTHS : UZ_MONTHS)[parts.month - 1];
  const weekdayName = weekday.charAt(0).toLocaleUpperCase() + weekday.slice(1);
  return {
    date: `${weekdayName}, ${parts.day}-${month}`,
    time: `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`,
    dateKey: formatTashkentDate(value instanceof Date ? value : new Date(value)),
  };
}

@Injectable()
export class BookingMessageService {
  renderConfirmation(booking: BookingMessageData, shopAddress = ''): string {
    const lang = booking.clientLang === 'ru' ? 'ru' : 'uz';
    const { date, time } = formatDateAndTime(booking.startTime, lang);
    const service = escapeTelegramHtml(serviceName(booking, lang));
    const barber = escapeTelegramHtml(barberName(booking, lang));
    const address = shopAddress ? `\n📍 ${escapeTelegramHtml(shopAddress)}` : '';
    const serviceLine = lang === 'ru' ? `✂️ ${service}` : `✂️ ${service}`;
    const barberLine = lang === 'ru' ? `💈 Мастер: ${barber}` : `💈 Usta: ${barber}`;
    const moneyLine = lang === 'ru' ? `💰 ${formatMoney(booking.finalPrice, lang)}` : `💰 ${formatMoney(booking.finalPrice, lang)}`;
    const lines = lang === 'ru'
      ? ['✅ Ваша запись подтверждена!', '', `📅 ${escapeTelegramHtml(date)}`, `🕒 ${time}`, serviceLine, barberLine, '', moneyLine]
      : ['✅ Yozilishingiz tasdiqlandi!', '', `📅 ${escapeTelegramHtml(date)}`, `🕒 ${time}`, serviceLine, barberLine, '', moneyLine];
    if (booking.discountPercent > 0) {
      const saved = Math.max(0, (booking.service?.price ?? booking.finalPrice) - booking.finalPrice);
      lines.push(lang === 'ru'
        ? `🏷 Скидка ${booking.discountPercent}%: вы сэкономили ${formatMoney(saved, lang)}`
        : `🏷 ${booking.discountPercent}% chegirma: ${formatMoney(saved)} tejadingiz`);
    }
    if (booking.bonusText) lines.push(`🎁 ${lang === 'ru' ? 'Бонус' : 'Bonus'}: ${escapeTelegramHtml(booking.bonusText)}`);
    if (address) lines.push(address.trimStart());
    lines.push('', lang === 'ru'
      ? 'Будем ждать! Напишите сюда, чтобы изменить или отменить запись.'
      : "Sizni kutamiz! Vaqtni o'zgartirish yoki bekor qilish uchun shu yerga yozing.");
    return lines.join('\n');
  }

  renderReminder(booking: BookingMessageData, now = new Date()): string {
    const lang = booking.clientLang === 'ru' ? 'ru' : 'uz';
    const parts = formatDateAndTime(booking.startTime, lang);
    const todayKey = formatTashkentDate(now);
    const currentOrdinal = Date.parse(`${todayKey}T00:00:00Z`);
    const bookingOrdinal = Date.parse(`${parts.dateKey}T00:00:00Z`);
    const dayDistance = Math.round((bookingOrdinal - currentOrdinal) / 86_400_000);
    let when: string;
    if (lang === 'ru') {
      when = dayDistance === 0 ? 'сегодня' : dayDistance === 1 ? 'завтра' : parts.date;
    } else {
      when = dayDistance === 0 ? 'bugun' : dayDistance === 1 ? 'ertaga' : parts.date;
    }
    const service = escapeTelegramHtml(serviceName(booking, lang));
    const barber = escapeTelegramHtml(barberName(booking, lang));
    const lines = lang === 'ru'
      ? [`⏰ Напоминание: ${escapeTelegramHtml(when)} в ${parts.time}`, '', `✂️ ${service}`, `💈 Мастер: ${barber}`, `💰 ${formatMoney(booking.finalPrice, lang)}`, '', 'Вы придёте?']
      : [`⏰ Eslatma: ${escapeTelegramHtml(when)} soat ${parts.time} da`, '', `✂️ ${service}`, `💈 Usta: ${barber}`, `💰 ${formatMoney(booking.finalPrice)}`, '', 'Kelasizmi?'];
    return lines.join('\n');
  }

  renderReminderCancelQuestion(lang: 'uz' | 'ru'): string {
    return lang === 'ru' ? 'Вы действительно хотите отменить запись?' : 'Rostdan ham bekor qilasizmi?';
  }
}
