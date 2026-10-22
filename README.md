# SpamHammer

Discord moderation bot that automatically flags and times out users who post the same image or message across multiple channels. It also handles reminders and emoji submissions.

---

## Quick start

```bash
git clone https://github.com/GrahamSH-LLK/spam-nuker.git
cd spam-nuker
npm install
cp .env.example .env   # set DISCORD_TOKEN and anything else you need
npm run build && npm start
```

For development, use `npm run dev` (no build step). Run tests with `npm test`.

### Docker Compose

```bash
cp .env.example .env
docker compose up --build
```

This starts the bot together with Redis. Make sure `DISCORD_TOKEN` is set in `.env`.

---

## Discord setup

Enable the **Server Members** and **Message Content** privileged intents for your bot application.

Invite the bot with the `bot` and `applications.commands` scopes and these permissions:

- View Channel, Read Message History
- Moderate Members
- Send Messages, Attach Files, Embed Links, Add Reactions

---

## Commands

### `/spam-config`

Per-server settings, available to members with **Manage Server**:

- `view` — show current settings
- `set setting:<name> value:<number>` — override a setting
- `log-channel channel:#alerts` — set the alert channel (omit to disable)
- `emoji-channel channel:#emoji-votes` — set the emoji submission channel (omit to disable)
- `reset [setting]` — remove one override, or all of them

### `/remind`

`/remind when:<time> [message:<text>]` mentions you in the same channel at the chosen time, e.g. `in 2 hours`, `tomorrow at 9am EDT`, or `next Friday at 9am UTC`. Times without a timezone default to Eastern Time.

Prefix forms also work: `v?remind in 2 hours to call mom`, `v?rem tomorrow at 7am` (or `v‽`).

Cancel a reminder you created with `/cancel id:<ID>` or `v?cancel <ID>`.

### `/submit-emoji`

`/submit-emoji image:<file> name:<name>` proposes a custom emoji. Submissions go to the log channel for a moderator to approve or deny; approved ones are posted in the emoji channel for voting. Both channels must be configured. Each member gets two submissions per server.

---

## Configuration (.env)

These values are global defaults; servers can override them with `/spam-config`.

| Variable                                | Default                  | Description                                          |
| --------------------------------------- | ------------------------ | ---------------------------------------------------- |
| `DISCORD_TOKEN`                         | —                        | Bot token                                            |
| `REDIS_URL`                             | `redis://localhost:6379` | Redis connection URL                                 |
| `TIMEOUT_DURATION`                      | `600`                    | Timeout length in seconds                            |
| `CROSS_CHANNEL_IMAGE_THRESHOLD`         | `2`                      | Matching images before flagging                      |
| `CROSS_CHANNEL_IMAGE_CHANNEL_THRESHOLD` | `2`                      | Distinct channels required for image flagging        |
| `CROSS_CHANNEL_IMAGE_MAX_DISTANCE`      | `6`                      | How similar images must be to match (lower = stricter) |
| `CROSS_CHANNEL_IMAGE_WINDOW`            | `60`                     | Image detection window in seconds                    |
| `CROSS_CHANNEL_THRESHOLD`               | `3`                      | Channels a message may appear in before flagging     |
| `CROSS_CHANNEL_WINDOW`                  | `60`                     | Message detection window in seconds                  |
| `TYPESAFE_API_KEY`                      | —                        | Enables Jev moderation when an alert channel is set  |

---

## Contributing

Issues and PRs are welcome. Keep changes focused and include tests when possible.

## License

ISC
