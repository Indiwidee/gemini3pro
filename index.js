require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const sqlite3 = require('sqlite3').verbose();
const { Groq } = require('groq-sdk');
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');
const fsPromises = require('fs').promises;

// --- КОНФИГУРАЦИЯ ---
const token = process.env.TELEGRAM_BOT_TOKEN;
const groqApiKey = process.env.GROQ_API_KEY;
// ВАЖНО: Вставь сюда ID блока из дашборда Adsgram (только цифры, без int-)
const ADSGRAM_BLOCK_ID = process.env.ADSGRAM_BLOCK_ID || 'YOUR_BLOCK_ID_HERE'; 

const PORT = process.env.PORT || 3000;
const WEB_APP_URL = process.env.WEB_APP_URL || 'http://localhost:3000';

if (!token || !groqApiKey) {
  console.error('Error: TELEGRAM_BOT_TOKEN or GROQ_API_KEY is missing.');
  process.exit(1);
}

// Создаем папку для временных аудио
const TEMP_AUDIO_DIR = path.join(__dirname, 'temp_audio');
if (!fs.existsSync(TEMP_AUDIO_DIR)){
    fs.mkdirSync(TEMP_AUDIO_DIR);
}

// --- ИНИЦИАЛИЗАЦИЯ СЕРВИСОВ ---
const groq = new Groq({ apiKey: groqApiKey });
const bot = new TelegramBot(token, { polling: true });
const app = express();
const db = new sqlite3.Database('users.db');

// Состояния пользователей
const userStates = new Map(); 

// --- НАСТРОЙКА EXPRESS ---
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- СЛОВАРИ НАСТРОЕК ИИ ---
const AI_SETTINGS = {
    roles: {
        assistant: { label: '🤖 Ассистент', prompt: 'Ты полезный и умный ИИ ассистент.' },
        friend: { label: '🤝 Друг', prompt: 'Ты лучший друг пользователя. Поддерживай беседу, интересуйся делами, будь эмпатичным.' },
        expert: { label: '🧐 Эксперт', prompt: 'Ты строгий эксперт с глубокими знаниями. Отвечай четко, по фактам, без воды.' },
        gopnik: { label: '🌻 Пацан', prompt: 'Ты обычный пацан с района. Используй дворовой жаргон, обращайся на "ты", будь проще.' }
    },
    styles: {
        polite: { label: '🎩 Культурный', prompt: 'Будь предельно вежлив. Используй "Вы", "пожалуйста", "будьте любезны".' },
        casual: { label: '👖 Обычный', prompt: 'Общайся просто и понятно, как в обычной переписке.' },
        toxic: { label: '☠️ Токсичный', prompt: 'Отвечай с пассивной агрессией, сарказмом и легким пренебрежением.' },
        slang: { label: '😎 Сленг', prompt: 'Используй современный интернет-сленг (кринж, рофл, имба, база).' }
    },
    moods: {
        neutral: { label: '😐 Нейтральный', prompt: 'Твое настроение нейтральное и сбалансированное.' },
        funny: { label: '😂 Юморист', prompt: 'Постоянно шути, добавляй каламбуры и анекдоты в тему.' },
        depressed: { label: '😔 Грустный', prompt: 'Ты очень пессимистичен, вечно ноешь и видишь все в серых тонах.' }
    }
};

// --- БАЗА ДАННЫХ ---
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id INTEGER UNIQUE,
    username TEXT,
    first_name TEXT,
    last_name TEXT,
    generations INTEGER DEFAULT 5, 
    ai_role TEXT DEFAULT 'assistant',
    ai_style TEXT DEFAULT 'casual',
    ai_mood TEXT DEFAULT 'neutral',
    ai_name TEXT DEFAULT 'SwiftBrain',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  
  const columnsToAdd = [
      { name: 'generations', type: 'INTEGER DEFAULT 5' },
      { name: 'ai_role', type: "TEXT DEFAULT 'assistant'" },
      { name: 'ai_style', type: "TEXT DEFAULT 'casual'" },
      { name: 'ai_mood', type: "TEXT DEFAULT 'neutral'" },
      { name: 'ai_name', type: "TEXT DEFAULT 'SwiftBrain'" }
  ];

  columnsToAdd.forEach(col => {
      db.run(`ALTER TABLE users ADD COLUMN ${col.name} ${col.type}`, (err) => {
          if (err && !err.message.includes('duplicate column')) { }
      });
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
    db.get('SELECT id, generations, ai_role, ai_style, ai_mood, ai_name FROM users WHERE telegram_id = ?', [userId], (err, row) => {
      if (err) return reject(err);
      if (row) {
        db.run('UPDATE users SET username = ?, first_name = ?, last_name = ? WHERE telegram_id = ?', 
          [username, firstName, lastName, userId], (err) => {
            if (err) reject(err);
            else resolve({ ...row, isNew: false });
          });
      } else {
        db.run('INSERT INTO users (telegram_id, username, first_name, last_name, generations, ai_name) VALUES (?, ?, ?, ?, 5, "SwiftBrain")',
          [userId, username, firstName, lastName], function(err) {
            if (err) return reject(err);
            const newId = this.lastID;
            db.run("INSERT INTO analytics (event_type, user_id) VALUES ('signup', ?)", [newId]);
            resolve({ id: newId, generations: 5, ai_role: 'assistant', ai_style: 'casual', ai_mood: 'neutral', ai_name: 'SwiftBrain', isNew: true });
          });
      }
    });
  });
}

