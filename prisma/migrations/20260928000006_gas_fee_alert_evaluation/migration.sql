ALTER TABLE "_gas_analytics_snapshots"
    ADD COLUMN "fee_sum_stroops" VARCHAR(78) NOT NULL DEFAULT '0';

CREATE TABLE "_gas_fee_alert_events" (
    "id" TEXT NOT NULL,
    "event_key" VARCHAR(256) NOT NULL,
    "rule_id" VARCHAR(128) NOT NULL,
    "developer_id" VARCHAR(128) NOT NULL,
    "network" VARCHAR(16) NOT NULL,
    "direction" VARCHAR(8) NOT NULL,
    "threshold_stroops" VARCHAR(78) NOT NULL,
    "previous_fee_stroops" VARCHAR(78) NOT NULL,
    "current_fee_stroops" VARCHAR(78) NOT NULL,
    "trend" VARCHAR(8) NOT NULL,
    "bucket_start" TIMESTAMP(3) NOT NULL,
    "bucket_end" TIMESTAMP(3) NOT NULL,
    "dispatched_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "_gas_fee_alert_events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "_gas_fee_alert_events_network_check"
        CHECK ("network" IN ('mainnet', 'testnet', 'devnet')),
    CONSTRAINT "_gas_fee_alert_events_direction_check"
        CHECK ("direction" IN ('high', 'low')),
    CONSTRAINT "_gas_fee_alert_events_trend_check"
        CHECK ("trend" IN ('rising', 'falling', 'flat')),
    CONSTRAINT "_gas_fee_alert_events_event_key_check"
        CHECK (length("event_key") > 0)
);

CREATE UNIQUE INDEX "_gas_fee_alert_events_event_key_key"
    ON "_gas_fee_alert_events"("event_key");
CREATE INDEX "_gas_fee_alert_events_created_at_idx"
    ON "_gas_fee_alert_events"("created_at");
CREATE INDEX "_gas_fee_alert_events_rule_id_bucket_start_idx"
    ON "_gas_fee_alert_events"("rule_id", "bucket_start");