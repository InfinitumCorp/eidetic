-- © Infinitum Corporation®. All rights reserved.
-- Checkpoints stay append-only, except a blank signature may be filled once.

CREATE OR REPLACE FUNCTION eidetic_checkpoint_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'audit store is append-only';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.signature = ''
       AND NEW.signature <> ''
       AND NEW.through_seq IS NOT DISTINCT FROM OLD.through_seq
       AND NEW.leaf_count IS NOT DISTINCT FROM OLD.leaf_count
       AND NEW.merkle_root IS NOT DISTINCT FROM OLD.merkle_root
       AND NEW.computed_at IS NOT DISTINCT FROM OLD.computed_at THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'audit store is append-only';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS audit_checkpoints_no_mutate ON audit_checkpoints;
DROP TRIGGER IF EXISTS audit_checkpoints_guard ON audit_checkpoints;
CREATE TRIGGER audit_checkpoints_guard
  BEFORE UPDATE OR DELETE ON audit_checkpoints
  FOR EACH ROW EXECUTE FUNCTION eidetic_checkpoint_guard();
