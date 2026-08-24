import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

export async function createTestFixture() {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "krouter-erasure-test-")
  );

  const memoryDir = path.join(root, ".krouter_memory");
  const dataDir = path.join(root, ".krouter_data");

  await fs.mkdir(memoryDir, { recursive: true });
  await fs.mkdir(dataDir, { recursive: true });

  const personalPath = path.join(memoryDir, "personal.json");
  const emotionalPath = path.join(memoryDir, "emotional.json");
  const databasePath = path.join(dataDir, "krouter.db");

  await fs.writeFile(
    personalPath,
    JSON.stringify(
      {
        test: true,
        value: "PERSONAL_TEST_SECRET",
      },
      null,
      2
    )
  );

  await fs.writeFile(
    emotionalPath,
    JSON.stringify(
      {
        test: true,
        value: "EMOTIONAL_TEST_SECRET",
      },
      null,
      2
    )
  );

  const db = new Database(databasePath);

  db.exec(`
    CREATE TABLE agent_learning (
      id INTEGER PRIMARY KEY,
      content TEXT
    );

    CREATE TABLE agent_decisions (
      id INTEGER PRIMARY KEY,
      content TEXT
    );

    CREATE TABLE agent_projects (
      id INTEGER PRIMARY KEY,
      content TEXT
    );

    CREATE TABLE conversations (
      id INTEGER PRIMARY KEY,
      content TEXT
    );

    CREATE TABLE usage_logs (
      id INTEGER PRIMARY KEY,
      content TEXT
    );

    INSERT INTO agent_learning (content)
    VALUES ('LEARNING_TEST_SECRET');

    INSERT INTO agent_decisions (content)
    VALUES ('DECISION_TEST_SECRET');

    INSERT INTO agent_projects (content)
    VALUES ('PROJECT_TEST_SECRET');

    INSERT INTO conversations (content)
    VALUES ('CONVERSATION_SHOULD_SURVIVE');

    INSERT INTO usage_logs (content)
    VALUES ('USAGE_LOG_SHOULD_SURVIVE');
  `);

  db.close();

  return {
    root,
    memoryDir,
    dataDir,
    personalPath,
    emotionalPath,
    databasePath,
  };
}

export async function removeTestFixture(fixture) {
  await fs.rm(fixture.root, {
    recursive: true,
    force: true,
  });
}
