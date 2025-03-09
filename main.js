const axios = require("axios");
const fs = require("fs");
const schedule = require("node-schedule");
const NodeID3 = require("node-id3");
require("dotenv").config();
const { Telegraf } = require("telegraf");
const { createLogger, format, transports } = require("winston");
const db = require('./database')

const API_URL = "https://api.alquran.cloud/v1/page/";
const BOT_TOKEN = process.env.BOT_TOKEN;
const bot = new Telegraf(BOT_TOKEN);

const intervals = {
  sabak: [1, 3, 7],
  sabki: [14, 30],
  manzil: [90, 180]
};

const logger = createLogger({
  level: "info",
  format: format.combine(
    format.timestamp(),
    format.json()
  ),
  transports: [
    new transports.Console(),
    new transports.File({ filename: "bot.log" })
  ]
});

function isValidPageNumber(pageNumber) {
  return !isNaN(pageNumber) && pageNumber >= 1 && pageNumber <= 604;
}

function getAudioUrl(ayah, reciter) {
  const reciters = {
    husary: "ar.husary",
    alafasy: "ar.alafasy",
    abdulsamad: "ar.abdulsamad",
  };

  const reciterCode = reciters[reciter] || reciters.husary; // По умолчанию Хусари
  return `https://api.alquran.cloud/v1/ayah/${ayah.surah}:${ayah.ayah}/${reciterCode}`;
}

function formatAyahId(surah, ayah) {
  // Номер суры и аята дополняем нулями до 3 символов
  const surahPart = String(surah).padStart(3, "0");
  const ayahPart = String(ayah).padStart(3, "0");

  // Формируем окончательный ID: "1" + сура + аят
  return `1${surahPart}${ayahPart}`;
}

async function fetchAyahsByPage(pageNumber, startAyah, endAyah) {
  // Всегда сначала проверяем, есть ли аяты в таблице ayah_texts
  const cachedAyahs = await getAyahsFromDatabase(pageNumber, startAyah, endAyah);
  if (cachedAyahs.length > 0) {
    return cachedAyahs;
  }

  logger.info(`Аяты для страницы ${pageNumber} не найдены в базе данных. Делаем запрос к API...`);
  // Если аятов нет в базе данных, делаем запрос к API
  try {
    const response = await axios.get(`${API_URL}${pageNumber}/quran-uthmani`);
    if (!response.data || !response.data.data || !response.data.data.ayahs) {
      throw new Error("Некорректный ответ от API");
    }

    let filteredAyahs;
    if (startAyah && endAyah) {
      filteredAyahs = response.data.data.ayahs.filter(
        ayah => ayah.numberInSurah >= startAyah && ayah.numberInSurah <= endAyah
      );
    } else {
      filteredAyahs = response.data.data.ayahs;
    }

    // Сохраняем аяты в базу данных
    await saveAyahsToDatabase(filteredAyahs);

    return filteredAyahs.map(ayah => ({
      number: ayah.number,
      text: ayah.text,
      surah: ayah.surah.number,
      ayah: ayah.numberInSurah,
      page: pageNumber,
      nextReview: new Date(),
      reviewStage: "sabak",
      reviewStep: 0
    }));
  } catch (error) {
    logger.error(`Ошибка при получении данных для страницы ${pageNumber}:`, error.message);
    return [];
  }
}

