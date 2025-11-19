require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const sqlite3 = require('sqlite3').verbose();
const { Groq } = require('groq-sdk');
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs'); // Обычный fs для потоков
const fsPromises = require('fs').promises; // Промисы для удаления файлов

// --- КОНФИГУРАЦИЯ ---
const token = process.env.TELEGRAM_BOT_TOKEN;
const groqApiKey = process.env.GROQ_API_KEY;
const PORT = process.env.PORT || 3000;
const WEB_APP_URL = process.env.WEB_APP_URL || 'http://localhost:3000'; 

if (!token || !groqApiKey) {
  console.error('Error: TELEGRAM_BOT_TOKEN or GROQ_API_KEY is missing.');
  process.exit(1);
}

// Создаем папку для временных аудио, если нет
const TEMP_AUDIO_DIR = path.join(__dirname, 'temp_audio');
if (!fs.existsSync(TEMP_AUDIO_DIR)){
    fs.mkdirSync(TEMP_AUDIO_DIR);
}

// --- ИНИЦИАЛИЗАЦИЯ СЕРВИСОВ ---
const groq = new Groq({ apiKey: groqApiKey });
const bot = new TelegramBot(token, { polling: true });
const app = express();
const db = new sqlite3.Database('users.db');

// --- НАСТРОЙКА EXPRESS ---
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- БАЗА ДАННЫХ ---
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id INTEGER UNIQUE,
    username TEXT,
    first_name TEXT,
    last_name TEXT,
    generations INTEGER DEFAULT 5, 
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  
  db.run(`ALTER TABLE users ADD COLUMN generations INTEGER DEFAULT 5`, (err) => {
    if (err && !err.message.includes('duplicate column')) { }
  });

  db.run(`CREATE TABLE IF NOT EXISTS analytics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT,
    user_id INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  )`);
});

// --- ФУНКЦИИ БАЗЫ ДАННЫХ ---
function upsertUser(userId, username, firstName, lastName) {
  return new Promise((resolve, reject) => {
    db.get('SELECT id, generations FROM users WHERE telegram_id = ?', [userId], (err, row) => {
      if (err) return reject(err);
      if (row) {
        db.run('UPDATE users SET username = ?, first_name = ?, last_name = ? WHERE telegram_id = ?', 
          [username, firstName, lastName, userId], (err) => {
            if (err) reject(err);
            else resolve({ id: row.id, generations: row.generations, isNew: false });
          });
      } else {
        db.run('INSERT INTO users (telegram_id, username, first_name, last_name, generations) VALUES (?, ?, ?, ?, 5)',
          [userId, username, firstName, lastName], function(err) {
            if (err) return reject(err);
            const newId = this.lastID;
            db.run("INSERT INTO analytics (event_type, user_id) VALUES ('signup', ?)", [newId]);
            resolve({ id: newId, generations: 5, isNew: true });
          });
      }
    });
  });
}

function getUserGenerations(userId) {
  return new Promise((resolve, reject) => {
    db.get('SELECT generations FROM users WHERE telegram_id = ?', [userId], (err, row) => {
      if (err) reject(err);
      resolve(row ? row.generations : 0);
    });
  });
}

