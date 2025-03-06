const axios = require("axios");
const fs = require("fs");
const schedule = require("node-schedule");
require("dotenv").config();
const { Telegraf } = require("telegraf");

const DATA_FILE = "quran_data.json";
const API_URL = "https://api.alquran.cloud/v1/page/";
const BOT_TOKEN = process.env.BOT_TOKEN;
const USER_CHAT_ID = process.env.USER_CHAT_ID;
const bot = new Telegraf(BOT_TOKEN);

// Интервалы повторения (Сабак → Сабки → Манзиль)
const intervals = {
  sabak: [1, 3, 7],     // 1, 3, 7 дней — интенсивное повторение нового
  sabki: [14, 30],      // 2 недели, 1 месяц — среднесрочное повторение
  manzil: [90, 180]     // 3 месяца, 6 месяцев — долговременное повторение
};

// Функция получения аятов по странице
async function fetchAyahsByPage(pageNumber) {
  try {
    const response = await axios.get(`${API_URL}${pageNumber}/quran-uthmani`);
    return response.data.data.ayahs.map(ayah => ({
      number: ayah.number,
      text: ayah.text,
      surah: ayah.surah.number,
      ayah: ayah.numberInSurah,
      page: pageNumber,
      nextReview: new Date(),
      reviewStage: "sabak", // Начинаем с нового заучивания
      reviewStep: 0 // Индекс в интервалах
    }));
  } catch (error) {
    console.error("Ошибка получения данных:", error);
    return [];
  }
}

// Функция загрузки данных
function loadData() {
  if (!fs.existsSync(DATA_FILE)) return [];
  return JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
}

// Функция сохранения данных
function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// Добавление новой страницы для заучивания
async function addPageForMemorization(pageNumber) {
  let data = loadData();
  const newAyahs = await fetchAyahsByPage(pageNumber);
  data = [...data, ...newAyahs];
  saveData(data);
  console.log(`Страница ${pageNumber} добавлена.`);
}

// Получение аятов для повторения
function getAyahsForReview() {
  const today = new Date();
  return loadData().filter(ayah => new Date(ayah.nextReview) <= today);
}

async function addPageForMemorization(pageNumber) {
  let data = loadData();
  const newAyahs = await fetchAyahsByPage(pageNumber);
  
  if (newAyahs.length === 0) {
    console.log(`❌ Страница ${pageNumber} не найдена.`);
    return;
  }

  data = [...data, ...newAyahs];
  saveData(data);
  console.log(`✅ Страница ${pageNumber} добавлена.`);
}

// Обновление расписания повторений
function updateReviewSchedule() {
  let data = loadData();
  const today = new Date();

  data.forEach(ayah => {
    if (new Date(ayah.nextReview) <= today) {
      // Определяем текущий интервал
      let reviewSteps = intervals[ayah.reviewStage];
      if (ayah.reviewStep >= reviewSteps.length - 1) {
        // Если прошли все шаги текущего уровня, переходим на следующий
        if (ayah.reviewStage === "sabak") ayah.reviewStage = "sabki";
        else if (ayah.reviewStage === "sabki") ayah.reviewStage = "manzil";
        ayah.reviewStep = 0;
      } else {
        ayah.reviewStep++;
      }
      // Устанавливаем дату следующего повторения
      ayah.nextReview = new Date();
      ayah.nextReview.setDate(today.getDate() + intervals[ayah.reviewStage][ayah.reviewStep]);
    }
  });

  saveData(data);
}

// Telegram-бот: отправка аятов для повторения
bot.command("review", async (ctx) => {
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
  const args = ctx.message.text.split(" ");
  if (args.length < 2) {
    return ctx.reply("❌ Используйте команду так: /addpage <номер_страницы>");
  }

  const pageNumber = parseInt(args[1]);
  if (isNaN(pageNumber) || pageNumber < 1 || pageNumber > 604) {
    return ctx.reply("❌ Укажите номер страницы от 1 до 604.");
  }

  await addPageForMemorization(pageNumber);
  ctx.reply(`✅ Страница ${pageNumber} добавлена в план заучивания!`);
});

// Планировщик для обновления повторений
schedule.scheduleJob("0 6 * * *", () => { // Запуск каждый день в 6:00 утра
  console.log("Обновление статуса повторения...");
  updateReviewSchedule();
});

// Запуск программы
//(async () => {
//  const page = 1; // Укажите номер страницы
//  await addPageForMemorization(page);
//  console.log("Аяты на повторение сегодня:", getAyahsForReview());
//  bot.launch();
//})();

bot.launch()