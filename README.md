# Telegram Bot

This is a simple Telegram bot that:
- Welcomes users on `/start` command
- Uses Groq AI API with the `llama3-8b-8192` model to generate responses
- Prevents spam by telling users not to spam while processing
- Implements a 30-second cooldown period between messages
- Tracks user analytics in an SQLite database

## Setup

1. Create a new bot with [BotFather](https://t.me/BotFather) on Telegram and get your bot token
2. Get your Groq API key from [Groq Console](https://console.groq.com)
3. Update the `.env` file with your tokens:
   ```
   TELEGRAM_BOT_TOKEN=your_actual_bot_token_here
   GROQ_API_KEY=your_groq_api_key_here
   ```
4. Install dependencies:
   ```
   npm install
   ```
5. Run the bot:
   ```
   npm start
   ```

## Features

- **Welcome Message**: When a user sends `/start`, the bot responds with a welcome message
- **AI Response Generation**: When a user sends any other message, the bot:
  1. Waits for 10 seconds (simulating processing)
  2. Sends the message to Groq AI API using the `llama3-8b-8192` model
  3. Returns the AI-generated response to the user
- **Spam Prevention**: 
  - If a user sends another message while the bot is processing a previous message, they'll receive a "Don't spam" message
  - Users can only send one message every 30 seconds
  - If a user tries to send a message before the cooldown ends, they'll be told how many seconds they need to wait
- **Analytics**: 
  - User 'indiwide' can access analytics with the `/analytics` command
  - Shows total subscribers, daily subscribers, and weekly subscribers

## How It Works

The bot uses two Maps to track:
1. `userPendingRequests`: Tracks which users have pending requests being processed
2. `userCooldowns`: Tracks when each user's cooldown period ends

When a message arrives:
1. The bot checks if the user already has a pending request
2. The bot checks if the user is still in their cooldown period
3. If both checks pass, the bot sets the user as having a pending request and starts the cooldown
4. After 10 seconds, the bot sends the message to the Groq AI API and sends the response back to the user

The bot also uses SQLite to track:
1. User information (Telegram ID, username, name)
2. Signup analytics (when users join the bot)