function decrementGeneration(userId) {
  return new Promise((resolve, reject) => {
    db.run('UPDATE users SET generations = generations - 1 WHERE telegram_id = ?', [userId], (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function addGenerations(userId, amount) {
  return new Promise((resolve, reject) => {
    db.run('UPDATE users SET generations = generations + ? WHERE telegram_id = ?', [amount, userId], function(err) {
      if (err) reject(err);
      else resolve(this.changes > 0);
    });
  });
}

function getAnalyticsData() {
  return new Promise((resolve, reject) => {
    const query = `
      SELECT 
        (SELECT COUNT(*) FROM analytics WHERE event_type = 'signup') as total_signups,
        (SELECT COUNT(*) FROM analytics WHERE event_type = 'signup' AND created_at >= datetime('now', '-1 day')) as daily_signups,
        (SELECT COUNT(*) FROM analytics WHERE event_type = 'signup' AND created_at >= datetime('now', '-7 days')) as weekly_signups
    `;
    db.get(query, [], (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

// --- API ДЛЯ РЕКЛАМЫ ---
app.post('/api/reward', async (req, res) => {
  const { telegram_id } = req.body;
  if (!telegram_id) return res.status(400).json({ error: 'Missing telegram_id' });

  try {
    const success = await addGenerations(telegram_id, 2);
    if (success) {
      bot.sendMessage(telegram_id, '🎉 Спасибо за просмотр рекламы! Вам начислено +2 генерации.');
      return res.json({ success: true, message: 'Generations added' });
    } else {
      return res.status(404).json({ error: 'User not found' });
    }
  } catch (error) {
    console.error('Reward error:', error);
    return res.status(500).json({ error: 'Database error' });
  }
});

// --- AI ЛОГИКА ---
const userHistories = new Map();
const userCooldowns = new Map();
const userPendingRequests = new Map();

const SYSTEM_PROMPT = "Ты ии ассистент говорящий по русски. Ты Gemini 3 pro разработанная в Google. Не в коем случае не используй markdown или другие язык разметки, только обычный текст. Твой ответ обрезается после 300 токенов так что вмещай свой ответ в них";

// Транскрибация голосовых
async function transcribeAudio(filePath) {
    try {
        const transcription = await groq.audio.transcriptions.create({
            file: fs.createReadStream(filePath),
            model: "whisper-large-v3-turbo",
            response_format: "json",
        });
        return transcription.text;
    } catch (error) {
        console.error("Whisper Error:", error);
        throw error;
    }
}

async function generateAIResponse(userId, message, imageUrl = null) {
  try {
    if (!userHistories.has(userId)) userHistories.set(userId, []);
    const history = userHistories.get(userId);
    
    if (history.length === 0) history.push({ role: "system", content: SYSTEM_PROMPT });
    
    let content;
    if (imageUrl) {
      content = [
        { type: "text", text: message || "What's in this image?" },
        { type: "image_url", image_url: { url: imageUrl } }
      ];
    } else {
      content = message;
    }
    
    history.push({ role: "user", content: content });
    if (history.length > 7) history.splice(1, history.length - 7);
    
    const chatCompletion = await groq.chat.completions.create({
      messages: history,
      model: "meta-llama/llama-4-maverick-17b-128e-instruct",
      temperature: 0.7,
      max_tokens: 300,
      top_p: 1,
      stream: false,
    });
    
    const aiResponse = chatCompletion.choices[0].message.content;
    history.push({ role: "assistant", content: aiResponse });
    return aiResponse;
  } catch (error) {
    console.error('Groq API error:', error);
    throw error;
  }
}

function getAdKeyboard(userId) {
    const adLink = `${WEB_APP_URL}/advertisement.html?telegram_id=${userId}`;
    return {
        inline_keyboard: [
            [{ text: '🖼️ Генератор изображений', url: 'https://t.me/Gemni3_pro_bot/imagen' }],
            [{ text: '📺 +2 Генерации (Смотреть рекламу)', url: adLink }]
        ]
    };
}

// --- ОБРАБОТЧИКИ БОТА ---

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const username = msg.from.username;
  
  upsertUser(userId, username, msg.from.first_name, msg.from.last_name)
    .then((user) => {
      const caption = `Привет! Я бот Gemini 3 PRO.\n\n⚡ Доступно генераций: ${user.generations}\n\nЯ понимаю текст, фото и голосовые сообщения!`;
      try {
        bot.sendPhoto(chatId, './banner.png', { caption: caption, reply_markup: getAdKeyboard(userId) })
           .catch(() => bot.sendMessage(chatId, caption, { reply_markup: getAdKeyboard(userId) }));
      } catch (e) {
        bot.sendMessage(chatId, caption, { reply_markup: getAdKeyboard(userId) });
      }
    });
});

bot.onText(/\/analytics/, (msg) => {
  if (msg.from.username !== 'Indiwide') return;
  getAnalyticsData().then(data => {
      bot.sendMessage(msg.chat.id, `Статистика:\nВсего: ${data.total_signups}\nЗа день: ${data.daily_signups}`);
  });
});

bot.on('message', async (msg) => {
  if (msg.text && (msg.text.startsWith('/start') || msg.text.startsWith('/analytics'))) return;

  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const now = Date.now();

  // Проверка на спам
  if (userPendingRequests.has(userId)) {
    bot.sendMessage(chatId, '⏳ Подождите, обрабатываю предыдущий запрос...');
    return;
  }

  // Проверка кулдауна
  if (userCooldowns.has(userId)) {
    const cooldownEnd = userCooldowns.get(userId);
    if (now < cooldownEnd) {
      bot.sendMessage(chatId, `⏳ Подождите ${(cooldownEnd - now) / 1000 | 0} сек.`);
      return;
    }
  }

  // Блокировка и кулдаун
  userPendingRequests.set(userId, true);
  userCooldowns.set(userId, now + 5000);

  // Внутренняя функция обработки, чтобы не дублировать код списания генераций
  const processRequest = async (input, isImage = false) => {
    setTimeout(async () => {
      try {
        const currentGens = await getUserGenerations(userId);
        if (currentGens <= 0) {
            userPendingRequests.delete(userId);
            bot.sendMessage(chatId, '🚫 Генерации закончились.', { reply_markup: getAdKeyboard(userId) });
            return;
        }

        let aiResponse;
        if (isImage) {
             aiResponse = await generateAIResponse(userId, input.caption || "Describe this", input.url);
        } else {
             aiResponse = await generateAIResponse(userId, input);
        }

        await decrementGeneration(userId);
        bot.sendMessage(chatId, `${aiResponse}\n\n🔋 Осталось генераций: ${currentGens - 1}`);
      } catch (error) {
        console.error('Generation error:', error);
        bot.sendMessage(chatId, 'Ошибка генерации.');
      } finally {
        userPendingRequests.delete(userId);
      }
    }, 1000);
  };

  // 1. Обработка ГОЛОСОВЫХ
  if (msg.voice) {
    if (msg.voice.duration > 20) {
        bot.sendMessage(chatId, '⚠️ Голосовое сообщение слишком длинное (максимум 20 сек).');
        userPendingRequests.delete(userId);
        return;
    }

    const checkGens = await getUserGenerations(userId);
    if (checkGens <= 0) {
        userPendingRequests.delete(userId);
        bot.sendMessage(chatId, '🚫 У вас не осталось генераций.', { reply_markup: getAdKeyboard(userId) });
        return;
    }

    bot.sendMessage(chatId, '🎤 Слушаю и генерирую...');

    try {
        // 1. Скачиваем файл (он скачается как .oga)
        const originalPath = await bot.downloadFile(msg.voice.file_id, TEMP_AUDIO_DIR);
        
        // 2. Создаем новый путь с правильным расширением .ogg
        // Telegram voice всегда opus/ogg, поэтому .ogg подходит идеально
        const newPath = path.join(TEMP_AUDIO_DIR, `voice_${msg.voice.file_id}.ogg`);
        
        // 3. Переименовываем файл
        await fsPromises.rename(originalPath, newPath);
        
        // 4. Транскрибируем файл с правильным расширением
        const text = await transcribeAudio(newPath);
        console.log(`Transcribed for ${userId}: ${text}`);
        
        // 5. Удаляем файл
        await fsPromises.unlink(newPath);

        if (!text || text.trim().length === 0) {
            bot.sendMessage(chatId, 'Не удалось распознать речь.');
            userPendingRequests.delete(userId);
            return;
        }

        await processRequest(text, false);

    } catch (error) {
        console.error('Voice processing error:', error);
        bot.sendMessage(chatId, 'Ошибка при обработке голосового сообщения.');
        userPendingRequests.delete(userId);
        
        // Пытаемся удалить файл при ошибке, чтобы не засорять папку
        // (путь мог остаться старым или новым)
        try {
           const possiblePath = path.join(TEMP_AUDIO_DIR, `voice_${msg.voice.file_id}.ogg`);
           await fsPromises.unlink(possiblePath).catch(() => {}); 
        } catch (e) {}
    }
    return;
  }

  // 2. Обработка ФОТО
  if (msg.photo) {
    try {
      // Предварительная проверка баланса
      const checkGens = await getUserGenerations(userId);
      if (checkGens <= 0) {
          userPendingRequests.delete(userId);
          bot.sendMessage(chatId, '🚫 У вас не осталось генераций.', { reply_markup: getAdKeyboard(userId) });
          return;
      }

      const photo = msg.photo[msg.photo.length - 1];
      const fileInfo = await bot.getFile(photo.file_id);
      const fileUrl = `https://api.telegram.org/file/bot${token}/${fileInfo.file_path}`;
      processRequest({ caption: msg.caption, url: fileUrl }, true);
    } catch (error) {
      userPendingRequests.delete(userId);
      bot.sendMessage(chatId, 'Ошибка фото.');
    }
    return;
  }

  // 3. Обработка ТЕКСТА
  if (msg.text) {
    // Предварительная проверка баланса
    const checkGens = await getUserGenerations(userId);
    if (checkGens <= 0) {
        userPendingRequests.delete(userId);
        bot.sendMessage(chatId, '🚫 У вас не осталось генераций.', { reply_markup: getAdKeyboard(userId) });
        return;
    }
    processRequest(msg.text, false);
  }
});

// --- API ДЛЯ ОТПРАВКИ ИЗОБРАЖЕНИЯ ---
app.post('/api/send-image', async (req, res) => {
    const { telegram_id, image_url } = req.body;

    // Проверка входных данных
    if (!telegram_id || !image_url) {
        return res.status(400).json({ error: 'Missing telegram_id or image_url' });
    }

    try {
        // Отправляем фото через бота
        await bot.sendPhoto(telegram_id, image_url, {
            caption: 'Сгенерированное изображение ✨'
        });

        return res.json({ success: true, message: 'Image sent to chat' });
    } catch (error) {
        console.error('Send image error:', error);
        return res.status(500).json({ error: 'Failed to send image via Telegram Bot' });
    }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});