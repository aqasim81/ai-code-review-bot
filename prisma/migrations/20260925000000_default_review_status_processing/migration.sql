-- Reviews are created as PROCESSING; nothing creates PENDING reviews any more.
-- PENDING stays in the enum so older rows still load.
ALTER TABLE "reviews" ALTER COLUMN "status" SET DEFAULT 'PROCESSING';
