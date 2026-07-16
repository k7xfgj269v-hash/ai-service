'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { IndexFlatL2 } = require('faiss-node');

function smokeSqlite() {
  const database = new Database(':memory:');

  try {
    database.exec(`
      CREATE VIRTUAL TABLE documents USING fts5(
        content,
        tokenize = 'trigram'
      );
      INSERT INTO documents(content)
      VALUES ('enterprise retrieval with persistent context');
    `);

    const match = database
      .prepare('SELECT rowid FROM documents WHERE documents MATCH ?')
      .get('trieval');

    assert.equal(match?.rowid, 1, 'SQLite FTS5 trigram search failed');

    return database.prepare('SELECT sqlite_version() AS version').get().version;
  } finally {
    database.close();
  }
}

function smokeFaiss() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'faiss-smoke-'));
  const indexPath = path.join(directory, 'smoke.index');

  try {
    const index = new IndexFlatL2(3);
    index.add([1, 0, 0]);
    index.add([0, 1, 0]);
    index.add([0, 0, 1]);

    const initial = index.search([0.9, 0.1, 0], 2);
    assert.equal(index.ntotal(), 3, 'FAISS add failed');
    assert.equal(initial.labels[0], 0, 'FAISS search returned the wrong neighbor');

    index.write(indexPath);
    assert.ok(fs.statSync(indexPath).size > 0, 'FAISS save produced an empty index');

    const loaded = IndexFlatL2.read(indexPath);
    const restored = loaded.search([0, 0, 0.9], 1);
    assert.equal(loaded.getDimension(), 3, 'FAISS load changed the dimension');
    assert.equal(loaded.ntotal(), 3, 'FAISS load changed the vector count');
    assert.equal(restored.labels[0], 2, 'Loaded FAISS index search failed');

    return {
      dimension: loaded.getDimension(),
      vectors: loaded.ntotal(),
    };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

try {
  const result = {
    sqlite: {
      version: smokeSqlite(),
      fts5Trigram: true,
    },
    faiss: smokeFaiss(),
  };

  console.log(JSON.stringify(result));
} catch (error) {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
}
