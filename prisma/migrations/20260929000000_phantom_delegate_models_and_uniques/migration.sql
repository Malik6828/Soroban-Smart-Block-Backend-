-- AlterTable
ALTER TABLE "_dex_pools" ADD COLUMN     "address" TEXT NOT NULL,
ADD COLUMN     "first_seen_ledger" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "last_event_ledger" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "_mev_events" ADD COLUMN     "mev_attacker_id" TEXT;

-- AlterTable
ALTER TABLE "_arbitrage_opportunities" ADD COLUMN     "closed_at" TIMESTAMP(3),
ADD COLUMN     "est_profit_usd" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "_protocol_profiles" ADD COLUMN     "avg_fee_percent" DOUBLE PRECISION,
ADD COLUMN     "category" TEXT,
ADD COLUMN     "discord" TEXT,
ADD COLUMN     "fee_structure" JSONB,
ADD COLUMN     "last_updated_at" TIMESTAMP(3),
ADD COLUMN     "logo_url" TEXT,
ADD COLUMN     "twitter" TEXT,
ADD COLUMN     "website" TEXT;

-- AlterTable
ALTER TABLE "_revenue_alerts" ADD COLUMN     "acknowledged" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "_contract_templates" ADD COLUMN     "abi" JSONB,
ADD COLUMN     "author" TEXT,
ADD COLUMN     "category" TEXT,
ADD COLUMN     "default_args" JSONB,
ADD COLUMN     "deployment_guide" TEXT,
ADD COLUMN     "description" TEXT,
ADD COLUMN     "version" TEXT,
ADD COLUMN     "wasm_base64" TEXT;

-- AlterTable
ALTER TABLE "_fuzz_runs" ADD COLUMN     "strategies" JSONB,
ADD COLUMN     "total_iterations" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "_treasury_transactions" ADD COLUMN     "amount_numeric" DECIMAL(65,30) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "_linked_identities" ADD COLUMN     "message" TEXT,
ADD COLUMN     "signature" TEXT;

-- AlterTable
ALTER TABLE "_pool_snapshots" ADD COLUMN     "snapshot_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "_pool_swaps" ADD COLUMN     "amount_out" TEXT,
ADD COLUMN     "ledger_sequence" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "token_out" TEXT,
ADD COLUMN     "trader" TEXT;

-- AlterTable
ALTER TABLE "_reentrancy_alerts" ADD COLUMN     "cyclic_call_pairs" JSONB,
ADD COLUMN     "ledger_sequence" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "max_call_depth" INTEGER,
ADD COLUMN     "signals" JSONB;

-- AlterTable
ALTER TABLE "_reputation_governance_votes" ADD COLUMN     "support" TEXT;

-- AlterTable
ALTER TABLE "_reputation_profiles" ADD COLUMN     "domain" TEXT;

-- AlterTable
ALTER TABLE "_reputation_signals" ADD COLUMN     "source" TEXT,
ADD COLUMN     "verified" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "_sandbox_calls" ADD COLUMN     "source_account" TEXT;

-- AlterTable
ALTER TABLE "_sandbox_accounts" ADD COLUMN     "label" TEXT,
ADD COLUMN     "sequence_number" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "is_pre_funded" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "_sandbox_ci_runs" ADD COLUMN     "steps" JSONB,
ADD COLUMN     "result" JSONB,
ADD COLUMN     "completed_at" TIMESTAMP(3);
ALTER TABLE "_sandbox_ci_runs" ALTER COLUMN "logs" TYPE JSONB USING "logs"::jsonb;

-- AlterTable
ALTER TABLE "_sandbox_contracts" ADD COLUMN     "deployed_at" TIMESTAMP(3),
ADD COLUMN     "deployer_account" TEXT,
ADD COLUMN     "last_called_at" TIMESTAMP(3),
ADD COLUMN     "source_contract" TEXT,
ADD COLUMN     "template_id" TEXT,
ADD COLUMN     "total_calls" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "wasm_hash" TEXT;

-- AlterTable
ALTER TABLE "_sandbox_sessions" ADD COLUMN     "ledger_sequence" INTEGER,
ADD COLUMN     "ledger_timestamp" TIMESTAMP(3),
ADD COLUMN     "network_passphrase" TEXT;

-- AlterTable
ALTER TABLE "_sandbox_shares" ADD COLUMN     "snapshot_state" JSONB;

