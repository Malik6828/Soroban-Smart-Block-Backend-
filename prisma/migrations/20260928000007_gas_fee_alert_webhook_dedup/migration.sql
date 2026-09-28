CREATE UNIQUE INDEX "_webhook_deliveries_idempotency_key_key"
    ON "_webhook_deliveries"("idempotency_key");