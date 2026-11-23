ALTER TABLE "reports" ADD COLUMN "attachment_key" text;--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "attachment_name" text;--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "attachment_size" integer;--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "attachment_content_type" text;--> statement-breakpoint
CREATE UNIQUE INDEX "reports_attachment_key_key" ON "reports" ("attachment_key");--> statement-breakpoint
ALTER TABLE "reports" DROP CONSTRAINT "reports_attachment_type_valid", ADD CONSTRAINT "reports_attachment_type_valid" CHECK ("attachment_type" IS NULL OR "attachment_type" IN ('url', 'file'));--> statement-breakpoint
ALTER TABLE "reports" DROP CONSTRAINT "reports_attachment_shape", ADD CONSTRAINT "reports_attachment_shape" CHECK ((
        ("attachment_type" IS NULL AND "attachment_url" IS NULL AND "attachment_key" IS NULL)
        OR ("attachment_type" = 'url' AND "attachment_url" IS NOT NULL AND "attachment_key" IS NULL)
        OR ("attachment_type" = 'file' AND "attachment_url" IS NULL AND "attachment_key" IS NOT NULL
            AND "attachment_name" IS NOT NULL AND "attachment_size" IS NOT NULL
            AND "attachment_content_type" IS NOT NULL)
      ));