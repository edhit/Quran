const axios = require("axios");
const fs = require("fs");
const schedule = require("node-schedule");
require("dotenv").config();
const { Telegraf } = require("telegraf");
const { createLogger, format, transports } = require("winston");

const DATA_FILE = "quran_data.json";
const API_URL = "https://api.alquran.cloud/v1/page/";
const BOT_TOKEN = process.env.BOT_TOKEN;
const USER_CHAT_ID = process.env.USER_CHAT_ID;
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

function isAuthorizedUser(chatId) {
  return chatId == USER_CHAT_ID;
}

async function fetchAyahsByPage(pageNumber) {
  try {
    const response = await axios.get(`${API_URL}${pageNumber}/quran-uthmani`);
    if (!response.data || !response.data.data || !response.data.data.ayahs) {
      throw new Error("Некорректный ответ от API");
    }
    return response.data.data.ayahs.map(ayah => ({
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

function loadData() {
  if (!fs.existsSync(DATA_FILE)) {
    return []; // Возвращаем пустой массив, если файл не существует
  }
  return JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
}

function backupData() {
  if (!fs.existsSync(DATA_FILE)) {
    // Если файл не существует, создаем его с пустым массивом
    fs.writeFileSync(DATA_FILE, JSON.stringify([]));
    logger.info(`Файл ${DATA_FILE} создан.`);
    return;
  }

  // Если файл существует, создаем резервную копию
  const backupFile = `quran_data_backup_${new Date().toISOString()}.json`;
  fs.copyFileSync(DATA_FILE, backupFile);
  logger.info(`Создана резервная копия: ${backupFile}`);
}

function saveData(data) {
  backupData(); // Создаем резервную копию (или файл, если он не существует)
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

async function addPageForMemorization(pageNumber) {
  let data = loadData();
  const newAyahs = await fetchAyahsByPage(pageNumber);
  
  if (newAyahs.length === 0) {
    logger.warn(`Страница ${pageNumber} не найдена.`);
    return;
  }

  data = [...data, ...newAyahs];
  saveData(data);
  logger.info(`Страница ${pageNumber} добавлена.`);
}

function getAyahsForReview() {
  const today = new Date();
  return loadData().filter(ayah => new Date(ayah.nextReview) <= today);
}

function updateReviewSchedule() {
  let data = loadData();
  const today = new Date();

  data.forEach(ayah => {
    if (new Date(ayah.nextReview) <= today) {
      let reviewSteps = intervals[ayah.reviewStage];
      if (ayah.reviewStep >= reviewSteps.length - 1) {
        if (ayah.reviewStage === "sabak") ayah.reviewStage = "sabki";
        else if (ayah.reviewStage === "sabki") ayah.reviewStage = "manzil";
        ayah.reviewStep = 0;
      } else {
        ayah.reviewStep++;
      }
      ayah.nextReview = new Date();
      ayah.nextReview.setDate(today.getDate() + intervals[ayah.reviewStage][ayah.reviewStep]);
    }
  });

  saveData(data);
}

bot.command("review", async (ctx) => {
  if (!isAuthorizedUser(ctx.message.chat.id)) {
    return ctx.reply("❌ У вас нет доступа к этой команде.");
  }

  const ayahs = getAyahsForReview();
  if (ayahs.length === 0) {
    ctx.reply("Сегодня нет аятов для повторения.");
    return;
  }

  for (const ayah of ayahs) {
    await ctx.reply(`📖 ${ayah.surah}:${ayah.ayah} (стр. ${ayah.page})\n${ayah.text}`);
  }
});

bot.command("addpage", async (ctx) => {
  if (!isAuthorizedUser(ctx.message.chat.id)) {
    return ctx.reply("❌ У вас нет доступа к этой команде.");
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
    await addPageForMemorization(pageNumber);
    ctx.reply(`✅ Страница ${pageNumber} добавлена в план заучивания!`);
  } catch (error) {
    ctx.reply("❌ Произошла ошибка при добавлении страницы.");
    logger.error("Ошибка при добавлении страницы:", error);
  }
});

bot.command("list", async (ctx) => {
  if (!isAuthorizedUser(ctx.message.chat.id)) {
    return ctx.reply("❌ У вас нет доступа к этой команде.");
  }

  const data = loadData();
  if (data.length === 0) {
    return ctx.reply("❌ Нет данных для отображения.");
  }

  const pages = [...new Set(data.map(ayah => ayah.page))].sort((a, b) => a - b);
  ctx.reply(`📚 Страницы в процессе заучивания: ${pages.join(", ")}`);
});

bot.command("remove", async (ctx) => {
  if (!isAuthorizedUser(ctx.message.chat.id)) {
    return ctx.reply("❌ У вас нет доступа к этой команде.");
  }

  const args = ctx.message.text.split(" ");
  if (args.length < 2) {
    return ctx.reply("❌ Используйте команду так: /remove <номер_страницы>");
  }

  const pageNumber = parseInt(args[1]);
  if (!isValidPageNumber(pageNumber)) {
    return ctx.reply("❌ Укажите номер страницы от 1 до 604.");
  }

  let data = loadData();
  const initialLength = data.length;
  data = data.filter(ayah => ayah.page !== pageNumber);

  if (data.length === initialLength) {
    return ctx.reply(`❌ Страница ${pageNumber} не найдена в списке заучивания.`);
  }

  saveData(data);
  ctx.reply(`✅ Страница ${pageNumber} удалена из списка заучивания.`);
});

bot.command("update", async (ctx) => {
  if (!isAuthorizedUser(ctx.message.chat.id)) {
    return ctx.reply("❌ У вас нет доступа к этой команде.");
  }

  try {
    updateReviewSchedule();
    ctx.reply("✅ Расписание повторений обновлено.");
  } catch (error) {
    ctx.reply("❌ Произошла ошибка при обновлении расписания.");
    logger.error("Ошибка при обновлении расписания:", error);
  }
});

bot.command("help", (ctx) => {
    const helpMessage = `
  📚 *Инструкция по использованию бота:*
  
  /addpage <номер_страницы> — Добавить страницу для заучивания (например, /addpage 1).
  /review — Получить аяты для повторения на сегодня.
  /list — Показать все страницы, которые находятся в процессе заучивания.
  /remove <номер_страницы> — Удалить страницу из списка заучивания (например, /remove 1).
  /update — Обновить расписание повторений вручную.
  /help — Показать это сообщение.
  
  *Примеры:*
  - Добавить страницу 1: /addpage 1
  - Удалить страницу 1: /remove 1
  - Получить аяты для повторения: /review
  `;
  
    ctx.replyWithMarkdown(helpMessage);
  });

schedule.scheduleJob("0 6 * * *", () => {
  logger.info("Обновление статуса повторения...");
  updateReviewSchedule();
});

bot.launch();
logger.info("Бот запущен.");
