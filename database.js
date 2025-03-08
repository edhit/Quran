// database.js
const sqlite3 = require("sqlite3").verbose();
const path = require("path");

const DB_PATH = path.join(__dirname, "quran_bot.db");

const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    console.error("Ошибка при подключении к базе данных:", err.message);
  } else {
    console.log("Подключение к базе данных SQLite успешно установлено.");
    initializeDatabase();
  }
});

function initializeDatabase() {
  db.serialize(() => {
    // Таблица пользователей
    db.run(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT UNIQUE NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Таблица аятов
    db.run(`
      CREATE TABLE IF NOT EXISTS ayahs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        number INTEGER NOT NULL,
        text TEXT NOT NULL,
        surah INTEGER NOT NULL,
        ayah INTEGER NOT NULL,
        page INTEGER NOT NULL,
        next_review DATETIME NOT NULL,
        review_stage TEXT NOT NULL,
        review_step INTEGER NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users (id)
      )
    `);

    // Таблица аудиофайлов
    db.run(`
      CREATE TABLE IF NOT EXISTS audio_files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ayah_id INTEGER NOT NULL,
        reciter TEXT NOT NULL,
        file_id TEXT NOT NULL,
        FOREIGN KEY (ayah_id) REFERENCES ayahs (id)
      )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS ayah_texts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          surah INTEGER NOT NULL,
          ayah INTEGER NOT NULL,
          text TEXT NOT NULL,
          page INTEGER NOT NULL,
          UNIQUE(surah, ayah)
        )
      `);
  });
}

module.exports = db;