-- AlterTable
ALTER TABLE "_settlement_batch_summaries" ADD COLUMN     "unique_parties" INTEGER,
ADD COLUMN     "updated_at" TIMESTAMP(3) NOT NULL,
ADD COLUMN     "window_end" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "_threat_advisories" ADD COLUMN     "resolved_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "_agent_templates" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "author" TEXT NOT NULL,
    "price" TEXT NOT NULL DEFAULT '0',
    "config_schema" JSONB NOT NULL DEFAULT '{}',
    "wasm_base64" TEXT,
    "abi" JSONB,
    "default_permissions" JSONB NOT NULL DEFAULT '[]',
    "default_limits" JSONB NOT NULL DEFAULT '{}',
    "is_published" BOOLEAN NOT NULL DEFAULT false,
    "download_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "_agent_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_agents" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "owner_address" TEXT NOT NULL,
    "template_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'deployed',
    "permissions" JSONB NOT NULL DEFAULT '[]',
    "resource_limits" JSONB NOT NULL DEFAULT '{}',
    "config" JSONB NOT NULL DEFAULT '{}',
    "max_drawdown" DOUBLE PRECISION,
    "current_drawdown" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "total_executions" INTEGER NOT NULL DEFAULT 0,
    "successful_executions" INTEGER NOT NULL DEFAULT 0,
    "failure_count" INTEGER NOT NULL DEFAULT 0,
    "total_gas_used" INTEGER NOT NULL DEFAULT 0,
    "current_day_gas_used" INTEGER NOT NULL DEFAULT 0,
    "gas_reset_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_execution_at" TIMESTAMP(3),
    "last_alert_at" TIMESTAMP(3),
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "_agents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_agent_executions" (
    "id" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "trigger" TEXT NOT NULL DEFAULT 'scheduled',
    "input_state" JSONB,
    "decision" JSONB,
    "output_action" JSONB,
    "reasoning" JSONB NOT NULL DEFAULT '[]',
    "gas_used" INTEGER NOT NULL DEFAULT 0,
    "trace" JSONB,
    "trace_hash" TEXT,
    "signature" TEXT,
    "error" TEXT,
    "completed_at" TIMESTAMP(3),
    "is_verified" BOOLEAN NOT NULL DEFAULT false,
    "verified_by" INTEGER NOT NULL DEFAULT 0,
    "verified_count" INTEGER NOT NULL DEFAULT 0,
    "flagged_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_agent_executions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_agent_verifications" (
    "id" TEXT NOT NULL,
    "execution_id" TEXT NOT NULL,
    "verifier_node" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "discrepancy" JSONB,
    "signature" TEXT,
    "verified_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_agent_verifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_agent_alerts" (
    "id" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'info',
    "message" TEXT NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',
    "acknowledged" BOOLEAN NOT NULL DEFAULT false,
    "acknowledged_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_agent_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_agent_escalations" (
    "id" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "context" JSONB NOT NULL DEFAULT '{}',
    "proposed_actions" JSONB NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'open',
    "resolution" JSONB,
    "resolved_by" TEXT,
    "resolved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_agent_escalations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_agent_messages" (
    "id" TEXT NOT NULL,
    "from_agent_id" TEXT NOT NULL,
    "to_agent_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" JSONB NOT NULL DEFAULT '{}',
    "signature" TEXT,
    "response_to_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "responded_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_agent_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_agent_ratings" (
    "id" TEXT NOT NULL,
    "from_agent_id" TEXT NOT NULL,
    "to_agent_id" TEXT NOT NULL,
    "execution_id" TEXT,
    "score" INTEGER NOT NULL,
    "review" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_agent_ratings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_agent_registrations" (
    "id" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "capabilities" JSONB NOT NULL DEFAULT '[]',
    "price_per_call" TEXT,
    "price_per_month" TEXT,
    "rating" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "total_ratings" INTEGER NOT NULL DEFAULT 0,
    "total_jobs_done" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "_agent_registrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_dashboards" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "owner_id" TEXT NOT NULL,
    "is_public" BOOLEAN NOT NULL DEFAULT false,
    "layout" JSONB NOT NULL DEFAULT '[]',
    "theme" JSONB NOT NULL DEFAULT '{}',
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "embed_token" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "_dashboards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_dashboard_widgets" (
    "id" TEXT NOT NULL,
    "dashboard_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT,
    "config" JSONB NOT NULL DEFAULT '{}',
    "position" JSONB NOT NULL DEFAULT '{"x":0,"y":0,"w":4,"h":3}',
    "refresh_ms" INTEGER NOT NULL DEFAULT 30000,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_dashboard_widgets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_dashboard_collaborators" (
    "id" TEXT NOT NULL,
    "dashboard_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'viewer',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_dashboard_collaborators_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_dashboard_snapshots" (
    "id" TEXT NOT NULL,
    "dashboard_id" TEXT NOT NULL,
    "label" TEXT,
    "data" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_dashboard_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_identity_graphs" (
    "id" TEXT NOT NULL,
    "owner_id" TEXT,
    "display_name" TEXT,
    "avatar_url" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "_identity_graphs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_chain_addresses" (
    "id" TEXT NOT NULL,
    "identity_id" TEXT NOT NULL,
    "chain" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "label" TEXT,
    "verify_proof" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_chain_addresses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_identity_links" (
    "id" TEXT NOT NULL,
    "source_identity_id" TEXT NOT NULL,
    "target_identity_id" TEXT NOT NULL,
    "link_type" TEXT NOT NULL DEFAULT 'same-user',
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "evidence" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_identity_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_bridge_transfers" (
    "id" TEXT NOT NULL,
    "from_chain" TEXT NOT NULL,
    "to_chain" TEXT NOT NULL,
    "from_address" TEXT NOT NULL,
    "to_address" TEXT NOT NULL,
    "asset" TEXT NOT NULL,
    "amount" TEXT NOT NULL,
    "bridge_protocol" TEXT,
    "tx_hash_source" TEXT,
    "tx_hash_dest" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "timestamp" TIMESTAMP(3) NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "from_address_id" TEXT,
    "to_address_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_bridge_transfers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_gas_analytics" (
    "id" TEXT NOT NULL,
    "tx_hash" TEXT NOT NULL,
    "contract_address" TEXT NOT NULL,
    "function_name" TEXT NOT NULL,
    "cpu_instructions" INTEGER NOT NULL DEFAULT 0,
    "memory_bytes" INTEGER NOT NULL DEFAULT 0,
    "ledger_read_bytes" INTEGER NOT NULL DEFAULT 0,
    "ledger_write_bytes" INTEGER NOT NULL DEFAULT 0,
    "ledger_entry_count" INTEGER NOT NULL DEFAULT 0,
    "contract_events_bytes" INTEGER NOT NULL DEFAULT 0,
    "return_value_bytes" INTEGER NOT NULL DEFAULT 0,
    "host_function_calls" INTEGER NOT NULL DEFAULT 0,
    "contract_calls" INTEGER NOT NULL DEFAULT 0,
    "storage_accesses" INTEGER NOT NULL DEFAULT 0,
    "tx_size_bytes" INTEGER NOT NULL DEFAULT 0,
    "total_fee" TEXT NOT NULL,
    "effective_fee_per_instr" TEXT NOT NULL DEFAULT '0',
    "ledger_sequence" INTEGER NOT NULL,
    "ledger_close_time" TIMESTAMP(3) NOT NULL,
    "failure_flag" BOOLEAN NOT NULL DEFAULT false,
    "error_code" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_gas_analytics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_gas_benchmarks" (
    "id" TEXT NOT NULL,
    "contract_address" TEXT NOT NULL,
    "function_name" TEXT NOT NULL,
    "arguments" JSONB NOT NULL DEFAULT '{}',
    "cpu_instructions" INTEGER NOT NULL DEFAULT 0,
    "memory_bytes" INTEGER NOT NULL DEFAULT 0,
    "ledger_read_bytes" INTEGER NOT NULL DEFAULT 0,
    "ledger_write_bytes" INTEGER NOT NULL DEFAULT 0,
    "ledger_entry_count" INTEGER NOT NULL DEFAULT 0,
    "total_fee" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'simulation',
    "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_gas_benchmarks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_gas_alerts" (
    "id" TEXT NOT NULL,
    "contract_address" TEXT NOT NULL,
    "alert_type" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "current_value" DOUBLE PRECISION NOT NULL,
    "baseline_value" DOUBLE PRECISION NOT NULL,
    "deviation_pct" DOUBLE PRECISION NOT NULL,
    "tx_hash" TEXT,
    "message" TEXT NOT NULL,
    "detected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_gas_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_gas_optimization_suggestions" (
    "id" TEXT NOT NULL,
    "contract_address" TEXT NOT NULL,
    "function_name" TEXT NOT NULL,
    "suggestion_type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "current_cost" TEXT NOT NULL,
    "estimated_savings" TEXT NOT NULL,
    "savings_pct" INTEGER NOT NULL DEFAULT 0,
    "effort" TEXT NOT NULL DEFAULT 'medium',
    "severity" TEXT NOT NULL DEFAULT 'info',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "_gas_optimization_suggestions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_token_holders" (
    "id" TEXT NOT NULL,
    "contract_address" TEXT NOT NULL,
    "holder_address" TEXT NOT NULL,
    "balance" TEXT NOT NULL DEFAULT '0',
    "balance_raw" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "percentage" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "rank" INTEGER NOT NULL DEFAULT 0,
    "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_token_holders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_token_concentration_metrics" (
    "id" TEXT NOT NULL,
    "contract_address" TEXT NOT NULL,
    "nakamoto_coefficient" INTEGER NOT NULL,
    "hhi" DOUBLE PRECISION NOT NULL,
    "gini_coefficient" DOUBLE PRECISION NOT NULL,
    "top10_pct" DOUBLE PRECISION NOT NULL,
    "top100_pct" DOUBLE PRECISION NOT NULL,
    "total_holders" INTEGER NOT NULL,
    "total_supply" TEXT NOT NULL,
    "computed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_token_concentration_metrics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_holder_cohorts" (
    "id" TEXT NOT NULL,
    "contract_address" TEXT NOT NULL,
    "cohort_period" TEXT NOT NULL,
    "cohort_start" TIMESTAMP(3) NOT NULL,
    "initial_holders" INTEGER NOT NULL,
    "retained_at_30d" INTEGER,
    "retained_at_60d" INTEGER,
    "retained_at_90d" INTEGER,
    "avg_hold_time" DOUBLE PRECISION,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_holder_cohorts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_whale_alerts" (
    "id" TEXT NOT NULL,
    "contract_address" TEXT NOT NULL,
    "holder_address" TEXT NOT NULL,
    "alert_type" TEXT NOT NULL,
    "old_balance" TEXT NOT NULL,
    "new_balance" TEXT NOT NULL,
    "change_amt" TEXT NOT NULL,
    "change_pct" DOUBLE PRECISION NOT NULL,
    "tx_hash" TEXT,
    "detected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_whale_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_search_ngrams" (
    "id" TEXT NOT NULL,
    "doc_type" TEXT NOT NULL,
    "doc_id" TEXT NOT NULL,
    "gram" TEXT NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "_search_ngrams_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_search_suggestions" (
    "id" TEXT NOT NULL,
    "doc_type" TEXT NOT NULL,
    "doc_id" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "suffix" TEXT,
    "label" TEXT NOT NULL,
    "weight" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "_search_suggestions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_search_index_state" (
    "id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'idle',
    "progress" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "total_docs" INTEGER NOT NULL DEFAULT 0,
    "indexed_docs" INTEGER NOT NULL DEFAULT 0,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "error" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "_search_index_state_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_sdk_versions" (
    "id" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "api_version" TEXT NOT NULL,
    "changelog" TEXT,
    "download_count" INTEGER NOT NULL DEFAULT 0,
    "is_deprecated" BOOLEAN NOT NULL DEFAULT false,
    "published_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_sdk_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_sdk_downloads" (
    "id" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "platform" TEXT,
    "user_agent" TEXT,
    "ip_hash" TEXT,
    "downloaded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_sdk_downloads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_api_spec_snapshots" (
    "id" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "spec" JSONB NOT NULL,
    "hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_api_spec_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_audit_subscriptions" (
    "id" TEXT NOT NULL,
    "contract_address" TEXT NOT NULL,
    "user_id" TEXT,
    "alert_types" TEXT[],
    "threshold" INTEGER NOT NULL DEFAULT 10,
    "cooldown_minutes" INTEGER NOT NULL DEFAULT 60,
    "email_address" TEXT,
    "webhook_url" TEXT,
    "webhook_secret" TEXT,
    "slack_webhook_url" TEXT,
    "slack_channel" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_triggered_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "_audit_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_audit_notification_deliveries" (
    "id" TEXT NOT NULL,
    "subscription_id" TEXT NOT NULL,
    "alert_type" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "http_status" INTEGER,
    "response_body" TEXT,
    "error_msg" TEXT,
    "delivered_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_audit_notification_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_auditor_registry" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "website" TEXT,
    "logo_url" TEXT,
    "description" TEXT,
    "contact_email" TEXT,
    "twitter_handle" TEXT,
    "github_org" TEXT,
    "verification_key" TEXT,
    "verification_key_algo" TEXT,
    "specializations" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "is_verified" BOOLEAN NOT NULL DEFAULT false,
    "verified_at" TIMESTAMP(3),
    "verified_by" TEXT,
    "badge_tier" TEXT,
    "trust_score" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "total_audits" INTEGER NOT NULL DEFAULT 0,
    "accepted_audits" INTEGER NOT NULL DEFAULT 0,
    "rejected_audits" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "suspended_at" TIMESTAMP(3),
    "suspend_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "_auditor_registry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_external_audits" (
    "id" TEXT NOT NULL,
    "contract_address" TEXT NOT NULL,
    "parent_contract_address" TEXT,
    "auditor_id" TEXT,
    "auditor_name" TEXT NOT NULL,
    "auditor_verification_key" TEXT,
    "report_type" TEXT NOT NULL,
    "report_url" TEXT,
    "report_hash" TEXT,
    "report_signature" TEXT,
    "findings" JSONB NOT NULL DEFAULT '[]',
    "overall_grade" TEXT,
    "summary" TEXT,
    "submitted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verification_status" TEXT NOT NULL DEFAULT 'pending',
    "verified_at" TIMESTAMP(3),
    "rejection_reason" TEXT,
    "is_public" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "_external_audits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_audit_verification_records" (
    "id" TEXT NOT NULL,
    "certificate_hash" TEXT NOT NULL,
    "result" TEXT NOT NULL,
    "verifier_ip" TEXT,
    "verifier_key" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "checked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_audit_verification_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_formal_verification_jobs" (
    "id" TEXT NOT NULL,
    "contract_address" TEXT NOT NULL,
    "tool" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "passed" BOOLEAN,
    "source_job_id" TEXT,
    "spec_content" TEXT,
    "spec_file_name" TEXT,
    "tool_options" JSONB,
    "triggered_by" TEXT NOT NULL DEFAULT 'manual',
    "cert_id" TEXT,
    "property_count" INTEGER NOT NULL DEFAULT 0,
    "proven_count" INTEGER NOT NULL DEFAULT 0,
    "violated_count" INTEGER NOT NULL DEFAULT 0,
    "unknown_count" INTEGER NOT NULL DEFAULT 0,
    "coverage_percent" DOUBLE PRECISION,
    "counter_examples" JSONB NOT NULL DEFAULT '[]',
    "tool_output" TEXT,
    "report_url" TEXT,
    "tool_version" TEXT,
    "duration_seconds" INTEGER NOT NULL DEFAULT 0,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_formal_verification_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_flash_loan_attacks" (
    "id" TEXT NOT NULL,
    "tx_hash" TEXT NOT NULL,
    "attacker" TEXT NOT NULL,
    "ledger_sequence" INTEGER NOT NULL,
    "detected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attack_archetype" TEXT NOT NULL,
    "attack_subtype" TEXT,
    "borrowed_total" TEXT NOT NULL,
    "borrowed_tokens" JSONB NOT NULL DEFAULT '[]',
    "repaid_total" TEXT NOT NULL,
    "profit_amount" TEXT NOT NULL,
    "profit_usd" DOUBLE PRECISION,
    "protocol_count" INTEGER NOT NULL DEFAULT 1,
    "step_count" INTEGER NOT NULL DEFAULT 0,
    "fund_flow_graph" JSONB NOT NULL DEFAULT '{}',
    "original_tvls" JSONB NOT NULL DEFAULT '{}',
    "risk_score" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "attacker_toxicity" DOUBLE PRECISION,
    "detection_latency_ms" INTEGER NOT NULL DEFAULT 0,
    "broken_invariants" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "cwe_mappings" JSONB NOT NULL DEFAULT '[]',
    "is_arbitrage" BOOLEAN NOT NULL DEFAULT false,
    "mev_extracted" TEXT,

    CONSTRAINT "_flash_loan_attacks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_attacker_profiles" (
    "id" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "label" TEXT,
    "attack_count" INTEGER NOT NULL DEFAULT 0,
    "total_profit_usd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "avg_toxicity" DOUBLE PRECISION,
    "preferred_archetype" TEXT,
    "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_attacker_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_protocol_vulnerabilities" (
    "id" TEXT NOT NULL,
    "protocol_address" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "severity" TEXT NOT NULL,
    "parent_archetype" TEXT,
    "total_loss" TEXT NOT NULL DEFAULT '0',
    "exploit_tx_hash" TEXT,
    "cwe_id" TEXT,
    "cvss_score" DOUBLE PRECISION,
    "discovered_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_protocol_vulnerabilities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_sanctioned_addresses" (
    "id" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "name" TEXT,
    "list_source" TEXT NOT NULL,
    "jurisdiction" TEXT,
    "source_account" TEXT,
    "added_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_sanctioned_addresses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_compliance_flags" (
    "id" TEXT NOT NULL,
    "source_account" TEXT,
    "destination_account" TEXT,
    "flag_type" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'medium',
    "reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_compliance_flags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_peer_nodes" (
    "id" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "multiaddrs" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "challenges_passed" INTEGER NOT NULL DEFAULT 0,
    "challenges_failed" INTEGER NOT NULL DEFAULT 0,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_peer_nodes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_indexer_range_claims" (
    "id" TEXT NOT NULL,
    "range_id" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "start_ledger" INTEGER NOT NULL,
    "end_ledger" INTEGER NOT NULL,
    "last_indexed_ledger" INTEGER NOT NULL DEFAULT 0,
    "owner_peer_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "last_claimed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "_indexer_range_claims_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_verification_challenges" (
    "id" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "ledger_sequence" INTEGER NOT NULL,
    "challenger_peer_id" TEXT NOT NULL,
    "challenged_peer_id" TEXT NOT NULL,
    "challenger_hash" TEXT NOT NULL,
    "challenged_hash" TEXT NOT NULL,
    "tiebreaker_peer_id" TEXT,
    "tiebreaker_hash" TEXT,
    "result" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_verification_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_reindex_tasks" (
    "id" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "ledger_sequence" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "source_peer_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_reindex_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MonitoredAddress" (
    "id" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "chain" TEXT NOT NULL,
    "label" TEXT,
    "min_alert_usd" DOUBLE PRECISION,
    "alert_on_tx" BOOLEAN NOT NULL DEFAULT true,
    "alert_on_bridging" BOOLEAN NOT NULL DEFAULT true,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MonitoredAddress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_network_node_events" (
    "id" TEXT NOT NULL,
    "node_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "details" JSONB,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_network_node_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_network_node_metrics" (
    "id" TEXT NOT NULL,
    "node_id" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "peer_count" INTEGER,
    "latency" DOUBLE PRECISION,
    "agreement_rate" DOUBLE PRECISION,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_network_node_metrics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_network_consensus_rounds" (
    "id" TEXT NOT NULL,
    "ledger_seq" INTEGER NOT NULL,
    "start_time" TIMESTAMP(3) NOT NULL,
    "end_time" TIMESTAMP(3),
    "duration_ms" INTEGER,
    "tx_count" INTEGER,
    "successful" BOOLEAN NOT NULL DEFAULT true,
    "nodes_participated" INTEGER,
    "quorum_set_size" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_network_consensus_rounds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_contract_state_changes" (
    "id" TEXT NOT NULL,
    "contract_address" TEXT NOT NULL,
    "ledger" INTEGER NOT NULL,
    "ledger_close_time" TIMESTAMP(3) NOT NULL,
    "storage_key" TEXT NOT NULL,
    "storage_key_human" TEXT,
    "value_before" TEXT,
    "value_after" TEXT,
    "value_human" TEXT,
    "operation" TEXT NOT NULL,
    "transaction_hash" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_contract_state_changes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "_agent_templates_category_idx" ON "_agent_templates"("category");

-- CreateIndex
CREATE INDEX "_agent_templates_is_published_download_count_idx" ON "_agent_templates"("is_published", "download_count");

-- CreateIndex
CREATE INDEX "_agents_owner_address_idx" ON "_agents"("owner_address");

-- CreateIndex
CREATE INDEX "_agents_template_id_idx" ON "_agents"("template_id");

-- CreateIndex
CREATE INDEX "_agents_status_idx" ON "_agents"("status");

-- CreateIndex
CREATE INDEX "_agents_owner_address_status_idx" ON "_agents"("owner_address", "status");

-- CreateIndex
CREATE INDEX "_agent_executions_agent_id_created_at_idx" ON "_agent_executions"("agent_id", "created_at");

-- CreateIndex
CREATE INDEX "_agent_executions_status_idx" ON "_agent_executions"("status");

-- CreateIndex
CREATE INDEX "_agent_executions_trace_hash_idx" ON "_agent_executions"("trace_hash");

-- CreateIndex
CREATE INDEX "_agent_verifications_execution_id_idx" ON "_agent_verifications"("execution_id");

-- CreateIndex
CREATE INDEX "_agent_verifications_verifier_node_idx" ON "_agent_verifications"("verifier_node");

-- CreateIndex
CREATE INDEX "_agent_alerts_agent_id_acknowledged_created_at_idx" ON "_agent_alerts"("agent_id", "acknowledged", "created_at");

-- CreateIndex
CREATE INDEX "_agent_alerts_type_idx" ON "_agent_alerts"("type");

-- CreateIndex
CREATE INDEX "_agent_escalations_agent_id_status_idx" ON "_agent_escalations"("agent_id", "status");

-- CreateIndex
CREATE INDEX "_agent_escalations_status_created_at_idx" ON "_agent_escalations"("status", "created_at");

-- CreateIndex
CREATE INDEX "_agent_messages_from_agent_id_to_agent_id_idx" ON "_agent_messages"("from_agent_id", "to_agent_id");

-- CreateIndex
CREATE INDEX "_agent_messages_to_agent_id_status_idx" ON "_agent_messages"("to_agent_id", "status");

-- CreateIndex
CREATE INDEX "_agent_messages_type_idx" ON "_agent_messages"("type");

-- CreateIndex
CREATE INDEX "_agent_ratings_to_agent_id_created_at_idx" ON "_agent_ratings"("to_agent_id", "created_at");

-- CreateIndex
CREATE INDEX "_agent_ratings_from_agent_id_idx" ON "_agent_ratings"("from_agent_id");

-- CreateIndex
CREATE UNIQUE INDEX "_agent_registrations_agent_id_key" ON "_agent_registrations"("agent_id");

-- CreateIndex
CREATE INDEX "_agent_registrations_is_active_idx" ON "_agent_registrations"("is_active");

-- CreateIndex
CREATE UNIQUE INDEX "_dashboards_embed_token_key" ON "_dashboards"("embed_token");

-- CreateIndex
CREATE INDEX "_dashboards_owner_id_updated_at_idx" ON "_dashboards"("owner_id", "updated_at");

-- CreateIndex
CREATE INDEX "_dashboards_is_public_idx" ON "_dashboards"("is_public");

-- CreateIndex
CREATE INDEX "_dashboard_widgets_dashboard_id_idx" ON "_dashboard_widgets"("dashboard_id");

-- CreateIndex
CREATE INDEX "_dashboard_collaborators_user_id_idx" ON "_dashboard_collaborators"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "_dashboard_collaborators_dashboard_id_user_id_key" ON "_dashboard_collaborators"("dashboard_id", "user_id");

-- CreateIndex
CREATE INDEX "_dashboard_snapshots_dashboard_id_created_at_idx" ON "_dashboard_snapshots"("dashboard_id", "created_at");

-- CreateIndex
CREATE INDEX "_identity_graphs_owner_id_idx" ON "_identity_graphs"("owner_id");

-- CreateIndex
CREATE INDEX "_chain_addresses_identity_id_idx" ON "_chain_addresses"("identity_id");

-- CreateIndex
CREATE UNIQUE INDEX "_chain_addresses_chain_address_key" ON "_chain_addresses"("chain", "address");

-- CreateIndex
CREATE INDEX "_identity_links_target_identity_id_idx" ON "_identity_links"("target_identity_id");

-- CreateIndex
CREATE UNIQUE INDEX "_identity_links_source_identity_id_target_identity_id_key" ON "_identity_links"("source_identity_id", "target_identity_id");

-- CreateIndex
CREATE INDEX "_bridge_transfers_timestamp_idx" ON "_bridge_transfers"("timestamp");

-- CreateIndex
CREATE INDEX "_bridge_transfers_from_address_to_address_idx" ON "_bridge_transfers"("from_address", "to_address");

-- CreateIndex
CREATE INDEX "_bridge_transfers_status_idx" ON "_bridge_transfers"("status");

-- CreateIndex
CREATE INDEX "_bridge_transfers_bridge_protocol_timestamp_idx" ON "_bridge_transfers"("bridge_protocol", "timestamp");

-- CreateIndex
CREATE INDEX "_bridge_transfers_from_address_id_idx" ON "_bridge_transfers"("from_address_id");

-- CreateIndex
CREATE INDEX "_bridge_transfers_to_address_id_idx" ON "_bridge_transfers"("to_address_id");

-- CreateIndex
CREATE UNIQUE INDEX "_gas_analytics_tx_hash_key" ON "_gas_analytics"("tx_hash");

-- CreateIndex
CREATE INDEX "_gas_analytics_contract_address_ledger_close_time_idx" ON "_gas_analytics"("contract_address", "ledger_close_time");

-- CreateIndex
CREATE INDEX "_gas_analytics_contract_address_function_name_idx" ON "_gas_analytics"("contract_address", "function_name");

-- CreateIndex
CREATE INDEX "_gas_analytics_ledger_sequence_idx" ON "_gas_analytics"("ledger_sequence");

-- CreateIndex
CREATE INDEX "_gas_benchmarks_contract_address_function_name_recorded_at_idx" ON "_gas_benchmarks"("contract_address", "function_name", "recorded_at");

-- CreateIndex
CREATE INDEX "_gas_benchmarks_source_idx" ON "_gas_benchmarks"("source");

-- CreateIndex
CREATE INDEX "_gas_alerts_contract_address_detected_at_idx" ON "_gas_alerts"("contract_address", "detected_at");

-- CreateIndex
CREATE INDEX "_gas_alerts_alert_type_idx" ON "_gas_alerts"("alert_type");

-- CreateIndex
CREATE INDEX "_gas_alerts_severity_idx" ON "_gas_alerts"("severity");

-- CreateIndex
CREATE INDEX "_gas_optimization_suggestions_contract_address_idx" ON "_gas_optimization_suggestions"("contract_address");

-- CreateIndex
CREATE UNIQUE INDEX "_gas_optimization_suggestions_contract_address_function_nam_key" ON "_gas_optimization_suggestions"("contract_address", "function_name", "suggestion_type");

-- CreateIndex
CREATE INDEX "_token_holders_contract_address_balance_raw_idx" ON "_token_holders"("contract_address", "balance_raw");

-- CreateIndex
CREATE INDEX "_token_holders_holder_address_idx" ON "_token_holders"("holder_address");

-- CreateIndex
CREATE UNIQUE INDEX "_token_holders_contract_address_holder_address_key" ON "_token_holders"("contract_address", "holder_address");

-- CreateIndex
CREATE INDEX "_token_concentration_metrics_contract_address_computed_at_idx" ON "_token_concentration_metrics"("contract_address", "computed_at");

-- CreateIndex
CREATE INDEX "_holder_cohorts_contract_address_cohort_start_idx" ON "_holder_cohorts"("contract_address", "cohort_start");

-- CreateIndex
CREATE INDEX "_whale_alerts_contract_address_detected_at_idx" ON "_whale_alerts"("contract_address", "detected_at");

-- CreateIndex
CREATE INDEX "_whale_alerts_holder_address_idx" ON "_whale_alerts"("holder_address");

-- CreateIndex
CREATE INDEX "_whale_alerts_alert_type_idx" ON "_whale_alerts"("alert_type");

-- CreateIndex
CREATE INDEX "_search_ngrams_doc_type_doc_id_idx" ON "_search_ngrams"("doc_type", "doc_id");

-- CreateIndex
CREATE INDEX "_search_ngrams_gram_idx" ON "_search_ngrams"("gram");

-- CreateIndex
CREATE INDEX "_search_suggestions_prefix_idx" ON "_search_suggestions"("prefix");

-- CreateIndex
CREATE INDEX "_search_suggestions_suffix_idx" ON "_search_suggestions"("suffix");

-- CreateIndex
CREATE INDEX "_search_suggestions_weight_idx" ON "_search_suggestions"("weight");

-- CreateIndex
CREATE UNIQUE INDEX "_search_suggestions_doc_type_prefix_doc_id_key" ON "_search_suggestions"("doc_type", "prefix", "doc_id");

-- CreateIndex
CREATE INDEX "_sdk_versions_language_published_at_idx" ON "_sdk_versions"("language", "published_at");

-- CreateIndex
CREATE INDEX "_sdk_versions_is_deprecated_idx" ON "_sdk_versions"("is_deprecated");

-- CreateIndex
CREATE UNIQUE INDEX "_sdk_versions_language_version_key" ON "_sdk_versions"("language", "version");

-- CreateIndex
CREATE INDEX "_sdk_downloads_language_downloaded_at_idx" ON "_sdk_downloads"("language", "downloaded_at");

-- CreateIndex
CREATE INDEX "_sdk_downloads_downloaded_at_idx" ON "_sdk_downloads"("downloaded_at");

-- CreateIndex
CREATE UNIQUE INDEX "_api_spec_snapshots_version_key" ON "_api_spec_snapshots"("version");

-- CreateIndex
CREATE INDEX "_audit_subscriptions_contract_address_is_active_idx" ON "_audit_subscriptions"("contract_address", "is_active");

-- CreateIndex
CREATE INDEX "_audit_subscriptions_user_id_idx" ON "_audit_subscriptions"("user_id");

-- CreateIndex
CREATE INDEX "_audit_subscriptions_is_active_idx" ON "_audit_subscriptions"("is_active");

-- CreateIndex
CREATE INDEX "_audit_notification_deliveries_subscription_id_created_at_idx" ON "_audit_notification_deliveries"("subscription_id", "created_at");

-- CreateIndex
CREATE INDEX "_audit_notification_deliveries_status_idx" ON "_audit_notification_deliveries"("status");

-- CreateIndex
CREATE UNIQUE INDEX "_auditor_registry_slug_key" ON "_auditor_registry"("slug");

-- CreateIndex
CREATE INDEX "_auditor_registry_is_verified_trust_score_idx" ON "_auditor_registry"("is_verified", "trust_score");

-- CreateIndex
CREATE INDEX "_auditor_registry_is_active_idx" ON "_auditor_registry"("is_active");

-- CreateIndex
CREATE INDEX "_external_audits_contract_address_verification_status_idx" ON "_external_audits"("contract_address", "verification_status");

-- CreateIndex
CREATE INDEX "_external_audits_auditor_id_submitted_at_idx" ON "_external_audits"("auditor_id", "submitted_at");

-- CreateIndex
CREATE INDEX "_external_audits_verification_status_idx" ON "_external_audits"("verification_status");

-- CreateIndex
CREATE INDEX "_audit_verification_records_certificate_hash_idx" ON "_audit_verification_records"("certificate_hash");

-- CreateIndex
CREATE INDEX "_audit_verification_records_created_at_idx" ON "_audit_verification_records"("created_at");

-- CreateIndex
CREATE INDEX "_formal_verification_jobs_contract_address_created_at_idx" ON "_formal_verification_jobs"("contract_address", "created_at");

-- CreateIndex
CREATE INDEX "_formal_verification_jobs_status_idx" ON "_formal_verification_jobs"("status");

-- CreateIndex
CREATE UNIQUE INDEX "_flash_loan_attacks_tx_hash_key" ON "_flash_loan_attacks"("tx_hash");

-- CreateIndex
CREATE INDEX "_flash_loan_attacks_detected_at_idx" ON "_flash_loan_attacks"("detected_at");

-- CreateIndex
CREATE INDEX "_flash_loan_attacks_attacker_idx" ON "_flash_loan_attacks"("attacker");

-- CreateIndex
CREATE INDEX "_flash_loan_attacks_attack_archetype_idx" ON "_flash_loan_attacks"("attack_archetype");

-- CreateIndex
CREATE INDEX "_flash_loan_attacks_profit_usd_idx" ON "_flash_loan_attacks"("profit_usd");

-- CreateIndex
CREATE INDEX "_flash_loan_attacks_risk_score_idx" ON "_flash_loan_attacks"("risk_score");

-- CreateIndex
CREATE UNIQUE INDEX "_attacker_profiles_address_key" ON "_attacker_profiles"("address");

-- CreateIndex
CREATE INDEX "_attacker_profiles_attack_count_idx" ON "_attacker_profiles"("attack_count");

-- CreateIndex
CREATE INDEX "_attacker_profiles_total_profit_usd_idx" ON "_attacker_profiles"("total_profit_usd");

-- CreateIndex
CREATE INDEX "_protocol_vulnerabilities_protocol_address_idx" ON "_protocol_vulnerabilities"("protocol_address");

-- CreateIndex
CREATE INDEX "_protocol_vulnerabilities_severity_idx" ON "_protocol_vulnerabilities"("severity");

-- CreateIndex
CREATE UNIQUE INDEX "_sanctioned_addresses_address_key" ON "_sanctioned_addresses"("address");

-- CreateIndex
CREATE INDEX "_sanctioned_addresses_added_at_idx" ON "_sanctioned_addresses"("added_at");

-- CreateIndex
CREATE INDEX "_compliance_flags_source_account_idx" ON "_compliance_flags"("source_account");

-- CreateIndex
CREATE INDEX "_compliance_flags_destination_account_idx" ON "_compliance_flags"("destination_account");

-- CreateIndex
CREATE INDEX "_compliance_flags_created_at_idx" ON "_compliance_flags"("created_at");

-- CreateIndex
CREATE INDEX "_peer_nodes_network_last_seen_at_idx" ON "_peer_nodes"("network", "last_seen_at");

-- CreateIndex
CREATE UNIQUE INDEX "_indexer_range_claims_range_id_key" ON "_indexer_range_claims"("range_id");

-- CreateIndex
CREATE INDEX "_indexer_range_claims_network_start_ledger_idx" ON "_indexer_range_claims"("network", "start_ledger");

-- CreateIndex
CREATE INDEX "_verification_challenges_network_created_at_idx" ON "_verification_challenges"("network", "created_at");

-- CreateIndex
CREATE INDEX "_verification_challenges_result_idx" ON "_verification_challenges"("result");

-- CreateIndex
CREATE INDEX "_reindex_tasks_network_status_created_at_idx" ON "_reindex_tasks"("network", "status", "created_at");

-- CreateIndex
CREATE INDEX "_reindex_tasks_ledger_sequence_idx" ON "_reindex_tasks"("ledger_sequence");

-- CreateIndex
CREATE INDEX "MonitoredAddress_active_idx" ON "MonitoredAddress"("active");

-- CreateIndex
CREATE INDEX "MonitoredAddress_chain_idx" ON "MonitoredAddress"("chain");

-- CreateIndex
CREATE UNIQUE INDEX "MonitoredAddress_address_chain_key" ON "MonitoredAddress"("address", "chain");

-- CreateIndex
CREATE INDEX "_network_node_events_node_id_timestamp_idx" ON "_network_node_events"("node_id", "timestamp");

-- CreateIndex
CREATE INDEX "_network_node_events_event_type_idx" ON "_network_node_events"("event_type");

-- CreateIndex
CREATE INDEX "_network_node_metrics_node_id_timestamp_idx" ON "_network_node_metrics"("node_id", "timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "_network_consensus_rounds_ledger_seq_key" ON "_network_consensus_rounds"("ledger_seq");

-- CreateIndex
CREATE INDEX "_network_consensus_rounds_ledger_seq_idx" ON "_network_consensus_rounds"("ledger_seq");

-- CreateIndex
CREATE INDEX "_contract_state_changes_contract_address_ledger_idx" ON "_contract_state_changes"("contract_address", "ledger");

-- CreateIndex
CREATE INDEX "_contract_state_changes_contract_address_storage_key_ledger_idx" ON "_contract_state_changes"("contract_address", "storage_key", "ledger");

-- CreateIndex
CREATE UNIQUE INDEX "_dex_pools_address_key" ON "_dex_pools"("address");

-- CreateIndex
CREATE UNIQUE INDEX "_commodity_dual_signer_logs_transaction_hash_key" ON "_commodity_dual_signer_logs"("transaction_hash");

-- CreateIndex
CREATE UNIQUE INDEX "_dtcc_settlement_bridges_transaction_hash_key" ON "_dtcc_settlement_bridges"("transaction_hash");

-- CreateIndex
CREATE UNIQUE INDEX "_gas_golfing_tips_function_name_key" ON "_gas_golfing_tips"("function_name");

-- CreateIndex
CREATE UNIQUE INDEX "_reputation_delegations_delegator_key" ON "_reputation_delegations"("delegator");

-- CreateIndex
CREATE UNIQUE INDEX "_tip_webhooks_url_key" ON "_tip_webhooks"("url");

-- CreateIndex
CREATE UNIQUE INDEX "_verifiable_credentials_credential_id_key" ON "_verifiable_credentials"("credential_id");

-- AddForeignKey
ALTER TABLE "_mev_events" ADD CONSTRAINT "_mev_events_mev_attacker_id_fkey" FOREIGN KEY ("mev_attacker_id") REFERENCES "_mev_attackers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_agents" ADD CONSTRAINT "_agents_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "_agent_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_agent_executions" ADD CONSTRAINT "_agent_executions_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "_agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_agent_verifications" ADD CONSTRAINT "_agent_verifications_execution_id_fkey" FOREIGN KEY ("execution_id") REFERENCES "_agent_executions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_agent_alerts" ADD CONSTRAINT "_agent_alerts_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "_agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_agent_escalations" ADD CONSTRAINT "_agent_escalations_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "_agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_agent_messages" ADD CONSTRAINT "_agent_messages_from_agent_id_fkey" FOREIGN KEY ("from_agent_id") REFERENCES "_agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_agent_messages" ADD CONSTRAINT "_agent_messages_to_agent_id_fkey" FOREIGN KEY ("to_agent_id") REFERENCES "_agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_agent_messages" ADD CONSTRAINT "_agent_messages_response_to_id_fkey" FOREIGN KEY ("response_to_id") REFERENCES "_agent_messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_agent_ratings" ADD CONSTRAINT "_agent_ratings_from_agent_id_fkey" FOREIGN KEY ("from_agent_id") REFERENCES "_agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_agent_ratings" ADD CONSTRAINT "_agent_ratings_to_agent_id_fkey" FOREIGN KEY ("to_agent_id") REFERENCES "_agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_agent_ratings" ADD CONSTRAINT "_agent_ratings_execution_id_fkey" FOREIGN KEY ("execution_id") REFERENCES "_agent_executions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_agent_registrations" ADD CONSTRAINT "_agent_registrations_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "_agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_dashboard_widgets" ADD CONSTRAINT "_dashboard_widgets_dashboard_id_fkey" FOREIGN KEY ("dashboard_id") REFERENCES "_dashboards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_dashboard_collaborators" ADD CONSTRAINT "_dashboard_collaborators_dashboard_id_fkey" FOREIGN KEY ("dashboard_id") REFERENCES "_dashboards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_dashboard_snapshots" ADD CONSTRAINT "_dashboard_snapshots_dashboard_id_fkey" FOREIGN KEY ("dashboard_id") REFERENCES "_dashboards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_chain_addresses" ADD CONSTRAINT "_chain_addresses_identity_id_fkey" FOREIGN KEY ("identity_id") REFERENCES "_identity_graphs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_identity_links" ADD CONSTRAINT "_identity_links_source_identity_id_fkey" FOREIGN KEY ("source_identity_id") REFERENCES "_identity_graphs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_identity_links" ADD CONSTRAINT "_identity_links_target_identity_id_fkey" FOREIGN KEY ("target_identity_id") REFERENCES "_identity_graphs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_bridge_transfers" ADD CONSTRAINT "_bridge_transfers_from_address_id_fkey" FOREIGN KEY ("from_address_id") REFERENCES "_chain_addresses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_bridge_transfers" ADD CONSTRAINT "_bridge_transfers_to_address_id_fkey" FOREIGN KEY ("to_address_id") REFERENCES "_chain_addresses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_whale_alerts" ADD CONSTRAINT "_whale_alerts_contract_address_holder_address_fkey" FOREIGN KEY ("contract_address", "holder_address") REFERENCES "_token_holders"("contract_address", "holder_address") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_sdk_downloads" ADD CONSTRAINT "_sdk_downloads_language_version_fkey" FOREIGN KEY ("language", "version") REFERENCES "_sdk_versions"("language", "version") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_audit_notification_deliveries" ADD CONSTRAINT "_audit_notification_deliveries_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "_audit_subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_external_audits" ADD CONSTRAINT "_external_audits_auditor_id_fkey" FOREIGN KEY ("auditor_id") REFERENCES "_auditor_registry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_network_node_events" ADD CONSTRAINT "_network_node_events_node_id_fkey" FOREIGN KEY ("node_id") REFERENCES "_network_nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_network_node_metrics" ADD CONSTRAINT "_network_node_metrics_node_id_fkey" FOREIGN KEY ("node_id") REFERENCES "_network_nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

