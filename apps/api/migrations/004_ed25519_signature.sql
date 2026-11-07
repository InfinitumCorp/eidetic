-- © Infinitum Corporation®. All rights reserved.
-- A checkpoint may gain an Ed25519 signature once. An existing ed25519 signature cannot be replaced.

CREATE OR REPLACE FUNCTION eidetic_checkpoint_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'audit store is append-only';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.signature LIKE 'ed25519:%'
       AND OLD.signature NOT LIKE 'ed25519:%'
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
