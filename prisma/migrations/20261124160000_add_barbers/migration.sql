CREATE TABLE "Barber" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "nameRu" TEXT,
    "nameUz" TEXT,
    "telegramId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Barber_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Barber_name_key" ON "Barber"("name");
CREATE UNIQUE INDEX "Barber_telegramId_key" ON "Barber"("telegramId");

INSERT INTO "Barber" ("name", "nameUz", "sortOrder") VALUES
    ('Jasur', 'Jasur', 0),
    ('Bobur', 'Bobur', 1),
    ('Sardor', 'Sardor', 2)
ON CONFLICT ("name") DO NOTHING;

ALTER TABLE "Booking" ADD COLUMN "barberId" INTEGER;

UPDATE "Booking"
SET "barberId" = (SELECT "id" FROM "Barber" ORDER BY "sortOrder", "id" LIMIT 1)
WHERE "barberId" IS NULL;

ALTER TABLE "Booking"
ADD CONSTRAINT "Booking_barberId_fkey"
FOREIGN KEY ("barberId") REFERENCES "Barber"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "Booking_barberId_startTime_endTime_idx"
ON "Booking"("barberId", "startTime", "endTime");
