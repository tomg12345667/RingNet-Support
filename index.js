const {
  Client,
  GatewayIntentBits,
  Partials,
  ChannelType,
  PermissionFlagsBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  AttachmentBuilder,
} = require("discord.js");
const fs   = require("fs");
const path = require("path");
require("dotenv").config();

// ─── Config ───────────────────────────────────────────────────────────────────
const GUILD_ID           = process.env.GUILD_ID;
const STAFF_ROLE         = process.env.STAFF_ROLE;
const CAT_MOD            = process.env.CAT_MOD;
const CAT_PST            = process.env.CAT_PST;
const CAT_GEN            = process.env.CAT_GEN;
const CAT_HOLD           = process.env.CAT_HOLD;
const ERROR_CHANNEL      = process.env.ERROR_CHANNEL;
const TRANSCRIPT_CHANNEL = process.env.TRANSCRIPT_CHANNEL; // 1520938699637129276
const PANEL_EMOJI        = "✉️";

// ─── Counter ──────────────────────────────────────────────────────────────────
const COUNTER_FILE = path.join(__dirname, "counter.json");
function loadCounter() {
  try { if (fs.existsSync(COUNTER_FILE)) return JSON.parse(fs.readFileSync(COUNTER_FILE, "utf-8")).counter ?? 1; } catch {}
  return 1;
}
function saveCounter(val) { fs.writeFileSync(COUNTER_FILE, JSON.stringify({ counter: val }), "utf-8"); }
let ticketCounter = loadCounter();
function nextTicketNumber() { const n = ticketCounter++; saveCounter(ticketCounter); return n; }

// ─── Registries ───────────────────────────────────────────────────────────────
const ticketRegistry = new Map(); // channelId -> { ticketNumber, userId, userTag, openedAt, isAup, closeTimeout }
const userTicketMap  = new Map(); // userId -> channelId
const panelMessages  = new Set(); // messageId
const pendingExtData = new Map(); // userId -> ext data

// ─── Client ───────────────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.DirectMessageReactions,
  ],
  partials: [Partials.Channel, Partials.Message, Partials.Reaction],
});

client.once("ready", () => console.log(`Logged in as ${client.user.tag} | Ticket counter: #${ticketCounter}`));

