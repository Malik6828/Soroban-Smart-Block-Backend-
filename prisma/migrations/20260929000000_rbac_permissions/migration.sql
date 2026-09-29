-- CreateTable: Core RBAC Permission System
-- Migration: 20260929000000_rbac_permissions

-- Core permission definitions
CREATE TABLE "permissions" (
    "id" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "scope" TEXT,
    "description" TEXT,
    "conditions" JSONB DEFAULT '[]',
    "is_system_permission" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("id")
);

-- Role definitions with inheritance
CREATE TABLE "roles" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "inherits_from" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "is_system_role" BOOLEAN NOT NULL DEFAULT false,
    "conditions" JSONB DEFAULT '[]',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- Role-permission assignments
CREATE TABLE "role_permissions" (
    "role_id" TEXT NOT NULL,
    "permission_id" TEXT NOT NULL,
    "granted_by" TEXT,
    "granted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("role_id","permission_id")
);

-- Multi-tenant support
CREATE TABLE "tenants" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "parent_tenant_id" TEXT,
    "settings" JSONB DEFAULT '{}',
    "isolation_level" TEXT NOT NULL DEFAULT 'strict',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- User-role assignments (extends existing WalletUser)
CREATE TABLE "user_roles" (
    "user_id" TEXT NOT NULL,
    "role_id" TEXT NOT NULL,
    "tenant_id" TEXT,
    "granted_by" TEXT,
    "granted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3),
    "conditions" JSONB DEFAULT '[]',

    CONSTRAINT "user_roles_pkey" PRIMARY KEY ("user_id","role_id","tenant_id")
);

-- Direct user permissions (for exceptions)
CREATE TABLE "user_permissions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "permission_id" TEXT NOT NULL,
    "tenant_id" TEXT,
    "resource_type" TEXT,
    "resource_id" TEXT,
    "granted_by" TEXT,
    "granted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3),
    "conditions" JSONB DEFAULT '[]',

    CONSTRAINT "user_permissions_pkey" PRIMARY KEY ("id")
);

-- Enhanced API key scopes
CREATE TABLE "api_key_scopes" (
    "id" TEXT NOT NULL,
    "api_key_id" TEXT NOT NULL,
    "permission_id" TEXT NOT NULL,
    "resource_restrictions" JSONB DEFAULT '[]',
    "conditions" JSONB DEFAULT '[]',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_key_scopes_pkey" PRIMARY KEY ("id")
);

-- Resource-level access control
CREATE TABLE "resource_permissions" (
    "id" TEXT NOT NULL,
    "resource_type" TEXT NOT NULL,
    "resource_id" TEXT NOT NULL,
    "principal_id" TEXT NOT NULL,
    "principal_type" TEXT NOT NULL,
    "permissions" TEXT[],
    "granted_by" TEXT,
    "granted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3),
    "tenant_id" TEXT,

    CONSTRAINT "resource_permissions_pkey" PRIMARY KEY ("id")
);

-- Permission evaluation cache
CREATE TABLE "permission_cache" (
    "cache_key" TEXT NOT NULL,
    "user_id" TEXT,
    "api_key_id" TEXT,
    "tenant_id" TEXT,
    "permissions" JSONB NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "permission_cache_pkey" PRIMARY KEY ("cache_key")
);

-- Add tenant support to existing tables
ALTER TABLE "wallet_users" ADD COLUMN "tenant_id" TEXT;
ALTER TABLE "_dev_api_keies" ADD COLUMN "tenant_id" TEXT;

-- Create unique indexes
CREATE UNIQUE INDEX "tenants_slug_key" ON "tenants"("slug");

-- Create performance indexes
CREATE INDEX "permissions_resource_action_idx" ON "permissions"("resource", "action");
CREATE INDEX "permissions_scope_idx" ON "permissions"("scope");
CREATE INDEX "roles_inherits_from_idx" ON "roles" USING GIN("inherits_from");
CREATE INDEX "user_roles_user_tenant_idx" ON "user_roles"("user_id", "tenant_id");
CREATE INDEX "user_roles_role_idx" ON "user_roles"("role_id");
CREATE INDEX "user_roles_expires_at_idx" ON "user_roles"("expires_at");
CREATE INDEX "user_permissions_user_tenant_idx" ON "user_permissions"("user_id", "tenant_id");
CREATE INDEX "user_permissions_permission_idx" ON "user_permissions"("permission_id");
CREATE INDEX "user_permissions_resource_idx" ON "user_permissions"("resource_type", "resource_id");
CREATE INDEX "user_permissions_expires_at_idx" ON "user_permissions"("expires_at");
CREATE INDEX "api_key_scopes_key_idx" ON "api_key_scopes"("api_key_id");
CREATE INDEX "api_key_scopes_permission_idx" ON "api_key_scopes"("permission_id");
CREATE INDEX "resource_permissions_resource_idx" ON "resource_permissions"("resource_type", "resource_id");
CREATE INDEX "resource_permissions_principal_idx" ON "resource_permissions"("principal_id", "principal_type");
CREATE INDEX "resource_permissions_tenant_idx" ON "resource_permissions"("tenant_id");
CREATE INDEX "resource_permissions_expires_at_idx" ON "resource_permissions"("expires_at");
CREATE INDEX "permission_cache_user_idx" ON "permission_cache"("user_id", "tenant_id");
CREATE INDEX "permission_cache_api_key_idx" ON "permission_cache"("api_key_id", "tenant_id");
CREATE INDEX "permission_cache_expires_at_idx" ON "permission_cache"("expires_at");

-- Add foreign key constraints
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "permissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_parent_tenant_id_fkey" FOREIGN KEY ("parent_tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "wallet_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_permissions" ADD CONSTRAINT "user_permissions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "wallet_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_permissions" ADD CONSTRAINT "user_permissions_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "permissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_permissions" ADD CONSTRAINT "user_permissions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "api_key_scopes" ADD CONSTRAINT "api_key_scopes_api_key_id_fkey" FOREIGN KEY ("api_key_id") REFERENCES "_dev_api_keies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "api_key_scopes" ADD CONSTRAINT "api_key_scopes_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "permissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "resource_permissions" ADD CONSTRAINT "resource_permissions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "wallet_users" ADD CONSTRAINT "wallet_users_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "_dev_api_keies" ADD CONSTRAINT "_dev_api_keies_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Create check constraints
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_isolation_level_check" CHECK ("isolation_level" IN ('strict', 'shared'));
ALTER TABLE "resource_permissions" ADD CONSTRAINT "resource_permissions_principal_type_check" CHECK ("principal_type" IN ('user', 'api_key', 'role'));

-- Add updated_at trigger for auto-updating timestamps
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_permissions_updated_at BEFORE UPDATE ON "permissions" FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_roles_updated_at BEFORE UPDATE ON "roles" FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_tenants_updated_at BEFORE UPDATE ON "tenants" FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();