# spam-nuker

A Discord bot (discord.js v14 + Redis) that automatically **times out** and **flags** users who:

1. **Send messages containing multiple images from external servers** within a configurable time window.
2. **Send the same message across multiple channels** in a short period (cross-channel spam).

---

## Requirements

| Requirement | Version |
|-------------|---------|
| Node.js | ≥ 18 |
| Redis | ≥ 6 |

---

## Setup

```bash
# 1. Clone the repo and install dependencies
npm install

# 2. Copy the example env file and fill in your values
cp .env.example .env

# 3. Start the bot
npm start
```

### Discord Developer Portal

Enable the following **Privileged Gateway Intents** for your application:

- **Server Members Intent** – required to call `member.timeout()`
- **Message Content Intent** – required to read message content for duplicate detection

Grant the bot at least the following permissions in your server:

- `View Channel` / `Read Message History`
- `Moderate Members` (for timeouts)
- `Send Messages` (for log-channel alerts)

---

## Configuration (`.env`)

| Variable | Default | Description |
|----------|---------|-------------|
| `DISCORD_TOKEN` | — | Your bot token |
| `REDIS_URL` | `redis://localhost:6379` | Redis connection URL |
| `TIMEOUT_DURATION` | `600` | Timeout length in **seconds** |
| `IMAGE_THRESHOLD` | `3` | External images per window before flagging |
| `IMAGE_WINDOW` | `60` | Sliding window in seconds for image counting |
| `CROSS_CHANNEL_THRESHOLD` | `3` | Channels a message may appear in before flagging |
| `CROSS_CHANNEL_WINDOW` | `60` | Sliding window in seconds for cross-channel detection |
| `LOG_CHANNEL_ID` | *(empty)* | ID of the channel to post alerts in (optional) |

---

## How it works

### External-image spam

Each time a user posts a message the bot counts attachments with an `image/*` content type **and** embed images/thumbnails whose hostname is **not** a Discord-owned domain (`cdn.discordapp.com`, `media.discordapp.net`, etc.).  For Discord CDN attachment URLs, it also treats them as suspicious when the URL contains an `/attachments/<serverId>/...` path and `<serverId>` does not match the current server. Those counts are accumulated in a Redis sorted-set per `(guild, user)` over the `IMAGE_WINDOW` second sliding window.  When the total reaches `IMAGE_THRESHOLD` the user is timed out.

### Cross-channel duplicate spam

Each message's content is hashed (SHA-256, truncated to 16 hex chars) and stored in a Redis sorted-set keyed by `(guild, user, hash)`.  The member is the channel ID, so each channel only counts once per message hash.  When the same content appears in `CROSS_CHANNEL_THRESHOLD` or more distinct channels within `CROSS_CHANNEL_WINDOW` seconds, the user is timed out.

In both cases the tracking key is deleted immediately after a timeout so the user starts fresh.