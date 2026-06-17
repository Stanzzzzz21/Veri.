import {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  ThreadAutoArchiveDuration,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  AttachmentBuilder,
  EmbedBuilder,
  Collection
} from 'discord.js';
import { createCanvas } from 'canvas';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_PATH = path.join(__dirname, 'veri-data.json');

const BOT_TOKEN = process.env.BOT_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const PORT = process.env.PORT || 3000;

if (!BOT_TOKEN || !CLIENT_ID) {
  console.error('BOT_TOKEN and CLIENT_ID must be set as environment variables.');
  process.exit(1);
}

// tiny HTTP server so Render keeps the service alive
http
  .createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Veri bot is running\n');
  })
  .listen(PORT, () => {
    console.log(`Web service running on port ${PORT}`);
  });

// basic JSON store
function loadData() {
  if (!fs.existsSync(DATA_PATH)) {
    fs.writeFileSync(
      DATA_PATH,
      JSON.stringify(
        {
          verifiedUsers: {},
          guilds: {}
        },
        null,
        2
      )
    );
  }
  const raw = fs.readFileSync(DATA_PATH, 'utf8');
  return JSON.parse(raw);
}

function saveData(newData) {
  fs.writeFileSync(DATA_PATH, JSON.stringify(newData, null, 2));
}

let data = loadData();

function getGuildConfig(guildId) {
  if (!data.guilds[guildId]) {
    data.guilds[guildId] = {
      verificationChannelId: null,
      logsChannelId: null,
      honeypotChannelId: null,
      honeypotPunishment: 'timeout', // timeout | kick | ban
      honeypotTimeoutMinutes: 10,
      verificationRoleId: null,
      captchaEnabled: true,
      honeypotEnabled: true
    };
    saveData(data);
  }
  return data.guilds[guildId];
}

function getUserRecord(userId) {
  if (!data.verifiedUsers[userId]) {
    data.verifiedUsers[userId] = {
      firstVerified: null,
      servers: [],
      fails: 0,
      honeypotTriggers: 0,
      lastVerification: null
    };
    saveData(data);
  }
  return data.verifiedUsers[userId];
}

// captcha generator (1–10, image only)
function generateCaptcha() {
  const a = Math.floor(Math.random() * 10) + 1;
  const b = Math.floor(Math.random() * 10) + 1;
  const answer = a + b;
  const text = `${a} + ${b} = ?`;

  const width = 250;
  const height = 100;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#f5f5f5';
  ctx.fillRect(0, 0, width, height);

  ctx.font = '40px Sans';
  ctx.fillStyle = '#111111';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, width / 2, height / 2);

  ctx.strokeStyle = '#cccccc';
  for (let i = 0; i < 5; i++) {
    ctx.beginPath();
    ctx.moveTo(Math.random() * width, Math.random() * height);
    ctx.lineTo(Math.random() * width, Math.random() * height);
    ctx.stroke();
  }

  return { buffer: canvas.toBuffer(), answer };
}

// in-memory captcha sessions: threadId -> { userId, answer }
const captchaSessions = new Map();

// discord client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages
  ],
  partials: [Partials.Channel]
});

client.commands = new Collection();

// slash commands
const setupCommand = new SlashCommandBuilder()
  .setName('setup')
  .setDescription('Initial setup for Veri.')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

const verifyThreadCommand = new SlashCommandBuilder()
  .setName('verifythread')
  .setDescription('Post the verification starter message.')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

const configCommand = new SlashCommandBuilder()
  .setName('config')
  .setDescription('Configure Veri settings.')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addStringOption(opt =>
    opt
      .setName('honeypot_punishment')
      .setDescription('Punishment for honeypot triggers.')
      .addChoices(
        { name: 'timeout', value: 'timeout' },
        { name: 'kick', value: 'kick' },
        { name: 'ban', value: 'ban' }
      )
  )
  .addIntegerOption(opt =>
    opt
      .setName('timeout_minutes')
      .setDescription('Timeout minutes for timeout punishment.')
  )
  .addBooleanOption(opt =>
    opt
      .setName('captcha_enabled')
      .setDescription('Enable or disable captcha.')
  )
  .addBooleanOption(opt =>
    opt
      .setName('honeypot_enabled')
      .setDescription('Enable or disable honeypot.')
  )
  .addRoleOption(opt =>
    opt
      .setName('verification_role')
      .setDescription('Role to give when verified.')
  );

