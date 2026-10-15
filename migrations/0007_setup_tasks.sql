-- phase: expand
-- The go-live setup hub's tasks each person has finished, once per task (server/streaming/setup-progress.js): the first
-- time a task reads as done, Live records it here and queues live.setup.task_completed in the same transaction, which
-- OpenVibe.Quest turns into quests. A task undone later (an emote deleted) stays recorded: the quest was earned.
CREATE TABLE IF NOT EXISTS live_setup_tasks (
    user_id      bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    task         text NOT NULL,
    completed_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, task)
);
