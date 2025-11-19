require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const sqlite3 = require('sqlite3').verbose();
const { Groq } = require('groq-sdk');
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');

// --- КОНФИГУРАЦИЯ ---
const token = process.env.TELEGRAM_BOT_TOKEN;
const groqApiKey = process.env.GROQ_API_KEY;
const PORT = process.env.PORT || 3000;
// ВАЖНО: Сюда нужно вставить ваш публичный URL (например, от ngrok или вашего VPS)
// Без https:// ссылки не откроются в Telegram корректно
const WEB_APP_URL = process.env.WEB_APP_URL || 'https://localhost:3000'; 

if (!token || !groqApiKey) {
  console.error('Error: TELEGRAM_BOT_TOKEN or GROQ_API_KEY is missing.');
  process.exit(1);
}

// --- ИНИЦИАЛИЗАЦИЯ СЕРВИСОВ ---
const groq = new Groq({ apiKey: groqApiKey });
const bot = new TelegramBot(token, { polling: true });
const app = express();
const db = new sqlite3.Database('users.db');

// --- НАСТРОЙКА EXPRESS ---
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public'))); // Папка для html файлов

// --- БАЗА ДАННЫХ ---
db.serialize(() => {
  // Создание таблицы пользователей с полем generations
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id INTEGER UNIQUE,
    username TEXT,
    first_name TEXT,
    last_name TEXT,
    generations INTEGER DEFAULT 5, 
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  
  // Миграция для старых баз данных (если поле generations не существует)
  // Пытаемся добавить колонку, если ошибка - значит она уже есть
  db.run(`ALTER TABLE users ADD COLUMN generations INTEGER DEFAULT 5`, (err) => {
    if (err && !err.message.includes('duplicate column')) {
        // Игнорируем ошибку дубликата, логируем другие
    }
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
    // Проверяем существование
    db.get('SELECT id, generations FROM users WHERE telegram_id = ?', [userId], (err, row) => {
      if (err) return reject(err);

      if (row) {
        // Обновляем инфо
        db.run('UPDATE users SET username = ?, first_name = ?, last_name = ? WHERE telegram_id = ?', 
          [username, firstName, lastName, userId], (err) => {
            if (err) reject(err);
            else resolve({ id: row.id, generations: row.generations, isNew: false });
          });
      } else {
        // Создаем нового с 5 генерациями
        db.run('INSERT INTO users (telegram_id, username, first_name, last_name, generations) VALUES (?, ?, ?, ?, 5)',
          [userId, username, firstName, lastName], function(err) {
            if (err) return reject(err);
            const newId = this.lastID;
            
            // Записываем аналитику
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
      else resolve(this.changes > 0); // Возвращает true если пользователь найден
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

// Эндпоинт, который вызывает сайт после просмотра рекламы
app.post('/api/reward', async (req, res) => {
  const { telegram_id } = req.body;

  if (!telegram_id) {
    return res.status(400).json({ error: 'Missing telegram_id' });
  }

  try {
    const success = await addGenerations(telegram_id, 2);
    if (success) {
      // Уведомляем пользователя в боте
      bot.sendMessage(telegram_id, '🎉 Спасибо за просмотр рекламы! Вам начислено +2 генерации.');
      console.log(`Added 2 generations to user ${telegram_id}`);
      return res.json({ success: true, message: 'Generations added' });
    } else {
      return res.status(404).json({ error: 'User not found' });
    }
  } catch (error) {
    console.error('Reward error:', error);
    return res.status(500).json({ error: 'Database error' });
  }
});

// --- ЛОГИКА БОТА ---

const userHistories = new Map();
const userCooldowns = new Map();
const userPendingRequests = new Map();

const SYSTEM_PROMPT = "Ты ии ассистент говорящий по русски. Ты Gemini 3 pro разработанная в Google. Не в коем случае не используй markdown или другие язык разметки, только обычный текст. Твой ответ обрезается после 300 токенов так что вмещай свой ответ в них";

async function generateAIResponse(userId, message, imageUrl = null) {
  try {
    if (!userHistories.has(userId)) {
      userHistories.set(userId, []);
    }
    const history = userHistories.get(userId);
    
    if (history.length === 0) {
      history.push({ role: "system", content: SYSTEM_PROMPT });
    }
    
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
    
    if (history.length > 7) {
      history.splice(1, history.length - 7);
    }
    
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

// Клавиатура с кнопкой рекламы
function getAdKeyboard(userId) {
    const adLink = `${WEB_APP_URL}/advertisement.html?telegram_id=${userId}`;
    return {
        inline_keyboard: [
            [{ text: '📺 +2 Генерации (Смотреть рекламу)', url: adLink }]
        ]
    };
}

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const username = msg.from.username;
  const firstName = msg.from.first_name;
  const lastName = msg.from.last_name;
  
  upsertUser(userId, username, firstName, lastName)
    .then((user) => {
      console.log(`User ${username || userId} started the bot`);
      const caption = `Привет! Я бот Gemini 3 PRO.\n\n⚡ Доступно генераций: ${user.generations}\n\nНапиши мне что-либо и тебе ответит передовая модель от Google.`;
      
      // Пытаемся отправить фото, если файла нет - шлем текст
      try {
        bot.sendPhoto(chatId, './banner.png', {
            caption: caption,
            reply_markup: getAdKeyboard(userId)
        }).catch(() => {
             bot.sendMessage(chatId, caption, { reply_markup: getAdKeyboard(userId) });
        });
      } catch (e) {
        bot.sendMessage(chatId, caption, { reply_markup: getAdKeyboard(userId) });
      }
    })
    .catch(err => console.error('Database error:', err));
});

bot.onText(/\/analytics/, (msg) => {
  const chatId = msg.chat.id;
  const username = msg.from.username;
  
  if (username !== 'Indiwide') {
    bot.sendMessage(chatId, 'У вас нет доступа к аналитике.');
    return;
  }
  
  getAnalyticsData()
    .then(data => {
      const message = `Статистика:\nВсего: ${data.total_signups}\nЗа день: ${data.daily_signups}\nЗа неделю: ${data.weekly_signups}`;
      bot.sendMessage(chatId, message);
    })
    .catch(err => {
      console.error('Analytics error:', err);
      bot.sendMessage(chatId, 'Ошибка статистики.');
    });
});

bot.on('message', async (msg) => {
  if (msg.text && (msg.text.startsWith('/start') || msg.text.startsWith('/analytics'))) return;

  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const now = Date.now();

  // 1. Проверка на спам
  if (userPendingRequests.has(userId)) {
    bot.sendMessage(chatId, '⏳ Я еще думаю над прошлым сообщением...');
    return;
  }

  // 2. Проверка кулдауна
  if (userCooldowns.has(userId)) {
    const cooldownEnd = userCooldowns.get(userId);
    if (now < cooldownEnd) {
      const remainingTime = Math.ceil((cooldownEnd - now) / 1000);
      bot.sendMessage(chatId, `⏳ Подождите ${remainingTime} сек.`);
      return;
    }
  }

  // 3. ПРОВЕРКА ГЕНЕРАЦИЙ
  try {
    const gens = await getUserGenerations(userId);
    if (gens <= 0) {
        bot.sendMessage(chatId, '🚫 У вас не осталось генераций.\nПосмотрите рекламу, чтобы получить 2 генерации.', {
            reply_markup: getAdKeyboard(userId)
        });
        return;
    }
  } catch (err) {
      console.error("DB Error check gens", err);
      return;
  }

  userPendingRequests.set(userId, true);
  userCooldowns.set(userId, now + 5000);

  const processRequest = async (input, isImage = false) => {
    // Искусственная задержка (как в оригинале)
    setTimeout(async () => {
      try {
        // Снова проверяем генерации перед самим запросом (на случай гонки)
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

        // Списываем генерацию ТОЛЬКО после успешного ответа
        await decrementGeneration(userId);
        const left = currentGens - 1;

        bot.sendMessage(chatId, `${aiResponse}\n\n🔋 Осталось генераций: ${left}`);
      } catch (error) {
        console.error('Generation error:', error);
        bot.sendMessage(chatId, 'Произошла ошибка. Генерация не списана.');
      } finally {
        userPendingRequests.delete(userId);
      }
    }, 1000); // 10 секунд задержка
  };

  // Обработка фото
  if (msg.photo) {
    console.log(`Photo from ${msg.from.username || userId}`);
    try {
      const photo = msg.photo[msg.photo.length - 1];
      const fileInfo = await bot.getFile(photo.file_id);
      const fileUrl = `https://api.telegram.org/file/bot${token}/${fileInfo.file_path}`;
      processRequest({ caption: msg.caption, url: fileUrl }, true);
    } catch (error) {
      console.error('Photo error:', error);
      userPendingRequests.delete(userId);
      bot.sendMessage(chatId, 'Ошибка обработки фото.');
    }
    return;
  }

  // Обработка текста
  if (msg.text) {
    console.log(`Text from ${msg.from.username || userId}: ${msg.text}`);
    processRequest(msg.text, false);
  }
});

// Запуск сервера
app.listen(PORT, () => {
  console.log(`Server and Bot running on port ${PORT}`);
});