const playerInfoCommand = new SlashCommandBuilder()
  .setName('player')
  .setDescription('Player related commands.')
  .addSubcommand(sub =>
    sub
      .setName('info')
      .setDescription('Show Veri info for a user id.')
      .addStringOption(opt =>
        opt
          .setName('user_id')
          .setDescription('User ID to inspect.')
          .setRequired(true)
      )
  );

// register in memory
client.commands.set('setup', { data: setupCommand });
client.commands.set('verifythread', { data: verifyThreadCommand });
client.commands.set('config', { data: configCommand });
client.commands.set('player', { data: playerInfoCommand });

// register commands with Discord
async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);
  const commands = [
    setupCommand.toJSON(),
    verifyThreadCommand.toJSON(),
    configCommand.toJSON(),
    playerInfoCommand.toJSON()
  ];
  await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
  console.log('Slash commands registered.');
}

// helper: log to guild logs channel (no pings)
async function sendLog(guild, text) {
  const cfg = getGuildConfig(guild.id);
  if (!cfg.logsChannelId) return;
  const channel = guild.channels.cache.get(cfg.logsChannelId);
  if (!channel) return;
  channel.send({ content: text }).catch(() => {});
}

// helper: apply honeypot punishment
async function applyHoneypotPunishment(member, cfg) {
  const reason = 'Veri honeypot trigger';
  if (cfg.honeypotPunishment === 'timeout') {
    const ms = (cfg.honeypotTimeoutMinutes || 10) * 60 * 1000;
    try {
      await member.timeout(ms, reason);
    } catch {}
  } else if (cfg.honeypotPunishment === 'kick') {
    try {
      await member.kick(reason);
    } catch {}
  } else if (cfg.honeypotPunishment === 'ban') {
    try {
      await member.ban({ reason });
    } catch {}
  }
}

// ready
client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  try {
    await registerCommands();
  } catch (e) {
    console.error('Failed to register commands:', e);
  }
});

// guild member join: auto-verify if globally verified
client.on('guildMemberAdd', async member => {
  const cfg = getGuildConfig(member.guild.id);
  const record = getUserRecord(member.id);

  if (record.firstVerified) {
    if (cfg.verificationRoleId) {
      const role = member.guild.roles.cache.get(cfg.verificationRoleId);
      if (role) {
        member.roles.add(role).catch(() => {});
      }
    }
    record.servers = Array.from(new Set([...(record.servers || []), member.guild.id]));
    record.lastVerification = Date.now();
    saveData(data);

    member
      .send({
        content:
          'You were already verified using Veri in another server. You have been verified here automatically.'
      })
      .catch(() => {});

    await sendLog(
      member.guild,
      `Auto-verified user ${member.id} based on global Veri record.`
    );
  }
});