function getUserData(userId) {
  return new Promise((resolve, reject) => {
    db.get('SELECT generations, ai_role, ai_style, ai_mood, ai_name, first_name FROM users WHERE telegram_id = ?', [userId], (err, row) => {
      if (err) reject(err);
      resolve(row || { generations: 0, ai_role: 'assistant', ai_style: 'casual', ai_mood: 'neutral', ai_name: 'SwiftBrain', first_name: 'User' });
    });
  });
}

function updateUserSetting(userId, column, value) {
    return new Promise((resolve, reject) => {
        const allowedColumns = ['ai_role', 'ai_style', 'ai_mood', 'ai_name'];
        if (!allowedColumns.includes(column)) return reject(new Error("Invalid column"));

        db.run(`UPDATE users SET ${column} = ? WHERE telegram_id = ?`, [value, userId], (err) => {
            if (err) reject(err);
            else resolve();
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

// --- ФУНКЦИЯ ПОКАЗА РЕКЛАМЫ (ADSGRAM) ---
async function showNativeAd(chatId, userId) {
    try {
        // Используем встроенный fetch (Node 18+)
        const response = await fetch(`https://api.adsgram.ai/advbot?tgid=${userId}&blockid=${ADSGRAM_BLOCK_ID}`);
        
        if (!response.ok) {
            throw new Error(`Adsgram API Error: ${response.status}`);
        }

        const data = await response.json();
        console.log('Adsgram Response:', data);

        // Если рекламы нет, API может вернуть пустой ответ или ошибку (зависит от API, но обработаем базово)
        if (!data || !data.text_html) {
            bot.sendMessage(chatId, '😔 На данный момент рекламных предложений нет. Попробуйте позже.');
            return;
        }

        // Формируем клавиатуру из данных API
        const inline_keyboard = [];
        
        // Кнопка перехода (click_url)
        if (data.button_name && data.click_url) {
            inline_keyboard.push([{ text: data.button_name, url: data.click_url }]);
        }
        
        // Кнопка награды (reward_url)
        if (data.button_reward_name && data.reward_url) {
            inline_keyboard.push([{ text: data.button_reward_name, url: data.reward_url }]);
        }

        await bot.sendPhoto(chatId, data.image_url, {
            caption: data.text_html,
            parse_mode: 'HTML',
            protect_content: true,
            reply_markup: {
                inline_keyboard: inline_keyboard
            }
        });

    } catch (error) {
        console.error('Error fetching ads:', error);
        bot.sendMessage(chatId, '⚠️ Произошла ошибка при загрузке рекламы. Попробуйте позже.');
    }
}


// --- API ДЛЯ РЕКЛАМЫ (Остается для обратной совместимости или вебхуков) ---
app.post('/api/reward/:userId', async (req, res) => {
  const { userId } = req.params;
  if (!userId) return res.status(400).json({ error: 'Missing userId' });

  try {
    const success = await addGenerations(userId, 2);
    if (success) {
      bot.sendMessage(userId, '🎉 Спасибо за просмотр рекламы! Вам начислено +2 генерации.');
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
    const userData = await getUserData(userId);
    
    const botName = userData.ai_name || 'SwiftBrain';
    const rolePrompt = AI_SETTINGS.roles[userData.ai_role]?.prompt || AI_SETTINGS.roles.assistant.prompt;
    const stylePrompt = AI_SETTINGS.styles[userData.ai_style]?.prompt || AI_SETTINGS.styles.casual.prompt;
    const moodPrompt = AI_SETTINGS.moods[userData.ai_mood]?.prompt || AI_SETTINGS.moods.neutral.prompt;

    const SYSTEM_PROMPT = `Тебя зовут ${botName}. ${rolePrompt} ${stylePrompt} ${moodPrompt}
    ВАЖНОЕ ПРАВИЛО: Отвечай ТОЛЬКО обычным текстом. Не используй markdown, жирный текст, курсив или html теги. Твой ответ обрезается после 300 токенов, будь краток. Говори по-русски.`;

    if (!userHistories.has(userId)) userHistories.set(userId, []);
    const history = userHistories.get(userId);
    
    // Если история пуста или первый элемент не совпадает с текущим системным промтом
    if (history.length === 0 || history[0].role !== 'system' || history[0].content !== SYSTEM_PROMPT) {
        if (history.length > 0 && history[0].role === 'system') {
            history[0].content = SYSTEM_PROMPT; // Обновляем
        } else {
            history.unshift({ role: "system", content: SYSTEM_PROMPT }); // Добавляем в начало
        }
    }
    
    let content;
    if (imageUrl) {
      content = [
        { type: "text", text: message || "Что на этом изображении?" },
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

// --- ГЕНЕРАЦИЯ КЛАВИАТУР ---

function getStartKeyboard(userId) {
    return {
        inline_keyboard: [
            [{ text: '🖼️ Генератор изображений', url: 'https://t.me/swiftbrainbot/imagen' }],
            [{ text: '⚙️ Настройка ИИ', callback_data: 'settings_main' }],
            [{ text: '👤 Профиль', callback_data: 'profile_main' }]
        ]
    };
}

function getProfileKeyboard(userId) {
    // ИЗМЕНЕНИЕ: Теперь кнопка ведет не на сайт, а вызывает callback 'show_ad'
    return {
        inline_keyboard: [
            [{ text: '📺 +2 Генерации (Реклама)', callback_data: 'show_ad' }], 
            [{ text: '💰 Купить 100 ⚡', callback_data: 'buy_100' }, { text: '💰 Купить 500 ⚡', callback_data: 'buy_500' }],
            [{ text: '💰 Купить 1000 ⚡', callback_data: 'buy_1000' }],
            [{ text: '🔙 Назад', callback_data: 'close_settings' }]
        ]
    };
}

function getSettingsKeyboard() {
    return {
        inline_keyboard: [
            [{ text: '🏷 Имя', callback_data: 'menu_name' }],
            [{ text: '🎭 Роль', callback_data: 'menu_role' }, { text: '🗣️ Стиль', callback_data: 'menu_style' }],
            [{ text: '🤪 Характер', callback_data: 'menu_mood' }],
            [{ text: '🔙 Назад', callback_data: 'close_settings' }]
        ]
    };
}

function getSubSettingsKeyboard(type, currentVal) {
    const items = AI_SETTINGS[type + 's']; 
    const keyboard = [];
    let row = [];
    
    Object.keys(items).forEach((key, index) => {
        const item = items[key];
        const isSelected = key === currentVal ? '✅ ' : '';
        row.push({ text: `${isSelected}${item.label}`, callback_data: `set_${type}_${key}` });
        
        if (row.length === 2) {
            keyboard.push(row);
            row = [];
        }
    });
    if (row.length > 0) keyboard.push(row);
    
    keyboard.push([{ text: '🔙 Назад', callback_data: 'settings_main' }]);
    return { inline_keyboard: keyboard };
}

// --- ОБРАБОТЧИКИ БОТА ---

// Команда сброса диалога
bot.onText(/\/newchat/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    if (userHistories.has(userId)) {
        userHistories.delete(userId);
        bot.sendMessage(chatId, '🆕 Новый чат начат! Я забыл всё, о чем мы говорили ранее.');
    } else {
        bot.sendMessage(chatId, '🆕 Чат итак новый.');
    }
});

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const username = msg.from.username;
  
  upsertUser(userId, username, msg.from.first_name, msg.from.last_name)
    .then((user) => {
      const caption = `Привет! Я ${user.ai_name || 'SwiftBrain'}.

⚡ Доступно генераций: ${user.generations}

Я понимаю текст, фото и голосовые сообщения!
Напиши /newchat чтобы начать новый чат.`;
      try {
        bot.sendPhoto(chatId, './banner.png', { caption: caption, reply_markup: getStartKeyboard(userId) })
           .catch(() => bot.sendMessage(chatId, caption, { reply_markup: getStartKeyboard(userId) }));
      } catch (e) {
        bot.sendMessage(chatId, caption, { reply_markup: getStartKeyboard(userId) });
      }
    });
});

// ОБРАБОТКА CALLBACK QUERY
bot.on('callback_query', async (query) => {
    const userId = query.from.id;
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;
    const data = query.data;

    // ИЗМЕНЕНИЕ: Обработка просмотра рекламы
    if (data === 'show_ad') {
        bot.sendMessage(chatId, '⏳ Загружаю рекламу...');
        bot.answerCallbackQuery(query.id);
        await showNativeAd(chatId, userId);
    }
    else if (data === 'profile_main') {
        const user = await getUserData(userId);
        const caption = `👤 *Ваш Профиль*

👤 Имя: ${user.first_name}
⚡ Баланс генераций: *${user.generations}*

Выберите действие:`;
        const options = { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown', reply_markup: getProfileKeyboard(userId) };
        bot.editMessageCaption(caption, options).catch(() => bot.editMessageText(caption, options));
    }
    else if (data.startsWith('buy_')) {
        const amount = parseInt(data.split('_')[1]);
        await addGenerations(userId, amount);
        const user = await getUserData(userId);
        const caption = `👤 *Ваш Профиль*

👤 Имя: ${user.first_name}
⚡ Баланс генераций: *${user.generations}*

✅ Успешно начислено +${amount}!`;
        const options = { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown', reply_markup: getProfileKeyboard(userId) };
        bot.answerCallbackQuery(query.id, { text: `Начислено +${amount} генераций!` });
        bot.editMessageCaption(caption, options).catch(() => bot.editMessageText(caption, options));
    }
    else if (data === 'settings_main') {
        bot.editMessageCaption('🛠 *Настройки ИИ*\nВыберите, что хотите изменить:', {
            chat_id: chatId, message_id: messageId, parse_mode: 'Markdown', reply_markup: getSettingsKeyboard()
        }).catch(() => bot.editMessageText('🛠 *Настройки ИИ*\nВыберите, что хотите изменить:', {
            chat_id: chatId, message_id: messageId, parse_mode: 'Markdown', reply_markup: getSettingsKeyboard()
        }));
    }
    else if (data === 'menu_name') {
        userStates.set(userId, 'WAITING_FOR_NAME');
        bot.sendMessage(chatId, '✍️ Введите новое имя для бота:');
        bot.answerCallbackQuery(query.id);
    }
    else if (data === 'close_settings') {
        const user = await getUserData(userId);
        const caption = `Привет! Я ${user.ai_name || 'SwiftBrain'}.

⚡ Доступно генераций: ${user.generations}

Я понимаю текст, фото и голосовые сообщения!
Напиши /newchat чтобы начать новый чат.`;
        bot.editMessageCaption(caption, { chat_id: chatId, message_id: messageId, reply_markup: getStartKeyboard(userId) })
           .catch(() => bot.editMessageText(caption, { chat_id: chatId, message_id: messageId, reply_markup: getStartKeyboard(userId) }));
    }
    else if (data.startsWith('menu_')) {
        const type = data.split('_')[1]; 
        const user = await getUserData(userId);
        const currentVal = user[`ai_${type}`];
        let title = '';
        if (type === 'role') title = '🎭 Выберите роль:';
        if (type === 'style') title = '🗣️ Выберите стиль общения:';
        if (type === 'mood') title = '🤪 Выберите характер:';
        const keyboard = getSubSettingsKeyboard(type, currentVal);
        const options = { chat_id: chatId, message_id: messageId, reply_markup: keyboard };
        bot.editMessageCaption(title, options).catch(() => bot.editMessageText(title, options));
    }
    else if (data.startsWith('set_')) {
        const parts = data.split('_'); 
        const type = parts[1];
        const value = parts[2];
        const dbColumn = `ai_${type}`;
        await updateUserSetting(userId, dbColumn, value);
        userHistories.delete(userId);
        const keyboard = getSubSettingsKeyboard(type, value);
        let title = '✅ Настройка сохранена!\n';
        if (type === 'role') title += '🎭 Выберите роль:';
        if (type === 'style') title += '🗣️ Выберите стиль общения:';
        if (type === 'mood') title += '🤪 Выберите характер:';
        const options = { chat_id: chatId, message_id: messageId, reply_markup: keyboard };
        bot.editMessageCaption(title, options).catch(() => bot.editMessageText(title, options));
        bot.answerCallbackQuery(query.id, { text: 'Настройки обновлены!' });
    }
});

bot.onText(/\/analytics/, (msg) => {
  if (msg.from.username !== 'Indiwide') return;
  getAnalyticsData().then(data => {
      bot.sendMessage(msg.chat.id, `Статистика:\nВсего: ${data.total_signups}\nЗа день: ${data.daily_signups}`);
  });
});

// --- ГЛАВНЫЙ ОБРАБОТЧИК СООБЩЕНИЙ ---
bot.on('message', async (msg) => {
  // Игнорируем команды, чтобы они не шли в ИИ
  if (msg.text && (msg.text.startsWith('/start') || msg.text.startsWith('/analytics') || msg.text.startsWith('/newchat'))) return;

  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const now = Date.now();

  // === ВВОД ИМЕНИ ===
  if (userStates.get(userId) === 'WAITING_FOR_NAME') {
      if (msg.text) {
          const newName = msg.text.trim().substring(0, 30); 
          await updateUserSetting(userId, 'ai_name', newName);
          userHistories.delete(userId);
          userStates.delete(userId);
          
          bot.sendMessage(chatId, `✅ Отлично! Теперь меня зовут ${newName}.`, {
              reply_markup: getSettingsKeyboard()
          });
      } else {
          bot.sendMessage(chatId, 'Пожалуйста, отправьте текстовое сообщение с именем.');
      }
      return;
  }

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

  userPendingRequests.set(userId, true);
  userCooldowns.set(userId, now + 5000);

  const processRequest = async (input, isImage = false) => {
    setTimeout(async () => {
      try {
        const userData = await getUserData(userId);
        const currentGens = userData.generations;
        
        if (currentGens <= 0) {
            userPendingRequests.delete(userId);
            bot.sendMessage(chatId, '🚫 Генерации закончились. Зайдите в профиль, чтобы пополнить.', { reply_markup: getStartKeyboard(userId) });
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

  if (msg.voice) {
    if (msg.voice.duration > 20) {
        bot.sendMessage(chatId, '⚠️ Голосовое сообщение слишком длинное (максимум 20 сек).');
        userPendingRequests.delete(userId);
        return;
    }
    const userData = await getUserData(userId);
    if (userData.generations <= 0) {
        userPendingRequests.delete(userId);
        bot.sendMessage(chatId, '🚫 У вас не осталось генераций.', { reply_markup: getStartKeyboard(userId) });
        return;
    }
    bot.sendMessage(chatId, '🎤 Слушаю и генерирую...');
    try {
        const originalPath = await bot.downloadFile(msg.voice.file_id, TEMP_AUDIO_DIR);
        const newPath = path.join(TEMP_AUDIO_DIR, `voice_${msg.voice.file_id}.ogg`);
        await fsPromises.rename(originalPath, newPath);
        const text = await transcribeAudio(newPath);
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
        try {
           const possiblePath = path.join(TEMP_AUDIO_DIR, `voice_${msg.voice.file_id}.ogg`);
           await fsPromises.unlink(possiblePath).catch(() => {}); 
        } catch (e) {}
    }
    return;
  }

  if (msg.photo) {
    try {
      const userData = await getUserData(userId);
      if (userData.generations <= 0) {
          userPendingRequests.delete(userId);
          bot.sendMessage(chatId, '🚫 У вас не осталось генераций.', { reply_markup: getStartKeyboard(userId) });
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

  if (msg.text) {
    const userData = await getUserData(userId);
    if (userData.generations <= 0) {
        userPendingRequests.delete(userId);
        bot.sendMessage(chatId, '🚫 У вас не осталось генераций.', { reply_markup: getStartKeyboard(userId) });
        return;
    }
    processRequest(msg.text, false);
  }
});

app.post('/api/send-image', async (req, res) => {
    const { telegram_id, image_url } = req.body;
    if (!telegram_id || !image_url) return res.status(400).json({ error: 'Missing telegram_id or image_url' });
    try {
        await bot.sendPhoto(telegram_id, image_url, { caption: 'Сгенерированное изображение ✨' });
        return res.json({ success: true, message: 'Image sent to chat' });
    } catch (error) {
        console.error('Send image error:', error);
        return res.status(500).json({ error: 'Failed to send image via Telegram Bot' });
    }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});