// ─── Error reporter ───────────────────────────────────────────────────────────
async function reportError(err, context = "") {
  console.error(`[ERROR] ${context}`, err);
  try {
    const ch = await client.channels.fetch(ERROR_CHANNEL);
    if (ch) await ch.send(`**Bot Error** ${context ? `(${context})` : ""}\n\`\`\`\n${err?.stack ?? err}\n\`\`\``);
  } catch {}
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function isStaff(member) {
  return member?.roles?.cache?.has(STAFF_ROLE) ?? false;
}

function getHighestRoleName(member) {
  const roles = member.roles.cache
    .filter(r => r.id !== member.guild.id)
    .sort((a, b) => b.position - a.position);
  return roles.first()?.name ?? "Member";
}

async function resolveUser(guild, input) {
  const idMatch = input.match(/^<@!?(\d+)>$/) || input.match(/^(\d+)$/);
  if (idMatch) {
    try { return await client.users.fetch(idMatch[1]); } catch {}
  }
  try {
    await guild.members.fetch();
    const member = guild.members.cache.find(m =>
      m.user.username.toLowerCase() === input.toLowerCase() ||
      m.user.tag.toLowerCase() === input.toLowerCase()
    );
    return member?.user ?? null;
  } catch {}
  return null;
}

// ─── Ticket creation ──────────────────────────────────────────────────────────
async function createTicket(guild, user, { category = CAT_GEN, isAup = false, manualReason = null } = {}) {
  if (userTicketMap.has(user.id)) {
    const existingId = userTicketMap.get(user.id);
    const existing   = guild.channels.cache.get(existingId);
    if (existing) return { channel: existing, ticketNumber: ticketRegistry.get(existingId)?.ticketNumber, alreadyOpen: true };
  }

  const ticketNumber = nextTicketNumber();
  const channelName  = user.username.toLowerCase().replace(/[^a-z0-9]/g, "-").slice(0, 90);

  const channel = await guild.channels.create({
    name: channelName,
    type: ChannelType.GuildText,
    parent: category,
    topic: `Ticket #${ticketNumber} | ${user.tag} | ${user.id}${isAup ? " | AUP" : ""}`,
  });

  ticketRegistry.set(channel.id, {
    ticketNumber, userId: user.id, userTag: user.tag,
    openedAt: new Date(), isAup, closeTimeout: null,
    messages: [], // store { time, author, content } for transcript
  });
  userTicketMap.set(user.id, channel.id);

  const embed = new EmbedBuilder()
    .setTitle(`Ticket #${ticketNumber}`)
    .setColor(isAup ? 0xed4245 : 0x5865f2)
    .addFields(
      { name: "User",   value: `<@${user.id}> (${user.tag})`, inline: true },
      { name: "Ticket", value: `#${ticketNumber}`,             inline: true },
      { name: "Type",   value: isAup ? "AUP Violation" : "General", inline: true },
    );
  if (manualReason) embed.addFields({ name: "Reason", value: manualReason });
  embed.setFooter({ text: "?r <msg> to reply | ?ar <msg> for anonymous | ?close to close" }).setTimestamp();

  await channel.send({ content: `<@&${STAFF_ROLE}>`, embeds: [embed] });

  try {
    await user.send(
      isAup
        ? "You have been contacted by the RingNet moderation team regarding your account. A staff member will be in touch shortly."
        : "Your ticket has been opened with RingNet CPBX support. A staff member will be in touch shortly. Please describe your issue and we will get back to you."
    );
  } catch { await channel.send("Note: Could not DM the user. They may have DMs disabled."); }

  return { channel, ticketNumber, alreadyOpen: false };
}

// ─── Transcript as .txt file ──────────────────────────────────────────────────
async function sendTranscript(channel, ticketData, reason, closedByTag) {
  // Fetch all messages from channel
  const messages = [];
  let lastId;
  while (true) {
    const opts = { limit: 100 };
    if (lastId) opts.before = lastId;
    const batch = await channel.messages.fetch(opts);
    if (batch.size === 0) break;
    messages.push(...batch.values());
    lastId = batch.last().id;
    if (batch.size < 100) break;
  }
  messages.reverse();

  const lines = [
    "RINGNET CPBX - TICKET TRANSCRIPT",
    "=================================",
    "",
    `Ticket    : #${ticketData?.ticketNumber ?? "?"}`,
    `User      : ${ticketData?.userTag ?? "Unknown"}`,
    `Opened at : ${new Date(ticketData?.openedAt ?? Date.now()).toLocaleString()}`,
    `Closed by : ${closedByTag}`,
    `Reason    : ${reason}`,
    "",
    "---",
    "",
  ];

  for (const msg of messages) {
    if (msg.author.bot && msg.embeds.length > 0 && !msg.content) continue;
    const time   = new Date(msg.createdTimestamp).toLocaleString();
    const author = msg.author.id === client.user.id
      ? (msg.embeds[0]?.author?.name ?? "[Bot]")
      : msg.author.tag;
    const text = msg.content || (msg.embeds[0]?.description ?? (msg.embeds[0]?.title ? `[Embed: ${msg.embeds[0].title}]` : "[No content]"));
    lines.push(`[${time}] ${author}`);
    lines.push(`  ${text}`);
    if (msg.attachments.size > 0) lines.push(`  Attachments: ${[...msg.attachments.values()].map(a => a.url).join(", ")}`);
    lines.push("");
  }

  lines.push("---");
  lines.push("End of transcript");

  const transcript = lines.join("\n");
  const fileName   = `transcript-${ticketData?.ticketNumber ?? channel.id}.txt`;
  const buffer     = Buffer.from(transcript, "utf-8");
  const attachment = new AttachmentBuilder(buffer, { name: fileName });

  // DM user the transcript
  try {
    const user = await client.users.fetch(ticketData.userId);
    await user.send({ content: `Transcript for your ticket #${ticketData?.ticketNumber ?? "?"}:`, files: [new AttachmentBuilder(buffer, { name: fileName })] });
  } catch {}

  // Post to transcript channel
  if (TRANSCRIPT_CHANNEL) {
    try {
      const tc = await client.channels.fetch(TRANSCRIPT_CHANNEL);
      await tc.send({
        embeds: [new EmbedBuilder()
          .setTitle(`Transcript - Ticket #${ticketData?.ticketNumber ?? "?"}`)
          .setColor(0x5865f2)
          .addFields(
            { name: "User",      value: `<@${ticketData.userId}>`, inline: true },
            { name: "Closed By", value: closedByTag,               inline: true },
            { name: "Reason",    value: reason },
          ).setTimestamp()],
        files: [new AttachmentBuilder(buffer, { name: fileName })],
      });
    } catch (err) { await reportError(err, "sendTranscript"); }
  }
}

// ─── Close ticket ─────────────────────────────────────────────────────────────
async function closeTicket(channel, ticketData, reason, closedByTag) {
  if (ticketData.closeTimeout) clearTimeout(ticketData.closeTimeout);

  try { await sendTranscript(channel, ticketData, reason, closedByTag); } catch (err) { await reportError(err, "closeTicket > sendTranscript"); }

  try {
    const user = await client.users.fetch(ticketData.userId);
    await user.send(`Your ticket #${ticketData.ticketNumber} has been closed.\nReason: ${reason}`);
  } catch {}

  await channel.send({
    embeds: [new EmbedBuilder()
      .setTitle("Ticket Closed")
      .setColor(0xed4245)
      .addFields(
        { name: "Closed By", value: closedByTag, inline: true },
        { name: "Reason",    value: reason,       inline: true },
      ).setTimestamp()],
  });

  userTicketMap.delete(ticketData.userId);
  ticketRegistry.delete(channel.id);

  setTimeout(async () => {
    try { await channel.delete(`Closed by ${closedByTag}: ${reason}`); } catch {}
  }, 5000);
}

// ─── Send reply embed to user + channel ───────────────────────────────────────
async function sendReply(message, text, isAnon) {
  const ticketData = ticketRegistry.get(message.channel.id);
  if (!ticketData) { await message.reply("This is not a ticket channel."); return; }
  if (!text) { await message.reply(`Usage: ${isAnon ? "?ar" : "?r"} <message>`); return; }

  const member      = message.member;
  const displayName = isAnon ? "RingNet Staff Team" : (member.nickname ?? member.user.username);
  const roleName    = isAnon ? "Staff Team" : getHighestRoleName(member);
  const avatar      = isAnon ? client.user.displayAvatarURL() : member.user.displayAvatarURL({ dynamic: true });
  const color       = isAnon ? 0x5865f2 : (member.displayColor || 0x5865f2);

  const userEmbed = new EmbedBuilder()
    .setAuthor({ name: displayName, iconURL: avatar })
    .setDescription(text)
    .setColor(color)
    .setFooter({ text: roleName })
    .setTimestamp();

  const channelEmbed = new EmbedBuilder()
    .setAuthor({ name: `${displayName} → ${ticketData.userTag}`, iconURL: avatar })
    .setDescription(text)
    .setColor(color)
    .setFooter({ text: roleName })
    .setTimestamp();

  // Delete the command message
  try { await message.delete(); } catch {}

  // Send to user via DM
  try {
    const user = await client.users.fetch(ticketData.userId);
    await user.send({ embeds: [userEmbed] });
  } catch {
    await message.channel.send("Could not DM the user — they may have DMs disabled.");
  }

  // Send embed to ticket channel
  await message.channel.send({ embeds: [channelEmbed] });
}

// ─── Reaction handler ─────────────────────────────────────────────────────────
client.on("messageReactionAdd", async (reaction, user) => {
  try {
    if (user.bot) return;
    if (reaction.emoji.name !== "✉️") return;
    if (!panelMessages.has(reaction.message.id)) return;

    try { await reaction.users.remove(user.id); } catch {}

    const guild = reaction.message.guild;
    if (!guild) return;

    const { channel, ticketNumber, alreadyOpen } = await createTicket(guild, user);
    if (alreadyOpen) {
      try { await user.send("You already have an open ticket. A staff member will be in touch."); } catch {}
    }
  } catch (err) { await reportError(err, "messageReactionAdd"); }
});

// ─── DM handler ───────────────────────────────────────────────────────────────
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  if (!message.guild) {
    const guild = await client.guilds.fetch(GUILD_ID).catch(() => null);
    if (!guild) return;

    if (userTicketMap.has(message.author.id)) {
      const channelId = userTicketMap.get(message.author.id);
      try {
        const channel    = await client.channels.fetch(channelId);
        const ticketData = ticketRegistry.get(channelId);
        const embed = new EmbedBuilder()
          .setAuthor({ name: message.author.tag, iconURL: message.author.displayAvatarURL() })
          .setDescription(message.content || "[No text content]")
          .setColor(0x5865f2)
          .setTimestamp();
        await channel.send({ embeds: [embed] });
        if (message.attachments.size > 0) await channel.send({ files: [...message.attachments.values()].map(a => a.url) });
      } catch (err) { await reportError(err, "DM forward"); }
      return;
    }

    // Open new ticket from DM
    try {
      const { channel, ticketNumber } = await createTicket(guild, message.author);
      const embed = new EmbedBuilder()
        .setAuthor({ name: message.author.tag, iconURL: message.author.displayAvatarURL() })
        .setDescription(message.content || "[No text content]")
        .setColor(0x5865f2)
        .setTimestamp();
      await channel.send({ embeds: [embed] });
      await message.reply(`Your ticket (#${ticketNumber}) has been opened. A staff member will be in touch shortly.`);
    } catch (err) { await reportError(err, "DM open ticket"); }
    return;
  }

  // ── Server commands ────────────────────────────────────────────────────────
  if (!message.content.startsWith("?")) return;
  const member  = message.member;
  const content = message.content;

  // ── ?sendpanel ──
  if (content.startsWith("?sendpanel")) {
    if (!isStaff(member)) return message.reply("Only staff can deploy panels.");
    const sent = await message.channel.send(
      `React with ✉️ to open a support ticket with RingNet CPBX. A staff member will be in touch via this bot.`
    );
    await sent.react("✉️");
    panelMessages.add(sent.id);
    await message.delete().catch(() => {});
    return;
  }

  // ── ?r <message> ──
  if (content.startsWith("?r ") || content === "?r") {
    const text = content.startsWith("?r ") ? content.slice(3).trim() : "";
    await sendReply(message, text, false);
    return;
  }

  // ── ?ar <message> ──
  if (content.startsWith("?ar ") || content === "?ar") {
    const text = content.startsWith("?ar ") ? content.slice(4).trim() : "";
    await sendReply(message, text, true);
    return;
  }

  // ── ?close [reason | Xm | Xh] ──
  if (content.startsWith("?close")) {
    const ticketData = ticketRegistry.get(message.channel.id);
    if (!ticketData) return message.reply("This is not a ticket channel.");

    const arg    = content.slice("?close".length).trim();
    const timeRx = arg.match(/^(\d+)(m|h)$/i);

    if (timeRx) {
      const amount  = parseInt(timeRx[1], 10);
      const unit    = timeRx[2].toLowerCase();
      const ms      = unit === "h" ? amount * 3600000 : amount * 60000;
      const closeAt = new Date(Date.now() + ms);
      const ts      = Math.floor(closeAt.getTime() / 1000);

      await message.channel.send(`This ticket will be closed <t:${ts}:R> (<t:${ts}:f>).`);

      if (ticketData.closeTimeout) clearTimeout(ticketData.closeTimeout);
      ticketData.closeTimeout = setTimeout(async () => {
        const ch = await client.channels.fetch(message.channel.id).catch(() => null);
        const td = ticketRegistry.get(message.channel.id);
        if (ch && td) await closeTicket(ch, td, `Auto-closed after ${amount}${unit}`, "Auto-close");
      }, ms);
      ticketRegistry.set(message.channel.id, ticketData);
      return;
    }

    const reason = arg || "No reason provided";
    await closeTicket(message.channel, ticketData, reason, message.author.tag);
    return;
  }

  // ── ?contact <user> [reason] ──
  if (content.startsWith("?contact")) {
    if (!isStaff(member)) return message.reply("Only staff can use this command.");
    const arg   = content.slice("?contact".length).trim();
    const parts = arg.match(/^(\S+)(?:\s+(.+))?$/s);
    if (!parts) return message.reply("Usage: ?contact <username or user id> [reason]");

    const user = await resolveUser(message.guild, parts[1]);
    if (!user) return message.reply("Could not find that user.");

    try {
      const { channel, ticketNumber, alreadyOpen } = await createTicket(message.guild, user, { manualReason: parts[2]?.trim() || null });
      if (alreadyOpen) return message.reply(`That user already has an open ticket: ${channel}`);
      await message.reply({ content: `Ticket #${ticketNumber} opened for <@${user.id}>: ${channel}`, allowedMentions: { parse: [] } });
    } catch (err) { await reportError(err, "?contact"); await message.reply("Failed to create the ticket."); }
    return;
  }

  // ── ?aupcontact <user> ──
  if (content.startsWith("?aupcontact")) {
    if (!isStaff(member)) return message.reply("Only staff can use this command.");
    const userInput = content.slice("?aupcontact".length).trim();
    if (!userInput) return message.reply("Usage: ?aupcontact <username or user id>");

    const user = await resolveUser(message.guild, userInput);
    if (!user) return message.reply("Could not find that user.");

    try {
      const { channel, ticketNumber, alreadyOpen } = await createTicket(message.guild, user, { category: CAT_MOD, isAup: true });
      if (alreadyOpen) return message.reply(`That user already has an open ticket: ${channel}`);
      await message.reply({ content: `AUP ticket #${ticketNumber} opened for <@${user.id}>: ${channel}`, allowedMentions: { parse: [] } });
    } catch (err) { await reportError(err, "?aupcontact"); await message.reply("Failed to create the ticket."); }
    return;
  }

  // ── ?modsend ──
  if (content.startsWith("?modsend")) {
    if (!ticketRegistry.has(message.channel.id)) return message.reply("This is not a ticket channel.");
    try { await message.channel.setParent(CAT_MOD, { lockPermissions: false }); await message.channel.send("Ticket transferred to Moderation category."); }
    catch (err) { await reportError(err, "?modsend"); }
    return;
  }

  // ── ?mailgensend ──
  if (content.startsWith("?mailgensend")) {
    if (!ticketRegistry.has(message.channel.id)) return message.reply("This is not a ticket channel.");
    try { await message.channel.setParent(CAT_GEN, { lockPermissions: false }); await message.channel.send("Ticket transferred to General Modmail category."); }
    catch (err) { await reportError(err, "?mailgensend"); }
    return;
  }

  // ── ?pstsend ──
  if (content.startsWith("?pstsend")) {
    if (!ticketRegistry.has(message.channel.id)) return message.reply("This is not a ticket channel.");
    try { await message.channel.setParent(CAT_PST, { lockPermissions: false }); await message.channel.send("Ticket transferred to Phone System Staff category."); }
    catch (err) { await reportError(err, "?pstsend"); }
    return;
  }

  // ── ?holdticket ──
  if (content.startsWith("?holdticket")) {
    if (!ticketRegistry.has(message.channel.id)) return message.reply("This is not a ticket channel.");
    try {
      await message.channel.setParent(CAT_HOLD, { lockPermissions: false });
      await message.channel.send("Ticket placed on hold.");
      const ticketData = ticketRegistry.get(message.channel.id);
      try { const user = await client.users.fetch(ticketData.userId); await user.send("Your ticket has been placed on hold. A staff member will follow up soon."); } catch {}
    } catch (err) { await reportError(err, "?holdticket"); }
    return;
  }

  // ── ?extensioncreated ──
  if (content.startsWith("?extensioncreated")) {
    if (!isStaff(member)) return message.reply("Only staff can use this command.");
    await message.reply({
      content: "Click below to enter the extension details.",
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("extensioncreated_open").setLabel("Enter Extension Details").setStyle(ButtonStyle.Primary)
      )],
    });
    return;
  }
});