// interaction handler
client.on('interactionCreate', async interaction => {
  if (interaction.isChatInputCommand()) {
    const name = interaction.commandName;

    if (name === 'setup') {
      const member = interaction.member;
      if (!member.permissions.has(PermissionFlagsBits.Administrator)) {
        return interaction.reply({
          content: 'You must be an administrator to use this command.',
          ephemeral: true
        });
      }

      const guild = interaction.guild;

      const verificationChannel = await guild.channels.create({
        name: 'verification',
        type: ChannelType.GuildText,
        reason: 'Veri setup: verification channel'
      });

      const logsChannel = await guild.channels.create({
        name: 'veri-logs',
        type: ChannelType.GuildText,
        reason: 'Veri setup: logs channel'
      });

      const honeypotChannel = await guild.channels.create({
        name: 'honeypot',
        type: ChannelType.GuildText,
        reason: 'Veri setup: honeypot channel'
      });

      const cfg = getGuildConfig(guild.id);
      cfg.verificationChannelId = verificationChannel.id;
      cfg.logsChannelId = logsChannel.id;
      cfg.honeypotChannelId = honeypotChannel.id;
      saveData(data);

      await interaction.reply({
        content: 'Setup complete. Verification, logs, and honeypot channels created.',
        ephemeral: true
      });

      await sendLog(guild, 'Setup command used. Channels created.');
    }

    if (name === 'verifythread') {
      const guild = interaction.guild;
      const cfg = getGuildConfig(guild.id);
      const channel = guild.channels.cache.get(cfg.verificationChannelId);

      if (!channel) {
        return interaction.reply({
          content: 'Verification channel is not configured correctly.',
          ephemeral: true
        });
      }

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('veri_start')
          .setLabel('Start verification')
          .setStyle(ButtonStyle.Primary)
      );

      await channel.send({
        content: 'Press the button below to start verification in a private thread.',
        components: [row]
      });

      await interaction.reply({
        content: 'Verification starter message sent.',
        ephemeral: true
      });

      await sendLog(guild, 'verifythread command used. Starter message posted.');
    }

    if (name === 'config') {
      const guild = interaction.guild;
      const cfg = getGuildConfig(guild.id);

      const punishment = interaction.options.getString('honeypot_punishment');
      const timeoutMinutes = interaction.options.getInteger('timeout_minutes');
      const captchaEnabled = interaction.options.getBoolean('captcha_enabled');
      const honeypotEnabled = interaction.options.getBoolean('honeypot_enabled');
      const verificationRole = interaction.options.getRole('verification_role');

      if (punishment) cfg.honeypotPunishment = punishment;
      if (typeof timeoutMinutes === 'number') cfg.honeypotTimeoutMinutes = timeoutMinutes;
      if (typeof captchaEnabled === 'boolean') cfg.captchaEnabled = captchaEnabled;
      if (typeof honeypotEnabled === 'boolean') cfg.honeypotEnabled = honeypotEnabled;
      if (verificationRole) cfg.verificationRoleId = verificationRole.id;

      saveData(data);

      await interaction.reply({
        content: 'Configuration updated.',
        ephemeral: true
      });

      await sendLog(guild, 'Config command used. Settings updated.');
    }

    if (name === 'player') {
      const sub = interaction.options.getSubcommand();
      if (sub === 'info') {
        const userId = interaction.options.getString('user_id');
        const record = data.verifiedUsers[userId];

        if (!record) {
          return interaction.reply({
            content: 'No Veri record found for that user id.',
            ephemeral: true
          });
        }

        const embed = new EmbedBuilder()
          .setTitle('Veri player info')
          .setDescription(`User ID: ${userId}`)
          .addFields(
            {
              name: 'First verified',
              value: record.firstVerified
                ? new Date(record.firstVerified).toISOString()
                : 'Never',
              inline: false
            },
            {
              name: 'Last verification',
              value: record.lastVerification
                ? new Date(record.lastVerification).toISOString()
                : 'Never',
              inline: false
            },
            {
              name: 'Servers verified in',
              value:
                record.servers && record.servers.length > 0
                  ? record.servers.join(', ')
                  : 'None',
              inline: false
            },
            {
              name: 'Failed captcha attempts',
              value: String(record.fails || 0),
              inline: true
            },
            {
              name: 'Honeypot triggers',
              value: String(record.honeypotTriggers || 0),
              inline: true
            }
          )
          .setColor(0x2f3136);

        await interaction.reply({
          embeds: [embed],
          ephemeral: true
        });

        await sendLog(
          interaction.guild,
          `player info command used for user id ${userId}.`
        );
      }
    }
  }

  if (interaction.isButton()) {
    if (interaction.customId === 'veri_start') {
      const guild = interaction.guild;
      const cfg = getGuildConfig(guild.id);

      if (!cfg.captchaEnabled) {
        return interaction.reply({
          content: 'Verification is currently disabled.',
          ephemeral: true
        });
      }

      const verificationChannel = guild.channels.cache.get(cfg.verificationChannelId);
      if (!verificationChannel) {
        return interaction.reply({
          content: 'Verification channel is not configured correctly.',
          ephemeral: true
        });
      }

      const existingThread = [...captchaSessions.entries()].find(
        ([, session]) => session.userId === interaction.user.id
      );
      if (existingThread) {
        return interaction.reply({
          content: 'You already have an active verification thread.',
          ephemeral: true
        });
      }

      const thread = await verificationChannel.threads.create({
        name: `verify-${interaction.user.id}`,
        autoArchiveDuration: ThreadAutoArchiveDuration.OneHour,
        type: ChannelType.PrivateThread,
        reason: 'Veri verification thread'
      });

      const { buffer, answer } = generateCaptcha();
      const attachment = new AttachmentBuilder(buffer, { name: 'captcha.png' });

      await thread.send({
        content: 'Answer the math question in this image. Type only the number.',
        files: [attachment]
      });

      captchaSessions.set(thread.id, {
        userId: interaction.user.id,
        answer
      });

      await interaction.reply({
        content: 'A private verification thread has been created for you.',
        ephemeral: true
      });

      await sendLog(
        guild,
        `Verification started for user ${interaction.user.id} in thread ${thread.id}.`
      );
    }
  }
});

