CREATE TABLE "_gas_fee_alert_rules" (
    "id" TEXT NOT NULL,
    "developer_id" VARCHAR(128) NOT NULL,
    "network" VARCHAR(16) NOT NULL,
    "direction" VARCHAR(8) NOT NULL,
    "threshold_stroops" VARCHAR(78) NOT NULL,
    "cooldown_seconds" INTEGER NOT NULL DEFAULT 900,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_observed_fee_stroops" VARCHAR(78),
    "last_evaluated_at" TIMESTAMP(3),
    "last_triggered_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "_gas_fee_alert_rules_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "_gas_fee_alert_rules_network_check"
        CHECK ("network" IN ('mainnet', 'testnet', 'devnet')),
    CONSTRAINT "_gas_fee_alert_rules_direction_check"
        CHECK ("direction" IN ('high', 'low')),
    CONSTRAINT "_gas_fee_alert_rules_threshold_check"
        CHECK ("threshold_stroops" ~ '^[0-9]{1,78}$' AND "threshold_stroops"::numeric > 0),
    CONSTRAINT "_gas_fee_alert_rules_observed_fee_check"
        CHECK ("last_observed_fee_stroops" IS NULL OR "last_observed_fee_stroops" ~ '^[0-9]{1,78}$'),
    CONSTRAINT "_gas_fee_alert_rules_cooldown_check"
        CHECK ("cooldown_seconds" BETWEEN 1 AND 604800)
);

CREATE INDEX "_gas_fee_alert_rules_developer_id_network_is_active_idx"
    ON "_gas_fee_alert_rules"("developer_id", "network", "is_active");
CREATE INDEX "_gas_fee_alert_rules_network_is_active_idx"
    ON "_gas_fee_alert_rules"("network", "is_active");