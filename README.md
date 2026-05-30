# SpamHammer

Discord moderation bot (discord.js v14 + Redis) that automatically **flags** and **times out** users who perform image-based or cross-channel spam.

Key features:

- Detects the same image uploaded across multiple channels using perceptual hashing (pHash).
- Detects identical message content posted across multiple channels (cross-channel duplicates).

---

## Quick start

1. Clone and install dependencies

```bash
git clone https://github.com/GrahamSH-LLK/spam-nuker.git
cd spam-nuker
npm install
```

2. Configure environment

```bash
cp .env.example .env
# Edit .env and provide your DISCORD_TOKEN and other values
```

3. Build and run

```bash
npm run build   # compile TypeScript to dist/
npm start       # run the compiled bot
# or for development (no build step):
npm run dev
```

4. Run tests

```bash
npm test
```

## Docker Compose

You can run the bot and Redis together with Docker Compose:

```bash
cp .env.example .env
docker compose up --build
```

The compose file starts a Redis container for the bot and points `REDIS_URL` at the in-network Redis service automatically. Make sure `DISCORD_TOKEN` is set in your `.env` file before starting.

---

## Discord Developer Portal

Enable these Privileged Gateway Intents for your bot application:

- **Server Members Intent** – required to call `member.timeout()`
- **Message Content Intent** – required to read message content for duplicate detection

Required bot permissions in your guild:

- `View Channel` / `Read Message History`
- `Moderate Members` (for timeouts)
- `Send Messages` (for log-channel alerts)

---

## Configuration (.env)

Set the variables in your `.env` file. Common options include:

| Variable                                | Default                  | Description                                                 |
| --------------------------------------- | ------------------------ | ----------------------------------------------------------- |
| `DISCORD_TOKEN`                         | —                        | Your bot token                                              |
| `REDIS_URL`                             | `redis://localhost:6379` | Redis connection URL                                        |
| `TIMEOUT_DURATION`                      | `600`                    | Timeout length in **seconds**                               |
| `CROSS_CHANNEL_IMAGE_THRESHOLD`         | `2`                      | Images across multiple channels before flagging             |
| `CROSS_CHANNEL_IMAGE_CHANNEL_THRESHOLD` | `2`                      | Distinct channels required for cross-channel image flagging |
| `CROSS_CHANNEL_IMAGE_MAX_DISTANCE`      | `6`                      | Maximum pHash Hamming distance for image matches            |
| `CROSS_CHANNEL_IMAGE_WINDOW`            | `60`                     | Sliding window for cross-channel image detection            |
| `CROSS_CHANNEL_THRESHOLD`               | `3`                      | Channels a message may appear in before flagging            |
| `CROSS_CHANNEL_WINDOW`                  | `60`                     | Sliding window in seconds for cross-channel detection       |
| `LOG_CHANNEL_ID`                        | _(empty)_                | ID of the channel to post alerts in (optional)              |

---

## How it works (overview)

- Cross-channel image spam: downloads and hashes images with `@stabilityprotocol.com/phash`, stores recent pHashes in Redis, and times out users when matching pHash clusters exceed configured thresholds and span multiple channels.

- Cross-channel duplicate spam: hashes message content (SHA-256 truncated) and counts distinct channels per hash. Users are timed out if the same content appears across many channels in `CROSS_CHANNEL_WINDOW` seconds.

Tracking keys expire so users do not accumulate punishments over long periods.

---

## Development

- Build: `npm run build`
- Run compiled: `npm start`
- Run in dev (no build): `npm run dev`
- Tests: `npm test` (project uses `jest`)

If you add or modify types, ensure `tsc` compiles without errors.

---

## Contributing

Contributions are welcome. Open issues for bugs or feature requests, and submit PRs for fixes. Keep changes focused and include tests when possible.

---

## License

This project is published under the ISC license. See `package.json` for details.