// message handler: captcha answers and honeypot
client.on('messageCreate', async message => {
  if (!message.guild || message.author.bot) return;

  const guild = message.guild;
  const cfg = getGuildConfig(guild.id);

  // honeypot trap
  if (
    cfg.honeypotEnabled &&
    cfg.honeypotChannelId &&
    message.channel.id === cfg.honeypotChannelId
  ) {
    const record = getUserRecord(message.author.id);
    record.honeypotTriggers = (record.honeypotTriggers || 0) + 1;
    saveData(data);

    await sendLog(
      guild,
      `Honeypot trigger by user ${message.author.id} in channel ${message.channel.id}.`
    );

    const member = await guild.members.fetch(message.author.id).catch(() => null);
    if (member) {
      await applyHoneypotPunishment(member, cfg);
    }

    return;
  }

  // captcha answers in verification threads
  const session = captchaSessions.get(message.channel.id);
  if (session && session.userId === message.author.id) {
    const content = message.content.trim();
    const num = Number(content);
    const record = getUserRecord(message.author.id);

    if (!Number.isInteger(num)) {
      await message.channel.send({
        content: 'Please answer with a number only.'
      });
      return;
    }

    if (num === session.answer) {
      const now = Date.now();
      if (!record.firstVerified) record.firstVerified = now;
      record.lastVerification = now;
      record.servers = Array.from(new Set([...(record.servers || []), guild.id]));
      saveData(data);

      if (cfg.verificationRoleId) {
        const role = guild.roles.cache.get(cfg.verificationRoleId);
        if (role) {
          const member = await guild.members.fetch(message.author.id).catch(() => null);
          if (member) {
            member.roles.add(role).catch(() => {});
          }
        }
      }

      await message.channel.send({
        content: 'Correct. You have been verified.'
      });

      await sendLog(
        guild,
        `User ${message.author.id} passed captcha in thread ${message.channel.id}.`
      );

      captchaSessions.delete(message.channel.id);
      return;
    } else {
      record.fails = (record.fails || 0) + 1;
      saveData(data);

      await sendLog(
        guild,
        `User ${message.author.id} failed captcha in thread ${message.channel.id}.`
      );

      const { buffer, answer } = generateCaptcha();
      const attachment = new AttachmentBuilder(buffer, { name: 'captcha.png' });
      captchaSessions.set(message.channel.id, {
        userId: message.author.id,
        answer
      });

      await message.channel.send({
        content: 'Incorrect. Here is a new captcha.',
        files: [attachment]
      });

      return;
    }
  }
});

client.login(BOT_TOKEN);