// ─── Interaction Handler ──────────────────────────────────────────────────────
client.on("interactionCreate", async (interaction) => {
  try {

    if (interaction.isButton() && interaction.customId === "extensioncreated_open") {
      const modal = new ModalBuilder().setCustomId("extensioncreated_submit").setTitle("Extension Created");
      modal.addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("ext_number").setLabel("Extension").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(20)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("ext_secret").setLabel("Secret").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("sip_server").setLabel("SIP Server").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(200)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("sip_port").setLabel("SIP Port").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(10)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("caller_id").setLabel("Caller ID").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100)),
      );
      await interaction.showModal(modal);
      return;
    }

    if (interaction.isModalSubmit() && interaction.customId === "extensioncreated_submit") {
      const ext      = interaction.fields.getTextInputValue("ext_number").trim();
      const secret   = interaction.fields.getTextInputValue("ext_secret").trim();
      const sipSrv   = interaction.fields.getTextInputValue("sip_server").trim();
      const sipPort  = interaction.fields.getTextInputValue("sip_port").trim();
      const callerId = interaction.fields.getTextInputValue("caller_id").trim();

      pendingExtData.set(interaction.user.id, { ext, secret, sipSrv, sipPort, callerId, channelId: interaction.channel.id });

      await interaction.reply({
        content: "First step saved. Click below to enter voicemail details.",
        ephemeral: true,
        components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId("extensioncreated_vm").setLabel("Continue - Voicemail Details").setStyle(ButtonStyle.Primary)
        )],
      });
      return;
    }

    if (interaction.isButton() && interaction.customId === "extensioncreated_vm") {
      const modal = new ModalBuilder().setCustomId("extensioncreated_vm_submit").setTitle("Voicemail Details");
      modal.addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("voicemail").setLabel("Voicemail?").setPlaceholder("Yes or No").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(10)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("vm_pin").setLabel("Voicemail PIN (optional)").setPlaceholder("Leave blank if not required").setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(20)),
      );
      await interaction.showModal(modal);
      return;
    }

    if (interaction.isModalSubmit() && interaction.customId === "extensioncreated_vm_submit") {
      const pending = pendingExtData.get(interaction.user.id);
      if (!pending) return interaction.reply({ content: "Session expired. Please run ?extensioncreated again.", ephemeral: true });
      pendingExtData.delete(interaction.user.id);

      const { ext, secret, sipSrv, sipPort, callerId, channelId } = pending;
      const voicemail = interaction.fields.getTextInputValue("voicemail").trim();
      const vmPin     = interaction.fields.getTextInputValue("vm_pin").trim();

      let targetChannel;
      try { targetChannel = await client.channels.fetch(channelId); }
      catch { return interaction.reply({ content: "Could not find the original channel.", ephemeral: true }); }

      await targetChannel.send({
        embeds: [new EmbedBuilder()
          .setTitle("Extension Created")
          .setColor(0x57f287)
          .addFields(
            { name: "Extension",     value: ext,                     inline: true },
            { name: "Secret",        value: secret,                  inline: true },
            { name: "SIP Server",    value: sipSrv,                  inline: true },
            { name: "SIP Port",      value: sipPort,                 inline: true },
            { name: "Caller ID",     value: callerId,                inline: true },
            { name: "Voicemail",     value: voicemail,               inline: true },
            { name: "Voicemail PIN", value: vmPin || "Not provided", inline: true },
          )
          .setFooter({ text: `Created by ${interaction.user.tag}` })
          .setTimestamp()],
      });

      const ticketData = ticketRegistry.get(channelId);
      if (ticketData) {
        try {
          const user = await client.users.fetch(ticketData.userId);
          await user.send({
            embeds: [new EmbedBuilder()
              .setTitle("Your Extension Details")
              .setColor(0x57f287)
              .addFields(
                { name: "Extension",     value: ext,                     inline: true },
                { name: "Secret",        value: secret,                  inline: true },
                { name: "SIP Server",    value: sipSrv,                  inline: true },
                { name: "SIP Port",      value: sipPort,                 inline: true },
                { name: "Caller ID",     value: callerId,                inline: true },
                { name: "Voicemail",     value: voicemail,               inline: true },
                ...(vmPin ? [{ name: "Voicemail PIN", value: vmPin, inline: true }] : []),
              )
              .setFooter({ text: "RingNet CPBX" })
              .setTimestamp()],
          });
        } catch {}
      }

      const openerId = ticketData?.userId;
      await interaction.reply({
        ephemeral: true,
        embeds: [new EmbedBuilder()
          .setTitle("Role Assignment")
          .setDescription(`Would you like to grant <@${openerId ?? "the ticket opener"}> the new line role?`)
          .setColor(0xfee75c)],
        components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`grant_role:${openerId}`).setLabel("Yes").setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId("grant_role_no").setLabel("No").setStyle(ButtonStyle.Danger),
        )],
      });
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith("grant_role:")) {
      const targetId = interaction.customId.split(":")[1];
      const roleId   = process.env.NEW_LINE_ROLE;
      if (!roleId) return interaction.update({ content: "NEW_LINE_ROLE not configured in .env.", embeds: [], components: [] });
      try {
        const mem = await interaction.guild.members.fetch(targetId);
        await mem.roles.add(roleId);
        await interaction.update({ content: `Role granted to <@${targetId}>.`, embeds: [], components: [] });
      } catch (err) {
        await reportError(err, "grant_role");
        await interaction.update({ content: "Failed to assign the role.", embeds: [], components: [] });
      }
      return;
    }

    if (interaction.isButton() && interaction.customId === "grant_role_no") {
      await interaction.update({ content: "Role not assigned.", embeds: [], components: [] });
      return;
    }

  } catch (err) {
    await reportError(err, `interactionCreate: ${interaction.customId ?? "unknown"}`);
  }
});

client.login(process.env.BOT_TOKEN);
