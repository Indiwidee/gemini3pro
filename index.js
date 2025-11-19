require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const sqlite3 = require('sqlite3').verbose();
const { Groq } = require('groq-sdk');

// Get token from environment variables
const token = process.env.TELEGRAM_BOT_TOKEN;
const groqApiKey = process.env.GROQ_API_KEY;

if (!token) {
  console.error('TELEGRAM_BOT_TOKEN is not set in environment variables!');
  process.exit(1);
}

if (!groqApiKey) {
  console.error('GROQ_API_KEY is not set in environment variables!');
  process.exit(1);
}

// Initialize Groq client
const groq = new Groq({ apiKey: groqApiKey });

// Initialize SQLite database
const db = new sqlite3.Database('users.db');

// Create tables if they don't exist
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id INTEGER UNIQUE,
    username TEXT,
    first_name TEXT,
    last_name TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  
  db.run(`CREATE TABLE IF NOT EXISTS analytics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT,
    user_id INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  )`);
});

// Enable polling to receive messages
const bot = new TelegramBot(token, { polling: true });

// Store user cooldowns and pending requests
const userCooldowns = new Map();
const userPendingRequests = new Map();

console.log('Bot is starting...');

// Handle errors
bot.on('polling_error', (error) => {
  console.error('Polling error:', error);
});

bot.on('error', (error) => {
  console.error('Bot error:', error);
});

// Helper function to add or update user in database
function upsertUser(userId, username, firstName, lastName) {
  return new Promise((resolve, reject) => {
    // First try to update existing user
    const updateStmt = db.prepare(`
      UPDATE users 
      SET username = ?, first_name = ?, last_name = ? 
      WHERE telegram_id = ?
    `);
    
    updateStmt.run([username, firstName, lastName, userId], function(err) {
      if (err) {
        updateStmt.finalize();
        return reject(err);
      }
      
      // If no rows were affected, insert new user
      if (this.changes === 0) {
        const insertStmt = db.prepare(`
          INSERT OR IGNORE INTO users (telegram_id, username, first_name, last_name) 
          VALUES (?, ?, ?, ?)
        `);
        
        insertStmt.run([userId, username, firstName, lastName], function(err) {
          insertStmt.finalize();
          if (err) {
            return reject(err);
          }
          
          // Record signup analytics event
          const userSelectStmt = db.prepare(`
            SELECT id FROM users WHERE telegram_id = ?
          `);
          
          userSelectStmt.get([userId], (err, row) => {
            userSelectStmt.finalize();
            if (err) {
              return reject(err);
            }
            
            if (row) {
              const analyticsStmt = db.prepare(`
                INSERT INTO analytics (event_type, user_id) 
                VALUES ('signup', ?)
              `);
              
              analyticsStmt.run([row.id], function(err) {
                analyticsStmt.finalize();
                if (err) {
                  return reject(err);
                }
                resolve(row.id);
              });
            } else {
              resolve(null);
            }
          });
        });
      } else {
        updateStmt.finalize();
        resolve(true);
      }
    });
  });
}

// Helper function to get analytics data
function getAnalyticsData() {
  return new Promise((resolve, reject) => {
    const query = `
      SELECT 
        (SELECT COUNT(*) FROM analytics WHERE event_type = 'signup') as total_signups,
        (SELECT COUNT(*) FROM analytics WHERE event_type = 'signup' AND created_at >= datetime('now', '-1 day')) as daily_signups,
        (SELECT COUNT(*) FROM analytics WHERE event_type = 'signup' AND created_at >= datetime('now', '-7 days')) as weekly_signups
    `;
    
    db.get(query, [], (err, row) => {
      if (err) {
        reject(err);
      } else {
        resolve(row);
      }
    });
  });
}

// Helper function to generate AI response using Groq
async function generateAIResponse(message) {
  try {
    const chatCompletion = await groq.chat.completions.create({
      messages: [
        {
          role: "user",
          content: message,
        }
      ],
      model: "llama-3.1-8b-instant", // Using the exact model specified by the user
      temperature: 0.7,
      max_tokens: 300,
      top_p: 1,
      stream: false,
    });
    
    return chatCompletion.choices[0].message.content;
  } catch (error) {
    console.error('Groq API error:', error);
    return "Извините, возникла ошибка при обработке вашего запроса. Попробуйте еще раз позже.";
  }
}

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const username = msg.from.username;
  const firstName = msg.from.first_name;
  const lastName = msg.from.last_name;
  
  // Add or update user in database
  upsertUser(userId, username, firstName, lastName)
    .then(() => {
      console.log(`User ${username || userId} started the bot`);
      // Send image with caption instead of just text
      bot.sendPhoto(chatId, './banner.png', {
        caption: 'Привет! Я бот Gemini 3 PRO, напиши мне что либо и тебе ответит передовая модель от Google'
      });
    })
    .catch(err => {
      console.error('Database error:', err);
      // Send image with caption instead of just text
      bot.sendPhoto(chatId, './banner.png', {
        caption: 'Привет! Я бот Gemini 3 PRO, напиши мне что либо и тебе ответит передовая модель от Google'
      });
    });
});

// Handle analytics command for user 'Indiwide'
bot.onText(/\/analytics/, (msg) => {
  const chatId = msg.chat.id;
  const username = msg.from.username;
  
  // Only allow user 'Indiwide' to access analytics
  if (username !== 'Indiwide') {
    bot.sendMessage(chatId, 'У вас нет доступа к аналитике.');
    return;
  }
  
  getAnalyticsData()
    .then(data => {
      const message = `
Статистика подписчиков:
Всего: ${data.total_signups}
За день: ${data.daily_signups}
За неделю: ${data.weekly_signups}
      `;
      bot.sendMessage(chatId, message);
    })
    .catch(err => {
      console.error('Analytics error:', err);
      bot.sendMessage(chatId, 'Произошла ошибка при получении статистики.');
    });
});

bot.on('message', async (msg) => {
  // Ignore /start and /analytics commands as they're handled separately
  if (msg.text && (msg.text.startsWith('/start') || msg.text.startsWith('/analytics'))) {
    return;
  }

  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const now = Date.now();

  // Check if user is already waiting for a response
  if (userPendingRequests.has(userId)) {
    bot.sendMessage(chatId, 'Не спамь! Я уже обрабатываю ваше предыдущее сообщение.');
    return;
  }

  // Check cooldown period (30 seconds)
  if (userCooldowns.has(userId)) {
    const cooldownEnd = userCooldowns.get(userId);
    if (now < cooldownEnd) {
      const remainingTime = Math.ceil((cooldownEnd - now) / 1000);
      bot.sendMessage(chatId, `Подождите еще ${remainingTime} секунд чтобы отправить сообщение.`);
      return;
    }
  }

  // Set user as having a pending request
  userPendingRequests.set(userId, true);
  
  // Set cooldown for 30 seconds from now
  userCooldowns.set(userId, now + 30000);

  console.log(`Processing message from user ${msg.from.username || userId}: ${msg.text}`);

  // Simulate "thinking" for 10 seconds
  setTimeout(async () => {
    // Remove user from pending requests
    userPendingRequests.delete(userId);
    
    // Generate AI response instead of echoing
    try {
      const aiResponse = await generateAIResponse(msg.text);
      bot.sendMessage(chatId, aiResponse);
    } catch (error) {
      console.error('Error generating AI response:', error);
      bot.sendMessage(chatId, 'Произошла ошибка при генерации ответа. Попробуйте еще раз.');
    }
  }, 10000);
});

console.log('Bot is running...');