# RingNet CPBX - Modmail Ticket Bot

A Discord modmail bot for RingNet CPBX. Tickets are handled via direct messages between users and the bot, with staff managing conversations through dedicated ticket channels in the server.

---

## Features

- Reaction-based panel to open tickets
- Users can also DM the bot directly to open a ticket
- Staff reply via `?r` or anonymously via `?ar`
- Ticket transcripts saved as `.txt` files
- AUP violation tickets with fully anonymous staff replies
- Transfer tickets between categories
- Auto-close tickets after a set time
- Extension creation workflow with role assignment
- Error logging to a dedicated channel

---

## Requirements

- Node.js v16.9.0 or higher
- A Discord bot with the following enabled in the Developer Portal:
  - Server Members Intent
  - Message Content Intent
  - Direct Messages (enabled by default)

---

## Setup

### 1. Clone the repository

```bash
git clone <your-repo-url>
cd ringnet-cpbx-bot
```

### 2. Install dependencies

```bash
npm install
```

### 3. Configure environment variables

Copy or rename `.env` and fill in the required values:

```env
BOT_TOKEN=your_bot_token_here
GUILD_ID=your_server_id_here
NEW_LINE_ROLE=role_id_to_assign_on_extension_creation
ERROR_CHANNEL=channel_id_for_error_logs
```

The following values are already prefilled:

```env
STAFF_ROLE=1519477317930586152
CAT_MOD=1520935474263359498
CAT_PST=1520935445356089468
CAT_GEN=1520935518052024571
CAT_HOLD=1520935584468697168
TRANSCRIPT_CHANNEL=1520938699637129276
```

### 4. Invite the bot

Generate an invite URL from the Discord Developer Portal with the following permissions:

- Manage Channels
- View Channels
- Send Messages
- Embed Links
- Attach Files
- Read Message History
- Add Reactions
- Manage Messages
- Move Members (for category transfers)

Also ensure the bot has the `bot` and `applications.commands` scopes selected.

### 5. Start the bot

```bash
npm start
```

---

## Commands

All commands are prefix-based using `?`.

### Staff Commands

| Command | Description |
|---|---|
| `?sendpanel` | Posts the reaction panel in the current channel |
| `?r <message>` | Reply to the ticket user, showing your display name and role |
| `?ar <message>` | Reply anonymously as "RingNet Staff Team" |
| `?close [reason]` | Close the ticket with an optional reason |
| `?close Xm` | Auto-close the ticket after X minutes |
| `?close Xh` | Auto-close the ticket after X hours |
| `?contact <user> [reason]` | Open a ticket on behalf of a user |
| `?aupcontact <user>` | Open an AUP violation ticket for a user |
| `?modsend` | Transfer ticket to Moderation category |
| `?mailgensend` | Transfer ticket to General Modmail category |
| `?pstsend` | Transfer ticket to Phone System Staff category |
| `?holdticket` | Place ticket on hold |
| `?extensioncreated` | Log extension details and send them to the user |

---

## How It Works

### Opening a Ticket

Tickets can be opened three ways:

1. A user reacts with the envelope emoji on a panel posted with `?sendpanel`
2. A user DMs the bot directly
3. Staff manually open one with `?contact` or `?aupcontact`

Once opened, a channel is created in the General Modmail category (or Moderation for AUP). The user receives a DM confirming their ticket is open.

### Replying

Staff reply from within the ticket channel using `?r` or `?ar`. The command message is deleted and an embed is sent both to the user via DM and posted in the ticket channel.

- `?r` shows the staff member's display name and their highest server role
- `?ar` shows "RingNet Staff Team" with no identifying information

### Closing

When `?close` is run, a transcript is generated as a `.txt` file and sent to the transcript channel and the user via DM. The ticket channel is deleted after 5 seconds.

For timed closes (`?close 30m`, `?close 2h`), a Discord timestamp is posted in the channel showing when it will close.

### AUP Tickets

AUP tickets created with `?aupcontact` are placed in the Moderation category. All staff replies in these tickets are automatically anonymous regardless of whether `?r` or `?ar` is used.

---

## File Structure

```
ringnet-cpbx-bot/
├── index.js          # Main bot file
├── package.json      # Dependencies
├── .env              # Environment variables (do not commit)
├── counter.json      # Auto-generated ticket counter (do not commit)
├── .gitignore
├── README.md
├── CODE_OF_CONDUCT.md
└── ADDITIONAL_LICENSE_INFO.md
```

---

## License

This project is licensed under the GNU General Public License v3.0. See `ADDITIONAL_LICENSE_INFO.md` for details.
