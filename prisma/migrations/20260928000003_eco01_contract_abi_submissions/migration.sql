-- ECO01: durable community ABI submissions and append-only moderation history.
CREATE TABLE IF NOT EXISTS "_contract_abi_submissions" (
  "id" TEXT NOT NULL,
  "address" VARCHAR(56) NOT NULL,
  "network" VARCHAR(32) NOT NULL,
  "submitted_by" VARCHAR(128) NOT NULL,
  "payload" JSONB NOT NULL,
  "content_hash" VARCHAR(64) NOT NULL,
  "status" VARCHAR(16) NOT NULL DEFAULT 'pending',
  "validated_at" TIMESTAMP(3) NOT NULL,
  "validation_ledger" INTEGER NOT NULL,
  "review_note" TEXT,
  "reviewed_by" TEXT,
  "reviewed_at" TIMESTAMP(3),
  "published_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "_contract_abi_submissions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "_contract_abi_submissions_status_check"
    CHECK ("status" IN ('pending', 'approved', 'rejected', 'published')),
  CONSTRAINT "_contract_abi_submissions_address_network_submitter_content_key"
    UNIQUE ("address", "network", "submitted_by", "content_hash")
);

CREATE INDEX IF NOT EXISTS "_contract_abi_submissions_status_created_at_idx"
  ON "_contract_abi_submissions"("status", "created_at");
CREATE INDEX IF NOT EXISTS "_contract_abi_submissions_address_network_idx"
  ON "_contract_abi_submissions"("address", "network");

CREATE TABLE IF NOT EXISTS "_contract_abi_submission_events" (
  "id" TEXT NOT NULL,
  "submission_id" TEXT NOT NULL,
  "from_status" VARCHAR(16),
  "to_status" VARCHAR(16) NOT NULL,
  "actor" TEXT NOT NULL,
  "reason" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "_contract_abi_submission_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "_contract_abi_submission_events_to_status_check"
    CHECK ("to_status" IN ('pending', 'approved', 'rejected', 'published')),
  CONSTRAINT "_contract_abi_submission_events_transition_check"
    CHECK (
      ("from_status" IS NULL AND "to_status" = 'pending') OR
      ("from_status" = 'pending' AND "to_status" IN ('approved', 'rejected')) OR
      ("from_status" = 'approved' AND "to_status" = 'published')
    ),
  CONSTRAINT "_contract_abi_submission_events_submission_id_fkey"
    FOREIGN KEY ("submission_id") REFERENCES "_contract_abi_submissions"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "_contract_abi_submission_events_submission_created_at_idx"
  ON "_contract_abi_submission_events"("submission_id", "created_at");
