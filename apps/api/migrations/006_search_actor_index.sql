-- © Infinitum Corporation®. All rights reserved.
-- The per-actor search limit counts recent searches by actor.

CREATE INDEX IF NOT EXISTS searches_actor_created_idx ON searches (actor_id, created_at);
