-- phase: expand
-- WS-B task 2: Live keeps no passwords and no email addresses; the OpenVibe account (openvibe.network) keeps them.
-- users.password_hash was NOT NULL, so every new user row carried a random '$sso$…' placeholder. It becomes nullable
-- and nothing writes it any more (server/db/database.js createUser); users.email is already written as NULL only.
-- A later contract migration drops both columns once no release that writes them can be rolled back to.
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
