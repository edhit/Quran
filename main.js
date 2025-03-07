const axios = require("axios");
const fs = require("fs");
const schedule = require("node-schedule");
const NodeID3 = require("node-id3");
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

async function fetchAyahsByPage(pageNumber, startAyah, endAyah) {
  try {
    const response = await axios.get(`${API_URL}${pageNumber}/quran-uthmani`);
    if (!response.data || !response.data.data || !response.data.data.ayahs) {
      throw new Error("Некорректный ответ от API");
    }

    let filteredAyahs;
    // Фильтруем аяты по диапазону
    if (startAyah && endAyah) {
      filteredAyahs = response.data.data.ayahs.filter(
        ayah => ayah.numberInSurah >= startAyah && ayah.numberInSurah <= endAyah
      );  
    } else {
      filteredAyahs = response.data.data.ayahs;
    }

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

function loadData() {
  if (!fs.existsSync(DATA_FILE)) {
    return []; // Возвращаем пустой массив, если файл не существует
  }
  return JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
}

function deleteOldBackups() {
  const backupFiles = fs.readdirSync(".").filter(file => file.startsWith("quran_data_backup_"));
  if (backupFiles.length > 5) { // Оставляем только последние 5 резервных копий
    backupFiles.sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs); // Сортируем по дате создания
    const filesToDelete = backupFiles.slice(0, backupFiles.length - 5); // Удаляем все, кроме последних 5
    filesToDelete.forEach(file => {
      fs.unlinkSync(file);
      logger.info(`Старая резервная копия удалена: ${file}`);
    });
  }
}

function backupData() {
  if (!fs.existsSync(DATA_FILE)) {
    // Если файл не существует, создаем его с пустым массивом
    fs.writeFileSync(DATA_FILE, JSON.stringify([]));
    logger.info(`Файл ${DATA_FILE} создан.`);
    return;
  }

  // Удаляем старые резервные копии
  deleteOldBackups();

  // Создаем новую резервную копию
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

function getAudioUrl(ayah, reciter) {
  const reciters = {
    husary: "ar.husary",
    alafasy: "ar.alafasy",
    abdulsamad: "ar.abdulsamad",
  };

  const reciterCode = reciters[reciter] || reciters.husary; // По умолчанию Хусари
  return `https://api.alquran.cloud/v1/ayah/${ayah.surah}:${ayah.ayah}/${reciterCode}`;
}

bot.command("review", async (ctx) => {
  if (!isAuthorizedUser(ctx.message.chat.id)) {
    return ctx.reply("❌ У вас нет доступа к этой команде.");
  }

  const args = ctx.message.text.split(" ");
  const reciter = args[1] || "husary"; // По умолчанию Хусари

  const ayahs = getAyahsForReview();
  if (ayahs.length === 0) {
    return ctx.reply("Сегодня нет аятов для повторения.");
  }

  for (const ayah of ayahs) {
    try {
      // Получаем ссылку на аудио
      const audioUrl = getAudioUrl(ayah, reciter);
      const response = await axios.get(audioUrl);
      const audioLink = response.data.data.audio;

      // Загружаем файл
      const filePath = `ayah_${ayah.surah}_${ayah.ayah}.mp3`;
      const writer = fs.createWriteStream(filePath);
      const audioResponse = await axios.get(audioLink, { responseType: "stream" });
      audioResponse.data.pipe(writer);

      await new Promise((resolve, reject) => {
        writer.on("finish", resolve);
        writer.on("error", reject);
      });

      // Устанавливаем новые метаданные
      const tags = {
        title: `Сура ${ayah.surah}, Аят ${ayah.ayah}`,
        artist: `Шейх ${reciter.charAt(0).toUpperCase() + reciter.slice(1)}`, // Имя чтеца
        album: "Holy Quran",
        comment: { text: "Из AlQuran Cloud API" },
      };
      NodeID3.write(tags, filePath);

      // Формируем текст
      const messageText = `📖 *${ayah.surah}:${ayah.ayah}* (стр. ${ayah.page})\n${ayah.text}`;

      try {
        // Пробуем отправить аудио с подписью
        await ctx.replyWithAudio({ source: filePath }, {
          caption: messageText,
          parse_mode: "Markdown",
        });
      } catch (error) {
        if (error.response && error.response.error_code === 400 && error.response.description.includes("message caption is too long")) {
          // Если ошибка из-за длинного текста — отправляем аудио без подписи
          const audioMessage = await ctx.replyWithAudio({ source: filePath });

          // Затем отправляем текст как ответ на аудио
          await ctx.reply(messageText, { reply_to_message_id: audioMessage.message_id, parse_mode: "Markdown" });
        } else {
          throw error; // Если ошибка другая — пробрасываем её дальше
        }
      }

      // Удаляем временный файл
      fs.unlinkSync(filePath);
      
    } catch (error) {
      console.error("Ошибка при обработке аята:", error);
      await ctx.reply(`📖 ${ayah.surah}:${ayah.ayah} (стр. ${ayah.page})\n${ayah.text}`);
    }
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

bot.command("addayah", async (ctx) => {
  if (!isAuthorizedUser(ctx.message.chat.id)) {
    return ctx.reply("❌ У вас нет доступа к этой команде.");
  }

  const args = ctx.message.text.split(" ");
  if (args.length < 4) {
    return ctx.reply("❌ Используйте команду так: /addayah <номер_страницы> <начальный_аят> <конечный_аят>");
  }

  const pageNumber = parseInt(args[1]);
  const startAyah = parseInt(args[2]);
  const endAyah = parseInt(args[3]);

  if (!isValidPageNumber(pageNumber) || isNaN(startAyah) || isNaN(endAyah)) {
    return ctx.reply("❌ Укажите корректные номера страницы и аятов.");
  }

  if (startAyah > endAyah) {
    return ctx.reply("❌ Начальный аят не может быть больше конечного.");
  }

  const newAyahs = await fetchAyahsByPage(pageNumber, startAyah, endAyah);
  if (newAyahs.length === 0) {
    return ctx.reply("❌ Аяты не найдены.");
  }

  let data = loadData();
  data = [...data, ...newAyahs];
  saveData(data);
  ctx.reply(`✅ Аяты ${startAyah}-${endAyah} со страницы ${pageNumber} добавлены.`);
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

bot.command("progress", async (ctx) => {
  if (!isAuthorizedUser(ctx.message.chat.id)) {
    return ctx.reply("❌ У вас нет доступа к этой команде.");
  }

  const data = loadData();
  if (data.length === 0) {
    return ctx.reply("❌ Нет данных для отображения.");
  }

  const progress = {};
  data.forEach(ayah => {
    if (!progress[ayah.page]) {
      progress[ayah.page] = { total: 0, sabak: 0, sabki: 0, manzil: 0 };
    }
    progress[ayah.page].total++;
    progress[ayah.page][ayah.reviewStage]++;
  });

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

bot.command("reciters", async (ctx) => {
  const message = `
🎙 <b>Доступные чтецы:</b>
- <b>husary</b>: Шейх Махмуд Халиль аль-Хусари
- <b>alafasy</b>: Шейх Мишари Рашид аль-Афаси
- <b>abdulsamad</b>: Шейх Абдур-Рахман ас-Судаис
  `;

  ctx.replyWithHTML(message);
});

bot.command("start", (ctx) => {
  const welcomeMessage = `
👋 <b>Добро пожаловать в бота для заучивания Корана!</b>

Этот бот поможет вам систематизировать процесс заучивания Корана по методике <i>"Сабақ-Сабқи-Манзиль"</i>.

📚 <b>Основные команды:</b>
- <code>/addpage &lt;номер_страницы&gt;</code> — Добавить страницу для заучивания.
- <code>/addayah &lt;номер_страницы&gt; &lt;начальный_аят&gt; &lt;конечный_аят&gt;</code> — Добавить аяты для заучивания.
- <code>/review [чтец]</code> — Получить аяты для повторения на сегодня.
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
- Получить аяты для повторения с чтецом Аль-Афаси: <code>/review alafasy</code>

Для получения дополнительной информации используйте команду <code>/help</code>.
`;

  ctx.replyWithHTML(welcomeMessage);
});
bot.command("help", async (ctx) => {
  const helpMessage = `
📚 <b>Инструкция по использованию бота:</b>

<b>1. Основные команды:</b>
- <code>/addpage &lt;номер_страницы&gt;</code> — Добавить страницу для заучивания (например, <code>/addpage 1</code>).
- <code>/addayah &lt;номер_страницы&gt; &lt;начальный_аят&gt; &lt;конечный_аят&gt;</code> — Добавить аяты для заучивания (например, <code>/addayah 1 1 10</code>).
- <code>/review [чтец]</code> — Получить аяты для повторения на сегодня. Доступные чтецы: <i>husary</i>, <i>alafasy</i>, <i>abdulsamad</i>.
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
- Получить аяты для повторения с чтецом Аль-Афаси: <code>/review alafasy</code>

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

schedule.scheduleJob("0 6 * * *", () => {
  logger.info("Обновление статуса повторения...");
  updateReviewSchedule();
});

bot.launch();
logger.info("Бот запущен.");