-- Migration 0003: Add metadata column to plugin_errors for enriched diagnostics
ALTER TABLE plugin_errors ADD COLUMN metadata TEXT;
