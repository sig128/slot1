-- Everything SLOT1 sees, sorted: each entry of the live log carries the activities and places it is
-- about (packages/contracts/src/game-knowledge.ts), set when it's saved. NULL means "not tagged
-- yet" (entries from before this), which the worker fills in the background.
ALTER TABLE observations ADD COLUMN tags text[];
CREATE INDEX observations_tags_idx ON observations USING gin (tags);