async function addPageForMemorization(userId, pageNumber) {
  const newAyahs = await fetchAyahsByPage(pageNumber);
  if (newAyahs.length === 0) {
    logger.warn(`Страница ${pageNumber} не найдена.`);
    return;
  }

  const stmt = db.prepare(`
    INSERT INTO ayahs (user_id, number, text, surah, ayah, page, next_review, review_stage, review_step)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  newAyahs.forEach(ayah => {
    stmt.run(
      userId,
      ayah.number,
      '', // ayah.text,
      ayah.surah,
      ayah.ayah,
      ayah.page,
      ayah.nextReview.toISOString(),
      ayah.reviewStage,
      ayah.reviewStep
    );
  });

  stmt.finalize();
  logger.info(`Страница ${pageNumber} добавлена для пользователя ${userId}.`);
}

async function getUserByChatId(chatId) {
  return new Promise((resolve, reject) => {
    db.get("SELECT * FROM users WHERE chat_id = ?", [chatId], (err, row) => {
      if (err) {
        reject(err);
      } else {
        resolve(row);
      }
    });
  });
}

async function getAyahsForReview(userId) {
  return new Promise((resolve, reject) => {
    const today = new Date().toISOString();

    // Извлекаем аяты из таблицы ayahs и текст аятов из таблицы ayah_texts
    db.all(`
      SELECT 
        ayahs.id AS ayah_id,
        ayahs.user_id,
        ayahs.page,
        ayahs.next_review,
        ayahs.review_stage,
        ayahs.review_step,
        ayah_texts.surah,
        ayah_texts.ayah,
        ayah_texts.text -- Текст аята из таблицы ayah_texts
      FROM ayahs
      INNER JOIN ayah_texts 
        ON ayahs.page = ayah_texts.page 
        AND ayahs.ayah = ayah_texts.ayah -- Добавляем условие по номеру аята
      WHERE ayahs.user_id = ? AND ayahs.next_review <= ?
    `, [userId, today], (err, rows) => {
      if (err) {
        reject(err);
      } else {
        // Преобразуем данные в нужный формат
        const ayahs = rows.map(row => ({
          id: row.ayah_id, // Уникальный ID аята из таблицы ayahs
          user_id: row.user_id,
          page: row.page,
          surah: row.surah,
          ayah: row.ayah,
          text: row.text, // Текст аята из таблицы ayah_texts
          nextReview: new Date(row.next_review),
          reviewStage: row.review_stage,
          reviewStep: row.review_step
        }));
        resolve(ayahs);
      }
    });
  });
}

async function updateReviewSchedule(userId) {
  return new Promise((resolve, reject) => {
    const today = new Date().toISOString();

    // Получаем все аяты, которые нужно обновить
    db.all(`
      SELECT * FROM ayahs
      WHERE user_id = ? AND next_review <= ?
    `, [userId, today], (err, ayahs) => {
      if (err) {
        reject(err);
        return;
      }

      // Обновляем каждый аят
      const stmt = db.prepare(`
        UPDATE ayahs
        SET next_review = ?, review_stage = ?, review_step = ?
        WHERE id = ?
      `);

      ayahs.forEach(ayah => {
        let reviewSteps = intervals[ayah.review_stage];
        let newReviewStage = ayah.review_stage;
        let newReviewStep = ayah.review_step;

        if (newReviewStep >= reviewSteps.length - 1) {
          if (newReviewStage === "sabak") newReviewStage = "sabki";
          else if (newReviewStage === "sabki") newReviewStage = "manzil";
          newReviewStep = 0;
        } else {
          newReviewStep++;
        }

        const nextReviewDate = new Date();
        nextReviewDate.setDate(nextReviewDate.getDate() + intervals[newReviewStage][newReviewStep]);

        stmt.run(
          nextReviewDate.toISOString(),
          newReviewStage,
          newReviewStep,
          ayah.id
        );
      });

      stmt.finalize();
      resolve();
    });
  });
}

async function sendReviewAyahs(userId, chatId, reciter = null, notification = false) {
  const ayahs = await getAyahsForReview(userId);
  if (ayahs.length === 0) {
    logger.info("Сегодня нет аятов для повторения.");
    await bot.telegram.sendMessage(chatId, "Сегодня нет аятов для повторения.");
    return;
  }

  if (notification) {
    logger.info("Проверьте наличие аятов для повторения. /review");
    await bot.telegram.sendMessage(chatId, "Проверьте наличие аятов для повторения. /review");
    return;
  }

  for (const ayah of ayahs) {
    try {
      const messageText = `📖 *${ayah.surah}:${ayah.ayah}* (стр. ${ayah.page})\n${ayah.text}`;
      // Если чтец не указан, отправляем только текст
      if (!reciter) {
        await bot.telegram.sendMessage(chatId, messageText, { parse_mode: "Markdown" });
        continue;
      }
      
      // Получаем file_id аудио из базы данных
      let fileId = await getAudioFileId(ayah.surah, ayah.ayah, reciter);

      // Если file_id нет, загружаем аудио и сохраняем его file_id
      let messageId = false;
      if (!fileId) {
        let audio = await uploadAndSaveAudio(ayah, chatId, reciter);
        fileId = audio.fileId
        messageId = audio.messageId
      }

      // Отправляем аудио и текст
      await sendAudioWithCaption(chatId, fileId, messageText, messageId);

    } catch (error) {
      logger.error(`Ошибка при отправке аята ${ayah.surah}:${ayah.ayah}:`, error);
      await bot.telegram.sendMessage(chatId, `📖 ${ayah.surah}:${ayah.ayah} (стр. ${ayah.page})\n${ayah.text}`);
    }
  }
}

/**
 * Загружает аудио, отправляет его пользователю и сохраняет file_id в базу данных.
 */
async function uploadAndSaveAudio(ayah, chatId, reciter) {
  const audioUrl = getAudioUrl(ayah, reciter);
  const response = await axios.get(audioUrl);
  const audioLink = response.data.data.audio;

  const filePath = `ayah_${ayah.surah}_${ayah.ayah}.mp3`;
  const writer = fs.createWriteStream(filePath);
  const audioResponse = await axios.get(audioLink, { responseType: "stream" });
  audioResponse.data.pipe(writer);

  await new Promise((resolve, reject) => {
    writer.on("finish", resolve);
    writer.on("error", reject);
  });

  // Добавляем метаданные к аудио
  const tags = {
    title: `Сура ${ayah.surah}, Аят ${ayah.ayah}`,
    artist: `Шейх ${reciter.charAt(0).toUpperCase() + reciter.slice(1)}`,
    album: "Holy Quran",
    comment: { text: "Из AlQuran Cloud API" },
  };
  NodeID3.write(tags, filePath);

  // Отправляем аудио пользователю
  const audioMessage = await bot.telegram.sendAudio(chatId, { source: filePath });
  const fileId = audioMessage.audio.file_id;

  // Формируем ayah_id в нужном формате
  const ayahId = formatAyahId(ayah.surah, ayah.ayah);
  // Сохраняем file_id в базу данных
  db.run(`
    INSERT INTO audio_files (ayah_id, reciter, file_id)
    VALUES (?, ?, ?)
  `, [ayahId, reciter, fileId]);

  // Удаляем временный файл
  fs.unlinkSync(filePath);

  return {
    fileId: fileId, 
    messageId: audioMessage.message_id
  };
}

/**
 * Отправляет аудио с подписью или текстом отдельным сообщением, если подпись слишком длинная.
 */
async function sendAudioWithCaption(chatId, fileId, messageText, messageId) {
  if (messageId) {
    await bot.telegram.sendMessage(chatId, messageText, {
      reply_to_message_id: messageId,
      parse_mode: "Markdown",
    });

    return;
  }

  const maxCaptionLength = 1024;

  if (messageText.length <= maxCaptionLength) {
    // Если текст короткий, отправляем аудио с подписью
    await bot.telegram.sendAudio(chatId, fileId, {
      caption: messageText,
      parse_mode: "Markdown",
    });
  } else {
    // Если текст длинный, отправляем аудио без подписи, а текст отдельным сообщением
    const audioMessage = await bot.telegram.sendAudio(chatId, fileId);
    await bot.telegram.sendMessage(chatId, messageText, {
      reply_to_message_id: audioMessage.message_id,
      parse_mode: "Markdown",
    });
  }
}

async function createUser(chatId) {
  return new Promise((resolve, reject) => {
    db.run("INSERT INTO users (chat_id) VALUES (?)", [chatId], function (err) {
      if (err) {
        reject(err);
      } else {
        resolve(this.lastID); // Возвращаем ID нового пользователя
      }
    });
  });
}

async function getAudioFileId(surah, ayah, reciter) {
  const ayahId = formatAyahId(surah, ayah);
  return new Promise((resolve, reject) => {
    db.get(`
      SELECT file_id FROM audio_files
      WHERE ayah_id = ? AND reciter = ?
    `, [ayahId, reciter], (err, row) => {
      if (err) {
        reject(err);
      } else {
        resolve(row ? row.file_id : null);
      }
    });
  });
}

async function getAyahsByUser(userId) {
  return new Promise((resolve, reject) => {
    db.all("SELECT * FROM ayahs WHERE user_id = ?", [userId], (err, rows) => {
      if (err) {
        reject(err);
      } else {
        resolve(rows);
      }
    });
  });
}

async function removePageForUser(userId, pageNumber) {
  return new Promise((resolve, reject) => {
    db.run("DELETE FROM ayahs WHERE user_id = ? AND page = ?", [userId, pageNumber], function (err) {
      if (err) {
        reject(err);
      } else {
        resolve(this.changes); // Возвращаем количество удаленных строк
      }
    });
  });
}

async function getProgressForUser(userId) {
  return new Promise((resolve, reject) => {
    db.all(`
      SELECT page, review_stage, COUNT(*) as count
      FROM ayahs
      WHERE user_id = ?
      GROUP BY page, review_stage
    `, [userId], (err, rows) => {
      if (err) {
        reject(err);
      } else {
        const progress = {};
        rows.forEach(row => {
          if (!progress[row.page]) {
            progress[row.page] = { total: 0, sabak: 0, sabki: 0, manzil: 0 };
          }
          progress[row.page].total += row.count;
          progress[row.page][row.review_stage] += row.count;
        });
        resolve(progress);
      }
    });
  });
}

async function getAllUsers() {
  return new Promise((resolve, reject) => {
    db.all("SELECT * FROM users", (err, rows) => {
      if (err) {
        reject(err);
      } else {
        resolve(rows);
      }
    });
  });
}

async function getAyahsFromDatabase(pageNumber, startAyah, endAyah) {
  return new Promise((resolve, reject) => {
    let query = `
      SELECT * FROM ayah_texts
      WHERE page = ?
    `;
    const params = [pageNumber];

    if (startAyah && endAyah) {
      query += ` AND ayah BETWEEN ? AND ?`;
      params.push(startAyah, endAyah);
    }

    db.all(query, params, (err, rows) => {
      if (err) {
        reject(err);
      } else {
        resolve(rows.map(row => ({
          number: row.id, // Используем id как уникальный номер
          text: row.text,
          surah: row.surah,
          ayah: row.ayah,
          page: row.page,
          nextReview: new Date(),
          reviewStage: "sabak",
          reviewStep: 0
        })));
      }
    });
  });
}

async function saveAyahsToDatabase(ayahs) {
  const stmt = db.prepare(`
    INSERT INTO ayah_texts (surah, ayah, text, page)
    VALUES (?, ?, ?, ?)
  `);

  ayahs.forEach(ayah => {
    stmt.run(
      ayah.surah.number,
      ayah.numberInSurah,
      ayah.text,
      ayah.page
    );
  });

  stmt.finalize();
}

// Команда /review
bot.command("review", async (ctx) => {
  const chatId = ctx.message.chat.id;
  const user = await getUserByChatId(chatId);
  if (!user) {
    return ctx.reply("❌ Пользователь не найден. Используйте /start для регистрации.");
  }

  const args = ctx.message.text.split(" ");
  const reciter = args[1] || null;

  await sendReviewAyahs(user.id, chatId, reciter);
});

// Расписание для автоматической отправки в 6 утра
schedule.scheduleJob("0 3 * * *", async () => {
  logger.info("Обновление статуса повторения и отправка аятов...");

  // Получаем всех пользователей
  const users = await getAllUsers();
  for (const user of users) {
    try {
      await updateReviewSchedule(user.id);
      await sendReviewAyahs(user.id, user.chat_id, null, true);
    } catch (error) {
      logger.error(`Ошибка при обработке пользователя ${user.chat_id}:`, error);
    }
  }
});

bot.command("addpage", async (ctx) => {
  const chatId = ctx.message.chat.id;
  const user = await getUserByChatId(chatId);
  if (!user) {
    return ctx.reply("❌ Пользователь не найден. Используйте /start для регистрации.");
  }

  const args = ctx.message.text.split(" ");
  if (args.length < 2) {
    return ctx.reply("❌ Используйте команду так: /addpage <номер_страницы>");
  }

  const pageNumber = parseInt(args[1]);
  if (!isValidPageNumber(pageNumber)) {
    return ctx.reply("❌ Укажите номер страницы от 1 до 604.");
  }

  try {
    await addPageForMemorization(user.id, pageNumber);
    ctx.reply(`✅ Страница ${pageNumber} добавлена в план заучивания!`);
  } catch (error) {
    ctx.reply("❌ Произошла ошибка при добавлении страницы.");
    logger.error("Ошибка при добавлении страницы:", error);
  }
});

bot.command("list", async (ctx) => {
  const chatId = ctx.message.chat.id;
  const user = await getUserByChatId(chatId);
  if (!user) {
    return ctx.reply("❌ Пользователь не найден. Используйте /start для регистрации.");
  }

  const data = await getAyahsByUser(user.id);
  if (data.length === 0) {
    return ctx.reply("❌ Нет данных для отображения.");
  }

  const pages = [...new Set(data.map(ayah => ayah.page))].sort((a, b) => a - b);
  ctx.reply(`📚 Страницы в процессе заучивания: ${pages.join(", ")}`);
});

bot.command("remove", async (ctx) => {
  const chatId = ctx.message.chat.id;
  const user = await getUserByChatId(chatId);
  if (!user) {
    return ctx.reply("❌ Пользователь не найден. Используйте /start для регистрации.");
  }

  const args = ctx.message.text.split(" ");
  if (args.length < 2) {
    return ctx.reply("❌ Используйте команду так: /remove <номер_страницы>");
  }

  const pageNumber = parseInt(args[1]);
  if (!isValidPageNumber(pageNumber)) {
    return ctx.reply("❌ Укажите номер страницы от 1 до 604.");
  }

  try {
    await removePageForUser(user.id, pageNumber);
    ctx.reply(`✅ Страница ${pageNumber} удалена из списка заучивания.`);
  } catch (error) {
    ctx.reply("❌ Произошла ошибка при удалении страницы.");
    logger.error("Ошибка при удалении страницы:", error);
  }
});

bot.command("progress", async (ctx) => {
  const chatId = ctx.message.chat.id;
  const user = await getUserByChatId(chatId);
  if (!user) {
    return ctx.reply("❌ Пользователь не найден. Используйте /start для регистрации.");
  }

  const progress = await getProgressForUser(user.id);
  if (Object.keys(progress).length === 0) {
    return ctx.reply("❌ Нет данных для отображения.");
  }

  let message = "📊 <b>Прогресс заучивания:</b>\n";
  Object.keys(progress).sort((a, b) => a - b).forEach(page => {
    message += `\n📖 <b>Страница ${page}:</b>\n`;
    message += `- Всего аятов: ${progress[page].total}\n`;
    message += `- Сабак: ${progress[page].sabak}\n`;
    message += `- Сабки: ${progress[page].sabki}\n`;
    message += `- Манзиль: ${progress[page].manzil}\n`;
  });

  ctx.replyWithHTML(message);
});

bot.command("update", async (ctx) => {
  const chatId = ctx.message.chat.id;
  const user = await getUserByChatId(chatId);
  if (!user) {
    return ctx.reply("❌ Пользователь не найден. Используйте /start для регистрации.");
  }

  try {
    await updateReviewSchedule(user.id);
    ctx.reply("✅ Расписание повторений обновлено.");
  } catch (error) {
    ctx.reply("❌ Произошла ошибка при обновлении расписания.");
    logger.error("Ошибка при обновлении расписания:", error);
  }
});

bot.command("reciters", async (ctx) => {
  const message = `
🎙 <b>Доступные чтецы:</b>
- <b>husary</b>: Шейх Махмуд Халиль аль-Хусари
- <b>alafasy</b>: Шейх Мишари Рашид аль-Афаси
- <b>abdulsamad</b>: Шейх Абдур-Рахман ас-Судаис
  `;

  ctx.replyWithHTML(message);
});

bot.command("start", async (ctx) => {
  const chatId = ctx.message.chat.id;

  // Проверяем, существует ли пользователь в базе данных
  const user = await getUserByChatId(chatId);
  if (!user) {
    // Если пользователя нет, создаем нового
    await createUser(chatId);
    logger.info(`Новый пользователь создан: ${chatId}`);
  }

  const welcomeMessage = `
👋 <b>Добро пожаловать в бота для заучивания Корана!</b>

Этот бот поможет вам систематизировать процесс заучивания Корана по методике <i>"Сабақ-Сабқи-Манзиль"</i>.

📚 <b>Основные команды:</b>
- <code>/addpage &lt;номер_страницы&gt;</code> — Добавить страницу для заучивания.
- <code>/review</code> — Получить аяты для повторения на сегодня.
- <code>/list</code> — Показать все страницы, которые находятся в процессе заучивания.
- <code>/remove &lt;номер_страницы&gt;</code> — Удалить страницу из списка заучивания.
- <code>/update</code> — Обновить расписание повторений вручную.
- <code>/progress</code> — Показать прогресс заучивания.
- <code>/reciters</code> — Список доступных чтецов.
- <code>/help</code> — Подробная инструкция и информация о программе.

📅 <b>Аяты для повторения приходят каждый день в 6:00 утра.</b>

<b>Примеры использования:</b>
- Добавить страницу 1: <code>/addpage 1</code>
- Удалить страницу 1: <code>/remove 1</code>
- Получить аяты для повторения: <code>/review</code>

Для получения дополнительной информации используйте команду <code>/help</code>.
`;

  await ctx.replyWithHTML(welcomeMessage);
});

bot.command("help", async (ctx) => {
  const helpMessage = `
📚 <b>Инструкция по использованию бота:</b>

<b>1. Основные команды:</b>
- <code>/addpage &lt;номер_страницы&gt;</code> — Добавить страницу для заучивания (например, <code>/addpage 1</code>).
- <code>/review</code> — Получить аяты для повторения на сегодня.
- <code>/list</code> — Показать все страницы, которые находятся в процессе заучивания.
- <code>/remove &lt;номер_страницы&gt;</code> — Удалить страницу из списка заучивания (например, <code>/remove 1</code>).
- <code>/update</code> — Обновить расписание повторений вручную.
- <code>/progress</code> — Показать прогресс заучивания.
- <code>/reciters</code> — Список доступных чтецов.
- <code>/help</code> — Показать это сообщение.

<b>2. Программа заучивания:</b>
Бот использует методику <i>"Сабақ-Сабқи-Манзиль"</i>:
- <b>Сабақ</b>: Новые аяты заучиваются с интервалами повторения: 1, 3 и 7 дней.
- <b>Сабқи</b>: После завершения этапа "Сабақ" аяты повторяются с интервалами: 14 и 30 дней.
- <b>Манзиль</b>: На финальном этапе аяты повторяются каждые 90 и 180 дней.

<b>3. Время отправки:</b>
- Аяты для повторения приходят каждый день в <b>6:00 утра</b>.
- Вы можете запросить аяты для повторения в любое время с помощью команды <code>/review</code>.

<b>4. Примеры использования:</b>
- Добавить страницу 1: <code>/addpage 1</code>
- Удалить страницу 1: <code>/remove 1</code>
- Получить аяты: <code>/review</code>

<b>5. Дополнительные функции:</b>
- <code>/progress</code> — Показывает прогресс заучивания по каждой странице.
- <code>/reciters</code> — Список доступных чтецов и их стилей.

Если у вас есть вопросы, напишите <code>/start</code> для получения основной информации.
`;

  try {
    await ctx.replyWithHTML(helpMessage);
  } catch (error) {
    console.error("Ошибка при отправке сообщения:", error);
    await ctx.reply("Произошла ошибка при отправке инструкции. Пожалуйста, попробуйте еще раз.");
  }
});

bot.launch();
logger.info("Бот запущен.");