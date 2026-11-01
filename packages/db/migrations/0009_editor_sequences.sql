-- Studio editor: several timelines ("sequences") per edit project.
--
-- The main sequence stays in `edit_projects.edl`, so every existing project is a one-sequence
-- project and nothing else changes. `sequences` holds the main sequence's name and the other
-- timelines, each a complete edit of its own (see ProjectSequences in packages/contracts):
--   { "mainName": "Main", "extra": [ { "id": "s1", "name": "Widescreen", "edl": { ... } } ] }

ALTER TABLE edit_projects ADD COLUMN sequences jsonb NOT NULL DEFAULT '{}'::jsonb;
