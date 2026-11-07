-- © Infinitum Corporation®. All rights reserved.
-- HMAC-SHA256 over each Merkle checkpoint. The signature is not a biometric.

ALTER TABLE audit_checkpoints
  ADD COLUMN IF NOT EXISTS signature TEXT NOT NULL DEFAULT '';
