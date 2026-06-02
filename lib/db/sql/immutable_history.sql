-- NCRP append-only history guards.
--
-- Enforces immutability of the imported legacy history tables (rent payments,
-- cyberware/meds, the full bot transaction ledger, attendance) plus the audit
-- and activity logs, AT THE DATABASE LEVEL. No future code path, ad-hoc query,
-- or accidental bug can UPDATE, DELETE, or TRUNCATE a recorded history row.
--
-- INSERT is still permitted, so re-running an importer can add NEW rows but can
-- never modify or remove existing ones (the importers already use
-- ON CONFLICT DO NOTHING, so re-imports are a no-op for rows we already have).
--
-- Idempotent: safe to run repeatedly (applied on every post-merge / deploy).
--
-- NOTE: the live wallet_transactions ledger is intentionally NOT locked here.
-- It is an actively-managed ledger whose rows have a legitimate lifecycle
-- (reserve -> confirm/sync, reservation rollback on a failed UnbelievaBoat
-- charge, character-merge re-pointing). Its confirmed rows are protected by
-- convention (only failed reservations are ever deleted) and by the unique
-- idempotency index that prevents double-applying the same logical change.

CREATE OR REPLACE FUNCTION ncrp_block_history_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION
    'Append-only history table "%": % is not permitted. These records are immutable (INSERT only).',
    TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation',
          HINT = 'Historical rent, cyberware/meds, financial, attendance and audit records cannot be changed or removed.';
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'bot_rent_payment_events',
    'bot_balance_history',
    'bot_actor_attendance',
    'bot_attendance_log',
    'audit_log',
    'activity_events'
  ] LOOP
    -- Skip gracefully if a table does not exist yet in this database.
    IF to_regclass(format('public.%I', t)) IS NULL THEN
      RAISE NOTICE 'skipping % (table not present)', t;
      CONTINUE;
    END IF;

    EXECUTE format('DROP TRIGGER IF EXISTS trg_ncrp_block_mutation ON public.%I', t);
    EXECUTE format(
      'CREATE TRIGGER trg_ncrp_block_mutation BEFORE UPDATE OR DELETE ON public.%I '
      || 'FOR EACH ROW EXECUTE FUNCTION ncrp_block_history_mutation()', t);

    EXECUTE format('DROP TRIGGER IF EXISTS trg_ncrp_block_truncate ON public.%I', t);
    EXECUTE format(
      'CREATE TRIGGER trg_ncrp_block_truncate BEFORE TRUNCATE ON public.%I '
      || 'FOR EACH STATEMENT EXECUTE FUNCTION ncrp_block_history_mutation()', t);
  END LOOP;
END $$;
