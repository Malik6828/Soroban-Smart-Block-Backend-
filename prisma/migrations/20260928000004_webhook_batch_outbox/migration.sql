ALTER TABLE "_webhook_subscriptions"
    ADD COLUMN "delivery_strategy" TEXT NOT NULL DEFAULT 'immediate',
    ADD COLUMN "batch_size" INTEGER NOT NULL DEFAULT 100,
    ADD COLUMN "batch_window_ms" INTEGER NOT NULL DEFAULT 50;

ALTER TABLE "_webhook_deliveries"
    ADD COLUMN "batch_payload" JSONB,
    ADD COLUMN "idempotency_key" TEXT,
    ADD COLUMN "error_code" TEXT;

ALTER TABLE "_webhook_deliveries"
    ADD CONSTRAINT "_webhook_deliveries_error_code_check"
        CHECK ("error_code" IS NULL OR "error_code" IN ('SSRF_BLOCKED', 'HTTP_NON_2XX', 'NETWORK_ERROR', 'PAYLOAD_TOO_LARGE'));

ALTER TABLE "_webhook_subscriptions"
    ADD CONSTRAINT "_webhook_subscriptions_delivery_strategy_check"
        CHECK ("delivery_strategy" IN ('immediate', 'batch')),
    ADD CONSTRAINT "_webhook_subscriptions_batch_size_check"
        CHECK ("batch_size" BETWEEN 2 AND 500),
    ADD CONSTRAINT "_webhook_subscriptions_batch_window_ms_check"
        CHECK ("batch_window_ms" BETWEEN 0 AND 60000);

CREATE TABLE "_webhook_outbox_events" (
    "id" TEXT NOT NULL,
    "subscription_id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "event_payload" JSONB NOT NULL,
    "entity_key" TEXT NOT NULL,
    "ledger_sequence" INTEGER NOT NULL,
    "transaction_hash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "batch_delivery_id" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "_webhook_outbox_events_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "_webhook_outbox_events"
    ADD CONSTRAINT "_webhook_outbox_events_status_check"
        CHECK ("status" IN ('pending', 'batched', 'delivered', 'failed', 'cancelled'));

CREATE UNIQUE INDEX "_webhook_outbox_events_subscription_id_event_id_key"
    ON "_webhook_outbox_events"("subscription_id", "event_id");
CREATE INDEX "_webhook_outbox_events_subscription_id_status_created_at_idx"
    ON "_webhook_outbox_events"("subscription_id", "status", "created_at");
CREATE INDEX "_webhook_outbox_order_idx"
    ON "_webhook_outbox_events"("subscription_id", "entity_key", "status", "ledger_sequence", "transaction_hash", "event_id");
CREATE INDEX "_webhook_outbox_events_batch_delivery_id_idx"
    ON "_webhook_outbox_events"("batch_delivery_id");
CREATE INDEX "_webhook_outbox_events_expires_at_idx"
    ON "_webhook_outbox_events"("expires_at");

ALTER TABLE "_webhook_outbox_events"
    ADD CONSTRAINT "_webhook_outbox_events_subscription_id_fkey"
    FOREIGN KEY ("subscription_id") REFERENCES "_webhook_subscriptions"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "_webhook_outbox_events"
    ADD CONSTRAINT "_webhook_outbox_events_batch_delivery_id_fkey"
    FOREIGN KEY ("batch_delivery_id") REFERENCES "_webhook_deliveries"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;