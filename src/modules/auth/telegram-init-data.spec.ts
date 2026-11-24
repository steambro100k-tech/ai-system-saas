import { createHmac } from 'crypto';
import { validateTelegramInitData } from './telegram-init-data';

function buildInitData(params: Record<string, string>, botToken: string, overrideHash?: string) {
  const entries = Object.entries(params);
  const dataCheckString = [...entries]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  const sp = new URLSearchParams(params);
  sp.set('hash', overrideHash ?? hash);
  return sp.toString();
}

describe('validateTelegramInitData', () => {
  const botToken = '123456:TEST_BOT_TOKEN';
  const barberId = '7888427770';
  const nowSeconds = 1_700_000_000;

  const baseParams = () => ({
    auth_date: String(nowSeconds - 60),
    query_id: 'AAHdF6IQAAAAAN0XohDhrOrc',
    user: JSON.stringify({ id: 7888427770, first_name: 'Barber' }),
  });

  it('accepts valid initData for allowed barber id', () => {
    const initData = buildInitData(baseParams(), botToken);
    const res = validateTelegramInitData({
      botToken,
      initData,
      allowedTelegramIds: [barberId],
      nowSeconds,
      maxAgeSeconds: 3600,
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.user.id).toBe(7888427770);
    }
  });

  it('rejects tampered hash', () => {
    const initData = buildInitData(baseParams(), botToken, 'deadbeef'.repeat(8));
    const res = validateTelegramInitData({
      botToken,
      initData,
      allowedTelegramIds: [barberId],
      nowSeconds,
      maxAgeSeconds: 3600,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('invalid_hash');
  });

  it('rejects tampered payload with original hash', () => {
    const params = baseParams();
    const initData = buildInitData(params, botToken);
    const tampered = initData.replace('Barber', 'Hacker');
    const res = validateTelegramInitData({
      botToken,
      initData: tampered,
      allowedTelegramIds: [barberId],
      nowSeconds,
      maxAgeSeconds: 3600,
    });
    expect(res.ok).toBe(false);
  });

  it('rejects expired auth_date', () => {
    const params = { ...baseParams(), auth_date: String(nowSeconds - 10_000) };
    const initData = buildInitData(params, botToken);
    const res = validateTelegramInitData({
      botToken,
      initData,
      allowedTelegramIds: [barberId],
      nowSeconds,
      maxAgeSeconds: 3600,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('expired_auth_date');
  });

  it('rejects non-barber id even with valid hash', () => {
    const params = {
      ...baseParams(),
      user: JSON.stringify({ id: 111111111, first_name: 'Other' }),
    };
    const initData = buildInitData(params, botToken);
    const res = validateTelegramInitData({
      botToken,
      initData,
      allowedTelegramIds: [barberId],
      nowSeconds,
      maxAgeSeconds: 3600,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('forbidden_user');
  });
});
