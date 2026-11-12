-- © Infinitum Corporation®. All rights reserved.
-- Consent may carry an expiry. Null means it lasts until the subject withdraws.

ALTER TABLE consents ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'consents_expiry_after_grant') THEN
    ALTER TABLE consents ADD CONSTRAINT consents_expiry_after_grant CHECK (expires_at IS NULL OR expires_at > granted_at);
  END IF;
END $$;
