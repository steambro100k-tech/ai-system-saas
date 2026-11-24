import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { PrismaClient } from '../generated/prisma/client';
import { getAppEnv } from '../src/common/config/env';

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set');
  }
  const isProduction = process.env.NODE_ENV === 'production';
  const pool = new Pool({
    connectionString,
    ssl: isProduction ? { rejectUnauthorized: false } : false,
  });
  const adapter = new PrismaPg(pool);
  const prisma = new PrismaClient({ adapter });

  try {
    const services = [
      {
        nameRu: 'Мужская стрижка',
        nameUz: 'Erkaklar soch turmagi',
        price: 100000,
        durationMin: 30,
      },
      {
        nameRu: 'Стрижка + борода',
        nameUz: 'Soch turmagi + soqol',
        price: 150000,
        durationMin: 60,
      },
      {
        nameRu: 'Детская стрижка',
        nameUz: 'Bolalar soch turmagi',
        price: 80000,
        durationMin: 30,
      },
      {
        nameRu: 'Мытьё и укладка',
        nameUz: 'Yuvish va turmaklash',
        price: 50000,
        durationMin: 30,
      },
    ];

    for (const s of services) {
      const existing = await prisma.service.findFirst({
        where: { nameUz: s.nameUz },
      });
      if (existing) {
        await prisma.service.update({
          where: { id: existing.id },
          data: {
            nameRu: s.nameRu,
            nameUz: s.nameUz,
            price: s.price,
            durationMin: s.durationMin,
          },
        });
      } else {
        await prisma.service.create({ data: s });
      }
    }

    const firstBarberTelegramId = getAppEnv().BARBER_TELEGRAM_IDS[0];
    const barbers = [
      { name: 'Jasur', nameUz: 'Jasur', sortOrder: 0 },
      { name: 'Bobur', nameUz: 'Bobur', sortOrder: 1 },
      { name: 'Sardor', nameUz: 'Sardor', sortOrder: 2 },
    ];
    if (firstBarberTelegramId) {
      await prisma.barber.updateMany({
        where: { telegramId: firstBarberTelegramId, name: { not: 'Jasur' } },
        data: { telegramId: null },
      });
    }
    for (const [index, barber] of barbers.entries()) {
      await prisma.barber.upsert({
        where: { name: barber.name },
        create: {
          ...barber,
          telegramId: index === 0 ? firstBarberTelegramId ?? null : null,
        },
        update: {
          ...barber,
          ...(index === 0 && firstBarberTelegramId
            ? { telegramId: firstBarberTelegramId }
            : {}),
        },
      });
    }

    const seeded = await prisma.service.findMany({ orderBy: { id: 'asc' } });
    console.log(`Seeded/updated ${seeded.length} services and ${barbers.length} barbers`);
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

main().catch(() => {
  console.error('Demo service seed failed');
  process.exit(1);
});
