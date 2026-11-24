import { createHmac, timingSafeEqual } from 'crypto';

export type TelegramInitUser = {
  id: number;
  [key: string]: unknown;
};

export type ValidatedInitData = {
  authDate: number;
  user: TelegramInitUser;
  rawUser: string;
  data: Record<string, string>;
};

export type ValidateInitDataOptions = {
  botToken: string;
  initData: string;
  allowedTelegramIds: string[];
  nowSeconds?: number;
  maxAgeSeconds?: number;
};

function safeEqualHex(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, 'hex');
  const bBuf = Buffer.from(b, 'hex');
  if (aBuf.length !== bBuf.length || aBuf.length === 0) return false;
  return timingSafeEqual(aBuf, bBuf);
}

export function validateTelegramInitData(
  options: ValidateInitDataOptions,
): { ok: true; value: ValidatedInitData } | { ok: false; reason: string } {
  const { botToken, initData, allowedTelegramIds } = options;
  const maxAgeSeconds = options.maxAgeSeconds ?? 60 * 60 * 24;
  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);

  if (!botToken || !initData) {
    return { ok: false, reason: 'missing_init_data_or_token' };
  }

  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  const authDateStr = params.get('auth_date');
  const userStr = params.get('user');

  if (!hash || !authDateStr || !userStr) {
    return { ok: false, reason: 'missing_required_fields' };
  }

  const authDate = Number(authDateStr);
  if (!Number.isInteger(authDate)) {
    return { ok: false, reason: 'invalid_auth_date' };
  }

  if (nowSeconds - authDate > maxAgeSeconds) {
    return { ok: false, reason: 'expired_auth_date' };
  }
  if (authDate > nowSeconds + 60) {
    return { ok: false, reason: 'future_auth_date' };
  }

  const pairs: string[] = [];
  params.forEach((value, key) => {
    if (key === 'hash') return;
    pairs.push(`${key}=${value}`);
  });
  pairs.sort();
  const dataCheckString = pairs.join('\n');

  const secretKey = createHmac('sha256', 'WebAppData')
    .update(botToken)
    .digest();
  const computedHash = createHmac('sha256', secretKey)
    .update(dataCheckString)
    .digest('hex');

  if (!safeEqualHex(computedHash, hash)) {
    return { ok: false, reason: 'invalid_hash' };
  }

  let user: TelegramInitUser;
  try {
    user = JSON.parse(userStr) as TelegramInitUser;
  } catch {
    return { ok: false, reason: 'invalid_user_json' };
  }

  if (!user || typeof user.id !== 'number') {
    return { ok: false, reason: 'invalid_user_id' };
  }

  const allowed = allowedTelegramIds
    .map((id) => String(id).trim())
    .filter(Boolean);
  if (!allowed.includes(String(user.id))) {
    return { ok: false, reason: 'forbidden_user' };
  }

  const data: Record<string, string> = {};
  params.forEach((value, key) => {
    data[key] = value;
  });

  return {
    ok: true,
    value: { authDate, user, rawUser: userStr, data },
  };
}
