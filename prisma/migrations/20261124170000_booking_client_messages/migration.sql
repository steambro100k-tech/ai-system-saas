CREATE TYPE "ClientLanguage" AS ENUM ('uz', 'ru');

ALTER TABLE "Booking"
ADD COLUMN "clientLang" "ClientLanguage",
ADD COLUMN "reminderSentAt" TIMESTAMP(3),
ADD COLUMN "clientConfirmedAt" TIMESTAMP(3);

CREATE INDEX "Booking_status_startTime_idx" ON "Booking"("status", "startTime");
