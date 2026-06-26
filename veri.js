// veri.js

import {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder,
  Collection
} from 'discord.js';
import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import mongoose from 'mongoose';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BOT_TOKEN = process.env.BOT_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const MONGO_URI = process.env.MONGO_URI;
const PORT = process.env.PORT || 3000;

// master ID
const OWNER_ID = '876731494805155851';

// verification banner
const VERIFICATION_BANNER_URL = 'https://i.postimg.cc/SKrVKYhT/Verify-msg-banner.png';

// bot start time
const BOT_START_TIME = Date.now();

if (!BOT_TOKEN || !CLIENT_ID || !MONGO_URI) {
  console.error('BOT_TOKEN, CLIENT_ID, and MONGO_URI must be set as environment variables.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// MONGOOSE SCHEMAS
// ---------------------------------------------------------------------------

const guildConfigSchema = new mongoose.Schema({
  guildId: { type: String, required: true, unique: true },
  verificationChannelId: { type: String, default: null },
  logsChannelId: { type: String, default: null },
  honeypotChannelId: { type: String, default: null },
  categoryId: { type: String, default: null },
  verificationRoleId: { type: String, default: null },
  adminRoleId: { type: String, default: null },
  captchaEnabled: { type: Boolean, default: true },
  honeypotEnabled: { type: Boolean, default: true },
  honeypotMode: { type: String, default: 'global_ban' },
  setupComplete: { type: Boolean, default: false },
  // Anti-Token-Logger
  antiTokenLoggerEnabled: { type: Boolean, default: false },
  antiTokenLoggerMinAge: { type: Number, default: 7 },
  // Join-Age Requirement
  joinAgeEnabled: { type: Boolean, default: false },
  joinAgeMinDays: { type: Number, default: 7 },
  // Anti-Raid Cooldown
  antiRaidEnabled: { type: Boolean, default: false },
  antiRaidThreshold: { type: Number, default: 10 },
  antiRaidWindowSeconds: { type: Number, default: 30 },
  raidLocked: { type: Boolean, default: false },
  // Verification Cooldown (seconds between verify attempts per user)
  verificationCooldownSeconds: { type: Number, default: 30 }
});

const verifiedUserSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  firstVerified: { type: Number, default: null },
  servers: { type: [String], default: [] },
  fails: { type: Number, default: 0 },
  honeypotTriggers: { type: Number, default: 0 },
  lastVerification: { type: Number, default: null }
});

const blacklistSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true }
});

// Server backup schema
const serverBackupSchema = new mongoose.Schema({
  guildId: { type: String, required: true },
  createdAt: { type: Number, default: Date.now },
  createdBy: { type: String, required: true },
  data: { type: mongoose.Schema.Types.Mixed, required: true }
});

// Stats digest subscription schema
const statsDigestSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  guildId: { type: String, required: true },
  frequency: { type: String, enum: ['daily', 'weekly', 'monthly'], default: 'daily' },
  lastSent: { type: Number, default: null },
  enabled: { type: Boolean, default: true }
});
statsDigestSchema.index({ userId: 1, guildId: 1 }, { unique: true });

// Raid join tracking (in-memory, but schema for persistence if needed)
const raidJoinSchema = new mongoose.Schema({
  guildId: { type: String, required: true, unique: true },
  joins: { type: [Number], default: [] } // timestamps of recent joins
});

const GuildConfig = mongoose.model('GuildConfig', guildConfigSchema);
const VerifiedUser = mongoose.model('VerifiedUser', verifiedUserSchema);
const Blacklist = mongoose.model('Blacklist', blacklistSchema);
const ServerBackup = mongoose.model('ServerBackup', serverBackupSchema);
const StatsDigest = mongoose.model('StatsDigest', statsDigestSchema);

// ---------------------------------------------------------------------------
// IN-MEMORY TRACKING
// ---------------------------------------------------------------------------
// { userId -> { guildId, answer } }
const captchaSessions = new Map();
// { userId -> lastAttemptTimestamp }
const verifyCooldowns = new Map();
// { guildId -> [timestamps] } for raid detection
const raidJoinTracker = new Map();

// ---------------------------------------------------------------------------
// DB HELPERS
// ---------------------------------------------------------------------------

async function getGuildConfig(guildId) {
  let cfg = await GuildConfig.findOne({ guildId });
  if (!cfg) {
    cfg = await GuildConfig.create({ guildId });
  }
  return cfg;
}

async function saveGuildConfig(cfg) {
  await cfg.save();
}

async function getUserRecord(userId) {
  let record = await VerifiedUser.findOne({ userId });
  if (!record) {
    record = await VerifiedUser.create({ userId });
  }
  return record;
}

async function isBlacklisted(userId) {
  const entry = await Blacklist.findOne({ userId });
  return !!entry;
}

async function addToBlacklist(userId) {
  await Blacklist.updateOne({ userId }, { userId }, { upsert: true });
}

async function removeFromBlacklist(userId) {
  await Blacklist.deleteOne({ userId });
}

async function getBlacklistArray() {
  const entries = await Blacklist.find({});
  return entries.map(e => e.userId);
}

async function restoreDataFromJson(jsonString) {
  let parsed;
  try {
    parsed = JSON.parse(jsonString);
  } catch {
    throw new Error('Invalid JSON');
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !parsed.verifiedUsers ||
    !parsed.guilds ||
    !parsed.blacklist
  ) {
    throw new Error('Invalid Veri. data structure');
  }

  await GuildConfig.deleteMany({});
  for (const [guildId, cfg] of Object.entries(parsed.guilds)) {
    await GuildConfig.create({ guildId, ...cfg });
  }

  await VerifiedUser.deleteMany({});
  for (const [userId, record] of Object.entries(parsed.verifiedUsers)) {
    await VerifiedUser.create({ userId, ...record });
  }

  await Blacklist.deleteMany({});
  for (const userId of parsed.blacklist) {
    await Blacklist.create({ userId });
  }
}


// ---------------------------------------------------------------------------
// THEME / EMBED HELPERS
// ---------------------------------------------------------------------------
const THEME_COLOR = 0x00c853;

function boxEmbed({ title, description, fields = [], footer }) {
  const embed = new EmbedBuilder()
    .setColor(THEME_COLOR)
    .setTitle(title || 'Veri.')
    .setDescription(description || '');
  if (fields.length > 0) embed.addFields(fields);
  embed.setFooter({ text: footer || 'Veri.' });
  return embed;
}

function panelEmbed({ title, description, fields = [], footer, thumbnail }) {
  const embed = new EmbedBuilder()
    .setColor(THEME_COLOR)
    .setTitle(`${title}`)
    .setDescription(description || '')
    .setTimestamp();
  if (fields.length > 0) embed.addFields(fields);
  if (thumbnail) embed.setThumbnail(thumbnail);
  embed.setFooter({ text: footer || 'Veri. Security', iconURL: null });
  return embed;
}

// ---------------------------------------------------------------------------
// CAPTCHA
// ---------------------------------------------------------------------------
const captchaFiles = [
  'a.png.png', 'b.png.png', 'c.png.png', 'd.png.png', 'e.png.png',
  'f.png.png', 'g.png.png', 'h.png.png', 'i.png.png', 'j.png.png',
  'k.png.png', 'l.png.png', 'm.png.png', 'n.png.png', 'o.png.png'
];

const captchaAnswers = {
  'a.png.png': 2, 'b.png.png': 8, 'c.png.png': 2, 'd.png.png': 3,
  'e.png.png': 7, 'f.png.png': 4, 'g.png.png': 5, 'h.png.png': 5,
  'i.png.png': 7, 'j.png.png': 5, 'k.png.png': 5, 'l.png.png': 9,
  'm.png.png': 6, 'n.png.png': 8, 'o.png.png': 1
};

function getRandomCaptcha() {
  const file = captchaFiles[Math.floor(Math.random() * captchaFiles.length)];
  const answer = captchaAnswers[file];
  return { file, answer };
}

// ---------------------------------------------------------------------------
// DISCORD CLIENT
// ---------------------------------------------------------------------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildBans
  ],
  partials: [Partials.Channel]
});

client.commands = new Collection();
// Simple inline command handlers
client.commands.set('ping', {
  async execute(interaction) {
    await interaction.reply({
      content: `Pong! WebSocket ping: ${interaction.client.ws.ping}ms`,
      ephemeral: true
    });
  }
});

client.commands.set('uptime', {
  async execute(interaction) {
    const uptime = formatUptime(Date.now() - BOT_START_TIME);
    await interaction.reply({
      content: `Veri. has been online for ${uptime}.`,
      ephemeral: true
    });
  }
});

client.commands.set('help', {
  async execute(interaction) {
    await interaction.reply({
      embeds: [boxEmbed({
        title: 'Veri. Help',
        description:
          'Core commands:\n' +
          '- `/setup` – initial setup\n' +
          '- `/admin-panel` – admin controls\n' +
          '- `/security_score` – show server security\n' +
          '- `/ping`, `/uptime`, `/help` – diagnostics/info',
        footer: 'Veri. Help'
      })],
      ephemeral: true
    });
  }
});

// Example admin-panel stub
client.commands.set('admin-panel', {
  async execute(interaction) {
    if (!(await canUseVeriCommands(interaction))) {
      return interaction.reply({ content: 'You cannot use this command.', ephemeral: true });
    }

    await interaction.reply({
      embeds: [panelEmbed({
        title: 'Veri. Admin Panel',
        description: 'Admin controls will go here.',
        footer: 'Veri. Security'
      })],
      ephemeral: true
    });
  }
});

// ---------------------------------------------------------------------------
// KEEP-ALIVE (After client creation)
// ---------------------------------------------------------------------------
http.createServer((req, res) => {
  if (req.url === '/status') {
    const data = {
      online: true,
      uptime: Date.now() - BOT_START_TIME,
      ping: client.ws.ping,
      guilds: client.guilds.cache.size,
      users: client.users.cache.size
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(data));
  }
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Veri. is running\n');
}).listen(PORT, () => {
  console.log(`Web service running on port ${PORT}`);
});

// ---------------------------------------------------------------------------
// SLASH COMMANDS
// ---------------------------------------------------------------------------

const setupCommand = new SlashCommandBuilder()
  .setName('setup')
  .setDescription('Initial setup for Veri.');

const adminPanelCommand = new SlashCommandBuilder()
  .setName('admin-panel')
  .setDescription('Open the Veri. admin panel (staff only).');

const roleSyncCommand = new SlashCommandBuilder()
  .setName('role-sync')
  .setDescription('Sync roles between main, verified, and staff roles (staff only).');

const serverBackupCommand = new SlashCommandBuilder()
  .setName('server-backup')
  .setDescription('Back up server roles, channels, permissions, categories, and webhooks (staff only).');

const serverRestoreCommand = new SlashCommandBuilder()
  .setName('server-restore')
  .setDescription('Restore server from a Veri. backup (staff only).');

const playerInfoCommand = new SlashCommandBuilder()
  .setName('player')
  .setDescription('Look up Veri. info for a user.')
  .addSubcommand(sub =>
    sub.setName('info').setDescription('Show Veri. info for a user id.')
      .addStringOption(opt =>
        opt.setName('user_id').setDescription('User ID to inspect.').setRequired(true)
      )
  );

const staffCommand = new SlashCommandBuilder()
  .setName('veri_staff')
  .setDescription('Veri. Staff control panel (owner only).');

const securityScoreCommand = new SlashCommandBuilder()
  .setName('security_score')
  .setDescription("Show this server's Veri. security score.");

const resendCommand = new SlashCommandBuilder()
  .setName('veri_resend')
  .setDescription('Resend Veri. verification or honeypot messages.')
  .addStringOption(opt =>
    opt.setName('type').setDescription('Which message to resend.').setRequired(true)
      .addChoices(
        { name: 'Verification', value: 'verification' },
        { name: 'Honeypot', value: 'honeypot' }
      )
  );

const pingCommand = new SlashCommandBuilder()
  .setName('ping')
  .setDescription('Show WebSocket, API, and MongoDB ping.');

const uptimeCommand = new SlashCommandBuilder()
  .setName('uptime')
  .setDescription('Show how long Veri. has been online, memory usage, and more.');

const helpCommand = new SlashCommandBuilder()
  .setName('help')
  .setDescription('Show the Veri. help menu with categories and links.');

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);
  const commands = [
    setupCommand.toJSON(),
    adminPanelCommand.toJSON(),
    roleSyncCommand.toJSON(),
    serverBackupCommand.toJSON(),
    serverRestoreCommand.toJSON(),
    playerInfoCommand.toJSON(),
    staffCommand.toJSON(),
    securityScoreCommand.toJSON(),
    resendCommand.toJSON(),
    pingCommand.toJSON(),
    uptimeCommand.toJSON(),
    helpCommand.toJSON()
  ];
  await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
  console.log('Slash commands registered for Veri.');
}

// ---------------------------------------------------------------------------
// HELPER: send verification embed
// ---------------------------------------------------------------------------
async function sendVerificationMessage(channel) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('veri_start').setLabel('Verify').setStyle(ButtonStyle.Success)
  );

  const verifyEmbed = new EmbedBuilder()
    .setColor(THEME_COLOR)
    .setTitle('WELCOME TO VERIFICATION')
    .setDescription(
      'Securing Your Communities - Simple Captcha Verification\n\n' +
      'To keep this community safe and spam-free, you must complete a short verification.\n' +
      'Please follow the steps below to gain full access.\n\n' +
      '1. Press the Verify button\n' +
      '2. Check your DMs\n' +
      '3. Solve the captcha\n' +
      '4. Access all channels'
    )
    .setFooter({ text: 'Veri.' })
    .setImage(VERIFICATION_BANNER_URL);

  await channel.send({ embeds: [verifyEmbed], components: [row] });
}

// ---------------------------------------------------------------------------
// HELPER: send honeypot embed
// ---------------------------------------------------------------------------
async function sendHoneypotMessage(channel) {
  const honeypotEmbed = boxEmbed({
    title: 'DO NOT TYPE HERE',
    description:
      'ATTENTION, THIS IS A HONEYPOT CHANNEL!\n' +
      'THIS IS A CHANNEL/TRAP USED TO STOP SPAM BOTS, COMPROMISED ACCOUNTS & WEBHOOKS!\n' +
      'PLEASE DO NOT TYPE HERE YOU COULD GET BANNED FROM EVERY SERVER THE BOT IS IN IF YOU DO!\n\n' +
      'PLEASE CLOSE THIS CHANNEL AND DO NOT TYPE HERE OR EVEN REACT TO THIS MESSAGE!\n',
    footer: 'Veri. Honeypot'
  });

  await channel.send({ embeds: [honeypotEmbed] });
}

// ---------------------------------------------------------------------------
// HELPER: get or create Veri. category
// ---------------------------------------------------------------------------
async function getOrCreateVeriCategory(guild, cfg) {
  if (cfg.categoryId) {
    const existing = guild.channels.cache.get(cfg.categoryId);
    if (existing && existing.type === ChannelType.GuildCategory) return existing;
  }
  const byName = guild.channels.cache.find(
    ch => ch.name === 'Veri.' && ch.type === ChannelType.GuildCategory
  );
  if (byName) {
    cfg.categoryId = byName.id;
    await saveGuildConfig(cfg);
    return byName;
  }
  const category = await guild.channels.create({
    name: 'Veri.',
    type: ChannelType.GuildCategory,
    reason: 'Veri. setup: channel category'
  });
  cfg.categoryId = category.id;
  await saveGuildConfig(cfg);
  return category;
}

// ---------------------------------------------------------------------------
// LOG HELPER
// ---------------------------------------------------------------------------
async function sendLog(guild, title, description) {
  const cfg = await getGuildConfig(guild.id);
  if (!cfg.logsChannelId) return;
  const channel = guild.channels.cache.get(cfg.logsChannelId);
  if (!channel) return;
  const embed = boxEmbed({ title, description, footer: 'Veri.' });
  channel.send({ embeds: [embed] }).catch(() => {});
}

// ---------------------------------------------------------------------------
// UPTIME HELPER
// ---------------------------------------------------------------------------
function formatUptime(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);
  return parts.join(' ');
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function getCpuLoad() {
  const cpus = os.cpus();
  let totalIdle = 0, totalTick = 0;
  for (const cpu of cpus) {
    for (const type in cpu.times) totalTick += cpu.times[type];
    totalIdle += cpu.times.idle;
  }
  const idle = totalIdle / cpus.length;
  const total = totalTick / cpus.length;
  const usage = ((1 - idle / total) * 100).toFixed(1);
  return `${usage}%`;
}

// ---------------------------------------------------------------------------
// PERMISSION CHECK
// ---------------------------------------------------------------------------
async function canUseVeriCommands(interaction) {
  const guild = interaction.guild;
  if (!guild) return false;
  const cfg = await getGuildConfig(guild.id);
  const member = interaction.member;

  if (interaction.user.id === OWNER_ID) return true;
  if (guild.ownerId === interaction.user.id) return true;
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  if (cfg.adminRoleId && member.roles.cache.has(cfg.adminRoleId)) return true;

  return false;
}

// ---------------------------------------------------------------------------
// SECURITY SCORE
// ---------------------------------------------------------------------------
async function computeSecurityScore(guild) {
  const cfg = await getGuildConfig(guild.id);
  let score = 0;

  if (cfg.captchaEnabled) score += 20;
  if (cfg.honeypotEnabled) score += 20;
  if (cfg.verificationChannelId && guild.channels.cache.get(cfg.verificationChannelId)) score += 10;
  if (cfg.honeypotChannelId && guild.channels.cache.get(cfg.honeypotChannelId)) score += 10;
  if (cfg.logsChannelId && guild.channels.cache.get(cfg.logsChannelId)) score += 10;
  if (cfg.verificationRoleId && guild.roles.cache.get(cfg.verificationRoleId)) score += 10;
  if (cfg.adminRoleId && guild.roles.cache.get(cfg.adminRoleId)) score += 10;
  if (cfg.antiTokenLoggerEnabled) score += 5;
  if (cfg.joinAgeEnabled) score += 5;
  if (cfg.antiRaidEnabled) score += 5;

  const blacklistSize = await Blacklist.countDocuments();
  const penalty = Math.min(20, blacklistSize * 2);
  score += 5 - penalty;
  score = Math.max(0, Math.min(100, score));

  const totalUsers = await VerifiedUser.countDocuments();

  let status = 'Unknown';
  if (score >= 85) status = 'Very Secure';
  else if (score >= 70) status = 'Secure';
  else if (score >= 50) status = 'Moderate';
  else status = 'Needs Attention';

  return { score, status, totalUsers, blacklistSize };
}

async function computeGuildReputationAndRisk(guild) {
  const { score } = await computeSecurityScore(guild);
  let reputation = 80;
  if (score >= 90) reputation = 95;
  else if (score >= 80) reputation = 88;
  else if (score >= 60) reputation = 75;
  else reputation = 60;

  let repLabel = 'Trusted';
  if (reputation >= 90) repLabel = 'Highly Trusted';
  else if (reputation >= 80) repLabel = 'Trusted';
  else if (reputation >= 70) repLabel = 'Neutral';
  else repLabel = 'Watch';

  let risk = 'Low';
  if (score < 50) risk = 'High';
  else if (score < 70) risk = 'Medium';

  return { reputation, repLabel, risk };
}

// ---------------------------------------------------------------------------
// STATS DIGEST SENDER
// ---------------------------------------------------------------------------
async function sendStatsDigest(userId, guildId) {
  try {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return;

    const cfg = await getGuildConfig(guildId);
    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) return;
    const hasAccess = (
      guild.ownerId === userId ||
      member.permissions.has(PermissionFlagsBits.Administrator) ||
      (cfg.adminRoleId && member.roles.cache.has(cfg.adminRoleId))
    );
    if (!hasAccess) {
      await StatsDigest.deleteOne({ userId, guildId });
      return;
    }

    const { score, status, totalUsers, blacklistSize } = await computeSecurityScore(guild);
    const verifiedInServer = await VerifiedUser.countDocuments({ servers: guildId });
    const recentVerified = await VerifiedUser.countDocuments({
      servers: guildId,
      lastVerification: { $gte: Date.now() - 86400000 }
    });
    const recentFails = (await VerifiedUser.find({ servers: guildId })).reduce((a, r) => a + (r.fails || 0), 0);
    const recentHoneypot = (await VerifiedUser.find({ servers: guildId })).reduce((a, r) => a + (r.honeypotTriggers || 0), 0);

    const user = await client.users.fetch(userId).catch(() => null);
    if (!user) return;

    const dm = await user.createDM().catch(() => null);
    if (!dm) return;

    const embed = panelEmbed({
      title: `Stats Digest - ${guild.name}`,
      description: `Your scheduled stats report for **${guild.name}**`,
      fields: [
        { name: 'Security Score', value: `${score}/100 (${status})`, inline: true },
        { name: 'Total Members', value: `${guild.memberCount}`, inline: true },
        { name: 'Verified In Server', value: `${verifiedInServer}`, inline: true },
        { name: 'Verified (Last 24h)', value: `${recentVerified}`, inline: true },
        { name: 'Total Captcha Fails', value: `${recentFails}`, inline: true },
        { name: 'Honeypot Triggers', value: `${recentHoneypot}`, inline: true },
        { name: 'Global Blacklist Size', value: `${blacklistSize}`, inline: true },
        { name: 'All Verified Users', value: `${totalUsers}`, inline: true }
      ],
      footer: `Veri. Stats Digest - ${guild.name}`
    });

    await dm.send({ embeds: [embed] });
    await StatsDigest.updateOne({ userId, guildId }, { $set: { lastSent: Date.now() } });
  } catch (err) {
    console.error('Stats digest error:', err);
  }
}

async function checkDigests() {
  try {
    const now = Date.now();
    const subs = await StatsDigest.find({ enabled: true });

    for (const sub of subs) {
      let intervalMs;
      if (sub.frequency === 'daily') intervalMs = 86400000;
      else if (sub.frequency === 'weekly') intervalMs = 86400000 * 7;
      else if (sub.frequency === 'monthly') intervalMs = 86400000 * 30;
      else continue;

      if (!sub.lastSent || (now - sub.lastSent) >= intervalMs) {
        await sendStatsDigest(sub.userId, sub.guildId);
      }
    }
  } catch (err) {
    console.error('Digest check error:', err);
  }
}

// ---------------------------------------------------------------------------
// ANTI-TOKEN-LOGGER CHECK (improved)
// ---------------------------------------------------------------------------
async function checkTokenLogger(member, cfg) {
  if (!cfg.antiTokenLoggerEnabled) return false;
  const user = member.user;
  const accountAge = Date.now() - user.createdTimestamp;
  const minAgeDays = cfg.antiTokenLoggerMinAge || 7;
  const minAgeMs = minAgeDays * 24 * 60 * 60 * 1000;
  const noAvatar = !user.avatar;
  const tooNew = accountAge < minAgeMs;
  // Also flag if: no avatar AND no banner AND default username pattern (User + digits)
  const defaultUsername = /^[Uu]ser\d{4,}$/.test(user.username);

  // Flag if no avatar and too new, OR no avatar and default username pattern
  if (noAvatar && (tooNew || defaultUsername)) {
    const reason = tooNew
      ? `no avatar + account age under ${minAgeDays} days`
      : 'no avatar + default username pattern (suspected compromised/bot account)';

    await sendLog(
      member.guild,
      'Veri. Anti-Token-Logger',
      `Flagged user ${user.id} (${user.username}) — ${reason}. User has been kicked.`
    );
    try {
      const dm = await user.createDM().catch(() => null);
      if (dm) {
        await dm.send({
          embeds: [boxEmbed({
            title: 'Veri. Security Alert',
            description:
              'Your account has been flagged by Veri. Anti-Token-Logger protection.\n\n' +
              `Reason: ${reason}.\n\n` +
              'You have been removed from the server for security reasons.\n' +
              'If this is a mistake, please contact a server administrator.',
            footer: 'Veri. Anti-Token-Logger'
          })]
        }).catch(() => {});
      }
      await member.kick(`Veri. Anti-Token-Logger: ${reason}`).catch(() => {});
    } catch {
      // ignore
    }
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// JOIN-AGE REQUIREMENT CHECK
// ---------------------------------------------------------------------------
async function checkJoinAge(member, cfg) {
  if (!cfg.joinAgeEnabled) return false;
  const minDays = cfg.joinAgeMinDays || 7;
  const minAgeMs = minDays * 24 * 60 * 60 * 1000;
  const accountAge = Date.now() - member.user.createdTimestamp;

  if (accountAge < minAgeMs) {
    try {
      const dm = await member.user.createDM().catch(() => null);
      if (dm) {
        const ageDays = Math.floor(accountAge / (24 * 60 * 60 * 1000));
        await dm.send({
          embeds: [boxEmbed({
            title: 'Veri. - Account Too New',
            description:
              `You were removed from **${member.guild.name}** because your account does not meet the minimum age requirement.\n\n` +
              `Your account is **${ageDays} day(s)** old.\n` +
              `The minimum required age is **${minDays} day(s)**.\n\n` +
              'Please wait until your account is old enough and try joining again.\n' +
              'If you believe this is a mistake, contact a server administrator.',
            footer: 'Veri. Join-Age Requirement'
          })]
        }).catch(() => {});
      }
      await member.kick(`Veri. Join-Age: account under ${minDays} days old`).catch(() => {});
      await sendLog(
        member.guild,
        'Veri. Join-Age Block',
        `User ${member.user.id} (${member.user.username}) was removed — account too new (${Math.floor(accountAge / 86400000)} days old, minimum is ${minDays}).`
      );
    } catch {
      // ignore
    }
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// ANTI-RAID DETECTION
// ---------------------------------------------------------------------------
async function checkAntiRaid(member, cfg) {
  if (!cfg.antiRaidEnabled) return false;

  const guildId = member.guild.id;
  const now = Date.now();
  const windowMs = (cfg.antiRaidWindowSeconds || 30) * 1000;
  const threshold = cfg.antiRaidThreshold || 10;

  // Get or init tracker for this guild
  let joins = raidJoinTracker.get(guildId) || [];
  // Remove old entries outside the window
  joins = joins.filter(ts => now - ts < windowMs);
  joins.push(now);
  raidJoinTracker.set(guildId, joins);

  if (joins.length >= threshold) {
    // Only trigger once per raid lock
    if (!cfg.raidLocked) {
      cfg.raidLocked = true;
      await saveGuildConfig(cfg);

      // Alert in logs channel
      await sendLog(
        member.guild,
        'VERI. ANTI-RAID - RAID DETECTED',
        `Raid detected! ${joins.length} users joined within ${cfg.antiRaidWindowSeconds}s.\n` +
        `Verification has been locked. Honeypot mode temporarily set to global_ban for all triggered users.\n` +
        `Open /admin-panel to manage the raid lock and unlock verification when safe.`
      );

      // Alert admins via DM if admin role is set
      if (cfg.adminRoleId) {
        try {
          await member.guild.members.fetch();
          for (const [, gMember] of member.guild.members.cache) {
            if (gMember.user.bot) continue;
            if (gMember.roles.cache.has(cfg.adminRoleId) || gMember.permissions.has(PermissionFlagsBits.Administrator)) {
              const dm = await gMember.user.createDM().catch(() => null);
              if (dm) {
                await dm.send({
                  embeds: [boxEmbed({
                    title: 'VERI. ANTI-RAID ALERT',
                    description:
                      `A raid has been detected in **${member.guild.name}**!\n\n` +
                      `**${joins.length}** users joined in under **${cfg.antiRaidWindowSeconds} seconds**.\n\n` +
                      'Verification has been locked. New members cannot verify until you unlock it.\n\n' +
                      'Open **/admin-panel** in your server to manage the raid lock.',
                    footer: 'Veri. Anti-Raid'
                  })]
                }).catch(() => {});
              }
            }
          }
        } catch {
          // ignore DM failures
        }
      }
    }
    return cfg.raidLocked;
  }
  return false;
}

// ---------------------------------------------------------------------------
// ADMIN PANEL EMBED + COMPONENTS
// ---------------------------------------------------------------------------
async function buildAdminPanelEmbed(guild, cfg) {
  const { score, status } = await computeSecurityScore(guild);

  const onOff = (val) => val ? 'ON' : 'OFF';

  const embed = panelEmbed({
    title: 'Veri. Admin Panel',
    description:
      `Welcome to the **Veri. Admin Panel** for **${guild.name}**.\n` +
      `Use the buttons and dropdowns below to manage Veri. settings.\n\n` +
      `> **Security Score:** \`${score}/100\` - ${status}\n` +
      `> **Server:** \`${guild.id}\`${cfg.raidLocked ? '\n> **RAID LOCK ACTIVE** - Verification is locked. Click Unlock Raid to restore.' : ''}`,
    fields: [
      {
        name: 'Security Features',
        value:
          `Captcha Verification: ${onOff(cfg.captchaEnabled)}\n` +
          `Honeypot Channel: ${onOff(cfg.honeypotEnabled)}\n` +
          `Anti-Token-Logger: ${onOff(cfg.antiTokenLoggerEnabled)} (min age: ${cfg.antiTokenLoggerMinAge || 7} days)\n` +
          `Join-Age Requirement: ${onOff(cfg.joinAgeEnabled)} (min: ${cfg.joinAgeMinDays || 7} days)\n` +
          `Anti-Raid Cooldown: ${onOff(cfg.antiRaidEnabled)} (${cfg.antiRaidThreshold || 10} joins / ${cfg.antiRaidWindowSeconds || 30}s)`,
        inline: true
      },
      {
        name: 'Configuration',
        value:
          `Honeypot Mode: \`${cfg.honeypotMode || 'global_ban'}\`\n` +
          `Verify Role: ${cfg.verificationRoleId ? `<@&${cfg.verificationRoleId}>` : '`Not set`'}\n` +
          `Admin Role: ${cfg.adminRoleId ? `<@&${cfg.adminRoleId}>` : '`Not set`'}\n` +
          `Logs: ${cfg.logsChannelId ? `<#${cfg.logsChannelId}>` : '`Not set`'}\n` +
          `Verify Cooldown: \`${cfg.verificationCooldownSeconds || 30}s\``,
        inline: true
      }
    ],
    footer: `Veri. Admin Panel - ${guild.name}`
  });

  return embed;
}

function buildAdminPanelRows(cfg) {
  const onOff = (val) => val ? 'ON' : 'OFF';

  // Row 1: Feature toggles
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ap_toggle_captcha').setLabel(`Captcha: ${onOff(cfg.captchaEnabled)}`).setStyle(cfg.captchaEnabled ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('ap_toggle_honeypot').setLabel(`Honeypot: ${onOff(cfg.honeypotEnabled)}`).setStyle(cfg.honeypotEnabled ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('ap_toggle_antitokenlogger').setLabel(`Token-Logger: ${onOff(cfg.antiTokenLoggerEnabled)}`).setStyle(cfg.antiTokenLoggerEnabled ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('ap_toggle_joinage').setLabel(`Join-Age: ${onOff(cfg.joinAgeEnabled)}`).setStyle(cfg.joinAgeEnabled ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('ap_toggle_antiraid').setLabel(`Anti-Raid: ${onOff(cfg.antiRaidEnabled)}`).setStyle(cfg.antiRaidEnabled ? ButtonStyle.Success : ButtonStyle.Secondary)
  );

  // Row 2: Actions
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ap_role_sync').setLabel('Role Sync').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('ap_server_backup').setLabel('Backup Server').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('ap_server_restore').setLabel('Restore Backup').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('ap_resend_verify').setLabel('Resend Verify Msg').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('ap_resend_honeypot').setLabel('Resend Honeypot Msg').setStyle(ButtonStyle.Secondary)
  );

  // Row 3: Config modals + raid unlock
  const raidUnlockBtn = new ButtonBuilder()
    .setCustomId('ap_unlock_raid')
    .setLabel(cfg.raidLocked ? 'Unlock Raid Lock' : 'Raid Lock (inactive)')
    .setStyle(cfg.raidLocked ? ButtonStyle.Danger : ButtonStyle.Secondary);

  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ap_security_score').setLabel('Security Score').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('ap_digest_setup').setLabel('My Stats Digest').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('ap_set_roles').setLabel('Set Roles').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('ap_config_settings').setLabel('Settings').setStyle(ButtonStyle.Primary),
    raidUnlockBtn
  );

  // Row 4: Honeypot mode dropdown
  const honeypotModeMenu = new StringSelectMenuBuilder()
    .setCustomId('ap_honeypot_mode')
    .setPlaceholder('Set Honeypot Mode...')
    .addOptions([
      { label: 'Global Ban (default)', value: 'global_ban', description: 'Ban from all Veri. servers', default: cfg.honeypotMode === 'global_ban' || !cfg.honeypotMode },
      { label: 'Server Ban Only', value: 'server_ban', description: 'Ban from this server only', default: cfg.honeypotMode === 'server_ban' },
      { label: 'Kick Only', value: 'kick', description: 'Kick from this server', default: cfg.honeypotMode === 'kick' },
      { label: 'Warn Only', value: 'warn', description: 'Send a warning message', default: cfg.honeypotMode === 'warn' },
      { label: 'DM Warning Only', value: 'dm_only', description: 'Send a DM warning only', default: cfg.honeypotMode === 'dm_only' }
    ]);

  const row4 = new ActionRowBuilder().addComponents(honeypotModeMenu);

  return [row1, row2, row3, row4];
}

// ---------------------------------------------------------------------------
// READY
// ---------------------------------------------------------------------------
client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag} (Veri.)`);

  try {
    await registerCommands();
  } catch (e) {
    console.error('Failed to register commands for Veri.:', e);
  }

  // GLOBAL VERIFICATION AUTO-REPAIR
  for (const [guildId, guild] of client.guilds.cache) {
    try {
      await guild.members.fetch();

      const guildSettings = await GuildConfig.findOne({ guildId });

      let verificationRole = null;
      if (guildSettings?.verificationRoleId) {
        verificationRole = guild.roles.cache.get(guildSettings.verificationRoleId);
      }
      if (!verificationRole) {
        verificationRole = guild.roles.cache.find(r => r.name === 'Captcha Verified');
      }
      if (!verificationRole) continue;

      for (const [, member] of guild.members.cache) {
        if (member.roles.cache.has(verificationRole.id)) {
          let record = await VerifiedUser.findOne({ userId: member.id });
          if (!record) {
            record = await VerifiedUser.create({
              userId: member.id,
              firstVerified: Date.now(),
              servers: [guildId],
              lastVerification: Date.now()
            });
          } else if (!record.servers.includes(guildId)) {
            record.servers.push(guildId);
            await record.save();
          }
        }
      }

      console.log(`Repaired verified users for guild: ${guild.name}`);
    } catch (err) {
      console.log(`Error repairing guild ${guildId}:`, err);
    }
  }

  console.log('Global verification repair complete.');

  setInterval(checkDigests, 10 * 60 * 1000);
  setTimeout(checkDigests, 30000);
});

// ---------------------------------------------------------------------------
// GUILD JOIN WELCOME
// ---------------------------------------------------------------------------
client.on('guildCreate', async guild => {
  try {
    const systemChannel =
      guild.systemChannel ||
      guild.channels.cache.find(
        c =>
          c.type === ChannelType.GuildText &&
          c.permissionsFor(guild.members.me).has(PermissionFlagsBits.SendMessages)
      );
    if (!systemChannel) return;

    const embed = boxEmbed({
      title: 'Veri.',
      description:
        'Veri. has joined this server.\n\nTo activate Veri., run /setup.\nThis command requires:\n- Administrator permissions\n- Veri. to have a high role in the hierarchy\n- Only the server owner or Veri. Admin can run it.',
      footer: 'Veri.'
    });

    const msg = await systemChannel.send({ embeds: [embed] });
    setTimeout(() => { msg.delete().catch(() => {}); }, 5 * 60 * 1000);
  } catch {
    // ignore
  }
});

// ---------------------------------------------------------------------------
// BAN IMMUNITY FOR OWNER
// ---------------------------------------------------------------------------
client.on('guildBanAdd', async ban => {
  try {
    if (ban.user.id === OWNER_ID) {
      await ban.guild.members.unban(OWNER_ID, 'Veri. owner immunity');
    }
  } catch {
    // ignore
  }
});

// ---------------------------------------------------------------------------
// MEMBER REMOVE: clean captcha session
// ---------------------------------------------------------------------------
client.on('guildMemberRemove', member => {
  if (captchaSessions.has(member.id)) {
    const session = captchaSessions.get(member.id);
    if (session.guildId === member.guild.id) {
      captchaSessions.delete(member.id);
    }
  }
});

// ---------------------------------------------------------------------------
// MEMBER ADD
// ---------------------------------------------------------------------------
client.on('guildMemberAdd', async member => {
  if (member.user.bot) return;

  const guild = member.guild;
  const cfg = await getGuildConfig(guild.id);

  // Global blacklist auto-ban
  if ((await isBlacklisted(member.id)) && member.id !== OWNER_ID) {
    try {
      await member.send({
        embeds: [
          boxEmbed({
            title: 'Veri.',
            description:
              'You are globally banned from all Veri. servers.\nYou previously triggered a Veri. honeypot.\nNo exceptions can be made.',
            footer: 'Veri.'
          })
        ]
      }).catch(() => {});
      await member.ban({ reason: 'Veri. global honeypot blacklist' });
      await sendLog(guild, 'Veri. Global Ban', `User ${member.id} was auto-banned on join due to Veri. global blacklist.`);
    } catch {
      // ignore
    }
    return;
  }

  // Join-Age Requirement check (runs before everything else except blacklist)
  if (cfg.joinAgeEnabled) {
    const blocked = await checkJoinAge(member, cfg);
    if (blocked) return;
  }

  // Anti-Token-Logger check
  if (cfg.antiTokenLoggerEnabled) {
    const flagged = await checkTokenLogger(member, cfg);
    if (flagged) return;
  }

  // Anti-Raid Cooldown check
  if (cfg.antiRaidEnabled) {
    const raidActive = await checkAntiRaid(member, cfg);
    if (raidActive || cfg.raidLocked) {
      // During raid lock, kick new joins and DM them
      try {
        const dm = await member.user.createDM().catch(() => null);
        if (dm) {
          await dm.send({
            embeds: [boxEmbed({
              title: 'Veri. - Server Locked',
              description:
                `**${guild.name}** is currently under a raid lock.\n\n` +
                'Verification is temporarily disabled to protect the server.\n' +
                'Please try joining again later once the lock has been lifted.',
              footer: 'Veri. Anti-Raid'
            })]
          }).catch(() => {});
        }
        await member.kick('Veri. Anti-Raid: server is raid locked').catch(() => {});
      } catch {
        // ignore
      }
      return;
    }
  }

  if (!cfg.captchaEnabled) {
    await sendLog(guild, 'Veri. Member Joined', `New member ${member.id} joined. Captcha is disabled so no lockdown was applied.`);
    return;
  }

  const existingRecord = await VerifiedUser.findOne({ userId: member.id });
  if (existingRecord?.firstVerified && existingRecord.servers.includes(guild.id)) {
    const role = cfg.verificationRoleId ? guild.roles.cache.get(cfg.verificationRoleId) : null;
    if (role) await member.roles.add(role).catch(() => {});
    await sendLog(guild, 'Veri. Returning Member', `Member ${member.id} rejoined and was already verified. Lockdown skipped, role restored.`);
    return;
  }

  const verificationChannel = cfg.verificationChannelId
    ? guild.channels.cache.get(cfg.verificationChannelId)
    : guild.channels.cache.find(ch => ch.name === 'verification' && ch.type === ChannelType.GuildText);

  const honeypotChannel =
    cfg.honeypotEnabled && cfg.honeypotChannelId
      ? guild.channels.cache.get(cfg.honeypotChannelId)
      : cfg.honeypotEnabled
        ? guild.channels.cache.find(ch => ch.name === '!DO NOT TYPE HERE!' && ch.type === ChannelType.GuildText)
        : null;

  guild.channels.cache.forEach(channel => {
    if (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildVoice) return;
    if (
      (verificationChannel && channel.id === verificationChannel.id) ||
      (honeypotChannel && channel.id === honeypotChannel.id)
    ) {
      channel.permissionOverwrites.edit(member.id, { ViewChannel: true }).catch(() => {});
    } else {
      channel.permissionOverwrites.edit(member.id, { ViewChannel: false }).catch(() => {});
    }
  });

  await sendLog(guild, 'Veri. Lockdown', `New member ${member.id} was locked to verification${honeypotChannel ? ' and honeypot' : ''} channel only.`);
});

// ---------------------------------------------------------------------------
// INTERACTIONS
// ---------------------------------------------------------------------------
client.on('interactionCreate', async interaction => {
  try {

  // =========================================================================
  // SLASH COMMANDS
  // =========================================================================
  if (interaction.isChatInputCommand()) {
    const name = interaction.commandName;

    // -----------------------------------------------------------------------
    // /ping
    // -----------------------------------------------------------------------
    if (name === 'ping') {
      const wsPing = client.ws.ping;
      const start = Date.now();
      await interaction.deferReply();
      const apiPing = Date.now() - start;

      let mongoPing = -1;
      try {
        const mongoStart = Date.now();
        await mongoose.connection.db.admin().ping();
        mongoPing = Date.now() - mongoStart;
      } catch {
        // ignore
      }

      const pingBar = (ms) => {
        if (ms < 0) return '`N/A`';
        if (ms < 100) return `\`${ms}ms\` (Good)`;
        if (ms < 250) return `\`${ms}ms\` (OK)`;
        return `\`${ms}ms\` (High)`;
      };

      const embed = panelEmbed({
        title: 'Veri. Ping',
        description: 'Current latency status for all Veri. services.',
        fields: [
          { name: 'WebSocket Ping', value: pingBar(wsPing), inline: true },
          { name: 'API Ping', value: pingBar(apiPing), inline: true },
          { name: 'MongoDB Ping', value: pingBar(mongoPing), inline: true }
        ],
        footer: 'Veri. - All Systems'
      });

      return interaction.editReply({ embeds: [embed] });
    }

    // -----------------------------------------------------------------------
    // /uptime
    // -----------------------------------------------------------------------
    if (name === 'uptime') {
      const uptimeMs = Date.now() - BOT_START_TIME;
      const mem = process.memoryUsage();
      const cpuLoad = getCpuLoad();

      const embed = panelEmbed({
        title: 'Veri. Uptime & Status',
        description: 'Live system information for the Veri. bot.',
        fields: [
          { name: 'Uptime', value: `\`${formatUptime(uptimeMs)}\``, inline: true },
          { name: 'Last Restart', value: `<t:${Math.floor(BOT_START_TIME / 1000)}:R>`, inline: true },
          { name: 'Memory (RSS)', value: `\`${formatBytes(mem.rss)}\``, inline: true },
          { name: 'Heap Used', value: `\`${formatBytes(mem.heapUsed)}\``, inline: true },
          { name: 'Heap Total', value: `\`${formatBytes(mem.heapTotal)}\``, inline: true },
          { name: 'CPU Load', value: `\`${cpuLoad}\``, inline: true }
        ],
        footer: 'Veri. Status'
      });

      return interaction.reply({ embeds: [embed] });
    }

    // -----------------------------------------------------------------------
    // /help
    // -----------------------------------------------------------------------
    if (name === 'help') {
      const embed = panelEmbed({
        title: 'Veri. Help Centre',
        description:
          'Welcome to **Veri.** - the advanced Discord verification and security bot.\n\n' +
          'Use the dropdown below to browse commands by category, or click a button to get started.\n\n' +
          '> **Support Server:** [Join Here](https://discord.gg/K6x4qwZCNM)\n' +
          '> **Documentation:** Coming soon',
        fields: [
          {
            name: 'Open Commands (everyone)',
            value:
              '`/ping` - Check bot latency\n' +
              '`/uptime` - Bot uptime & system info\n' +
              '`/help` - This menu\n' +
              '`/player info` - Look up a user\'s Veri. record',
            inline: false
          },
          {
            name: 'Staff Commands (Veri. Admin / Admins)',
            value:
              '`/setup` - Set up Veri. in your server\n' +
              '`/admin-panel` - Full interactive admin panel\n' +
              '`/role-sync` - Sync verified/staff roles\n' +
              '`/server-backup` - Back up your server\n' +
              '`/server-restore` - Restore from backup\n' +
              '`/security_score` - View security score\n' +
              '`/veri_resend` - Resend verify/honeypot messages',
            inline: false
          },
          {
            name: 'Owner Only',
            value: '`/veri_staff` - Veri. global staff control panel',
            inline: false
          },
          {
            name: 'Security Features (toggle via admin panel)',
            value:
              '`Captcha Verification` - DM-based image captcha\n' +
              '`Honeypot Channel` - Catches bots/compromised accounts\n' +
              '`Anti-Token-Logger` - Flags suspicious new accounts\n' +
              '`Join-Age Requirement` - Blocks accounts younger than X days\n' +
              '`Anti-Raid Cooldown` - Detects and locks raids automatically',
            inline: false
          },
          {
            name: 'Quick Start',
            value:
              '1. Invite Veri. with **Administrator** permission\n' +
              '2. Make sure Veri.\'s role is **near the top** of your role list\n' +
              '3. Run `/setup`\n' +
              '4. Customise with `/admin-panel`\n' +
              '5. Join our support server for help!',
            inline: false
          }
        ],
        footer: 'Veri. Help - discord.gg/K6x4qwZCNM'
      });

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setLabel('Discord Server')
          .setStyle(ButtonStyle.Link)
          .setURL('https://discord.gg/K6x4qwZCNM'),
        new ButtonBuilder()
          .setCustomId('help_quickstart')
          .setLabel('Quick Start Guide')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId('help_features')
          .setLabel('Security Features')
          .setStyle(ButtonStyle.Secondary)
      );

      const catMenu = new StringSelectMenuBuilder()
        .setCustomId('help_category')
        .setPlaceholder('Browse by category...')
        .addOptions([
          { label: 'Open Commands', value: 'open', description: 'Commands anyone can use' },
          { label: 'Staff Commands', value: 'staff', description: 'Commands for Veri. Admin role and admins' },
          { label: 'Security Features', value: 'security', description: 'All security features explained' },
          { label: 'Quick Start', value: 'quickstart', description: 'How to set Veri. up' },
          { label: 'Stats & Monitoring', value: 'stats', description: 'Uptime, ping, digest stats' }
        ]);

      const row2 = new ActionRowBuilder().addComponents(catMenu);

      return interaction.reply({ embeds: [embed], components: [row, row2] });
    }

    // -----------------------------------------------------------------------
    // /setup
    // -----------------------------------------------------------------------
    if (name === 'setup') {
      if (!(await canUseVeriCommands(interaction))) {
        return interaction.reply({
          embeds: [boxEmbed({ title: 'Veri.', description: 'You are not allowed to run this command.\nOnly the server owner, Veri. Admin, Discord administrators, or official Veri. staff may run Veri. setup.', footer: 'Veri.' })],
          ephemeral: true
        });
      }

      const guild = interaction.guild;
      const cfg = await getGuildConfig(guild.id);

      if (cfg.setupComplete) {
        return interaction.reply({
          embeds: [boxEmbed({ title: 'Veri.', description: 'Setup has already been completed for this server. It cannot be run again.', footer: 'Veri.' })],
          ephemeral: true
        });
      }

      const botMember = guild.members.me;
      const requiredPerms = [
        PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageRoles,
        PermissionFlagsBits.SendMessages, PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.AttachFiles
      ];
      const missing = requiredPerms.filter(p => !botMember.permissions.has(p));

      if (missing.length > 0) {
        const permNames = {
          [PermissionFlagsBits.ManageChannels]: 'Manage Channels',
          [PermissionFlagsBits.ManageRoles]: 'Manage Roles',
          [PermissionFlagsBits.SendMessages]: 'Send Messages',
          [PermissionFlagsBits.ViewChannel]: 'View Channel',
          [PermissionFlagsBits.EmbedLinks]: 'Embed Links',
          [PermissionFlagsBits.AttachFiles]: 'Attach Files'
        };
        const missingNames = missing.map(p => permNames[p]).join(', ');
        return interaction.reply({
          embeds: [boxEmbed({ title: 'Veri.', description: `Setup cannot continue. Veri. is missing required permissions:\n${missingNames}\n\nGrant Veri. these permissions (and make sure its role is high enough in the role list) and try again.`, footer: 'Veri.' })],
          ephemeral: true
        });
      }

      await interaction.deferReply({ ephemeral: false });

      try {
        // Create Veri. Admin role
        let adminRole = cfg.adminRoleId
          ? guild.roles.cache.get(cfg.adminRoleId)
          : guild.roles.cache.find(r => r.name === 'Veri. Admin');

        if (!adminRole) {
          adminRole = await guild.roles.create({ name: 'Veri. Admin', reason: 'Veri. setup: admin role' });
          cfg.adminRoleId = adminRole.id;
          await saveGuildConfig(cfg);
        }

        // Create Captcha Verified role
        let verifiedRole = cfg.verificationRoleId
          ? guild.roles.cache.get(cfg.verificationRoleId)
          : guild.roles.cache.find(r => r.name === 'Captcha Verified');

        if (!verifiedRole) {
          verifiedRole = await guild.roles.create({ name: 'Captcha Verified', reason: 'Veri. setup: verified role' });
          cfg.verificationRoleId = verifiedRole.id;
          await saveGuildConfig(cfg);
        }

        const category = await getOrCreateVeriCategory(guild, cfg);

        let verificationChannel =
          (cfg.verificationChannelId ? guild.channels.cache.get(cfg.verificationChannelId) : null) ||
          guild.channels.cache.find(ch => ch.name === 'verification' && ch.type === ChannelType.GuildText);

        if (!verificationChannel) {
          verificationChannel = await guild.channels.create({ name: 'verification', type: ChannelType.GuildText, parent: category.id, reason: 'Veri. setup: verification channel' });
        } else if (verificationChannel.parentId !== category.id) {
          await verificationChannel.setParent(category.id, { lockPermissions: false }).catch(() => {});
        }

        let logsChannel =
          (cfg.logsChannelId ? guild.channels.cache.get(cfg.logsChannelId) : null) ||
          guild.channels.cache.find(ch => ch.name === 'veri-logs' && ch.type === ChannelType.GuildText);

        if (!logsChannel) {
          logsChannel = await guild.channels.create({ name: 'veri-logs', type: ChannelType.GuildText, parent: category.id, reason: 'Veri. setup: logs channel' });
        } else if (logsChannel.parentId !== category.id) {
          await logsChannel.setParent(category.id, { lockPermissions: false }).catch(() => {});
        }

        let honeypotChannel =
          (cfg.honeypotChannelId ? guild.channels.cache.get(cfg.honeypotChannelId) : null) ||
          guild.channels.cache.find(ch => ch.name === '!DO NOT TYPE HERE!' && ch.type === ChannelType.GuildText);

        if (!honeypotChannel) {
          honeypotChannel = await guild.channels.create({ name: '!DO NOT TYPE HERE!', type: ChannelType.GuildText, parent: category.id, reason: 'Veri. setup: honeypot channel' });
        } else if (honeypotChannel.parentId !== category.id) {
          await honeypotChannel.setParent(category.id, { lockPermissions: false }).catch(() => {});
        }

        cfg.verificationChannelId = verificationChannel.id;
        cfg.logsChannelId = logsChannel.id;
        cfg.honeypotChannelId = honeypotChannel.id;
        cfg.captchaEnabled = true;
        cfg.honeypotEnabled = true;
        cfg.setupComplete = true;
        await saveGuildConfig(cfg);

        await sendVerificationMessage(verificationChannel);
        await sendHoneypotMessage(honeypotChannel);

        await interaction.editReply({
          embeds: [boxEmbed({
            title: 'Veri.',
            description:
              'Setup complete.\n\n' +
              'All Veri. channels have been created inside the "Veri." category.\n' +
              'Verification, logs, and honeypot channels are configured.\n' +
              'The Verify button has been posted in the verification channel.\n' +
              'A honeypot warning has been posted in the honeypot channel.\n\n' +
              'Roles created:\n' +
              `- "Veri. Admin" (admin role): <@&${adminRole.id}>\n` +
              `- "Captcha Verified" (verified role): <@&${verifiedRole.id}>\n\n` +
              'You can change these roles at any time via /admin-panel > Set Roles.',
            footer: 'Veri.'
          })]
        });

        await sendLog(guild, 'Veri. Setup', 'Channels, roles created and Verify button posted by /setup.');
      } catch (e) {
        console.error('Veri. setup failed:', e);
        await interaction.editReply({
          embeds: [boxEmbed({ title: 'Veri.', description: `Setup failed partway through. This is usually caused by missing permissions or role hierarchy issues.\nCheck that Veri. has Manage Channels, Manage Roles, and a high enough role, then run /setup again.\n\nError: ${e.message}`, footer: 'Veri.' })]
        });
      }
    }

    // -----------------------------------------------------------------------
    // /admin-panel
    // -----------------------------------------------------------------------
    if (name === 'admin-panel') {
      if (!(await canUseVeriCommands(interaction))) {
        return interaction.reply({
          embeds: [boxEmbed({ title: 'Veri.', description: 'You are not allowed to use the admin panel.\nOnly the server owner, Veri. Admin, or Discord administrators may use this.', footer: 'Veri.' })],
          ephemeral: true
        });
      }

      const guild = interaction.guild;
      const cfg = await getGuildConfig(guild.id);
      const embed = await buildAdminPanelEmbed(guild, cfg);
      const rows = buildAdminPanelRows(cfg);

      return interaction.reply({ embeds: [embed], components: rows });
    }

    // -----------------------------------------------------------------------
    // /role-sync
    // -----------------------------------------------------------------------
    if (name === 'role-sync') {
      if (!(await canUseVeriCommands(interaction))) {
        return interaction.reply({
          embeds: [boxEmbed({ title: 'Veri.', description: 'You are not allowed to run this command.', footer: 'Veri.' })],
          ephemeral: true
        });
      }

      await interaction.deferReply();
      const guild = interaction.guild;
      const cfg = await getGuildConfig(guild.id);

      let synced = 0;
      let errors = 0;

      await guild.members.fetch();

      let verifiedRole = cfg.verificationRoleId ? guild.roles.cache.get(cfg.verificationRoleId) : null;
      if (!verifiedRole) {
        verifiedRole = guild.roles.cache.find(r => r.name === 'Captcha Verified');
      }
      const adminRole = cfg.adminRoleId ? guild.roles.cache.get(cfg.adminRoleId) : null;

      for (const [, member] of guild.members.cache) {
        if (member.user.bot) continue;
        try {
          const record = await VerifiedUser.findOne({ userId: member.id });
          if (record?.firstVerified && record.servers.includes(guild.id) && verifiedRole) {
            if (!member.roles.cache.has(verifiedRole.id)) {
              await member.roles.add(verifiedRole, 'Veri. role-sync').catch(() => {});
              synced++;
            }
          }
        } catch {
          errors++;
        }
      }

      const embed = panelEmbed({
        title: 'Veri. Role Sync Complete',
        description: `Role sync completed for **${guild.name}**.`,
        fields: [
          { name: 'Roles Synced', value: `\`${synced}\` members updated`, inline: true },
          { name: 'Errors', value: `\`${errors}\` errors`, inline: true },
          { name: 'Verified Role', value: verifiedRole ? `<@&${verifiedRole.id}>` : '`Not found`', inline: true },
          { name: 'Admin Role', value: adminRole ? `<@&${adminRole.id}>` : '`Not set`', inline: true }
        ],
        footer: 'Veri. Role Sync'
      });

      await interaction.editReply({ embeds: [embed] });
      await sendLog(guild, 'Veri. Role Sync', `Role sync ran by ${interaction.user.id}. ${synced} members synced.`);
    }

    // -----------------------------------------------------------------------
    // /server-backup
    // -----------------------------------------------------------------------
    if (name === 'server-backup') {
      if (!(await canUseVeriCommands(interaction))) {
        return interaction.reply({
          embeds: [boxEmbed({ title: 'Veri.', description: 'You are not allowed to run this command.', footer: 'Veri.' })],
          ephemeral: true
        });
      }

      await interaction.deferReply();
      const guild = interaction.guild;

      try {
        await guild.members.fetch();
        await guild.channels.fetch();
        await guild.roles.fetch();

        const backupData = {
          name: guild.name,
          icon: guild.iconURL(),
          roles: [],
          categories: [],
          channels: [],
          webhooks: []
        };

        for (const [, role] of guild.roles.cache) {
          if (role.managed || role.id === guild.id) continue;
          backupData.roles.push({
            id: role.id,
            name: role.name,
            color: role.color,
            hoist: role.hoist,
            position: role.position,
            permissions: role.permissions.toArray(),
            mentionable: role.mentionable
          });
        }

        for (const [, channel] of guild.channels.cache) {
          if (channel.type !== ChannelType.GuildCategory) continue;
          backupData.categories.push({
            id: channel.id,
            name: channel.name,
            position: channel.position,
            permissions: channel.permissionOverwrites.cache.map(ow => ({
              id: ow.id,
              type: ow.type,
              allow: ow.allow.toArray(),
              deny: ow.deny.toArray()
            }))
          });
        }

        for (const [, channel] of guild.channels.cache) {
          if (channel.type === ChannelType.GuildCategory) continue;
          backupData.channels.push({
            id: channel.id,
            name: channel.name,
            type: channel.type,
            parentId: channel.parentId,
            position: channel.position,
            topic: channel.topic || null,
            nsfw: channel.nsfw || false,
            permissions: channel.permissionOverwrites.cache.map(ow => ({
              id: ow.id,
              type: ow.type,
              allow: ow.allow.toArray(),
              deny: ow.deny.toArray()
            }))
          });
        }

        try {
          const webhooks = await guild.fetchWebhooks();
          for (const [, wh] of webhooks) {
            backupData.webhooks.push({
              id: wh.id,
              name: wh.name,
              channelId: wh.channelId,
              avatar: wh.avatar
            });
          }
        } catch {
          // Insufficient perms for webhooks
        }

        const saved = await ServerBackup.create({
          guildId: guild.id,
          createdBy: interaction.user.id,
          data: backupData
        });

        const embed = panelEmbed({
          title: 'Server Backup Complete',
          description: `A full backup of **${guild.name}** has been saved successfully.`,
          fields: [
            { name: 'Backup ID', value: `\`${saved._id}\``, inline: false },
            { name: 'Roles Backed Up', value: `\`${backupData.roles.length}\``, inline: true },
            { name: 'Categories', value: `\`${backupData.categories.length}\``, inline: true },
            { name: 'Channels', value: `\`${backupData.channels.length}\``, inline: true },
            { name: 'Webhooks', value: `\`${backupData.webhooks.length}\``, inline: true },
            { name: 'Created', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true }
          ],
          footer: 'Veri. Backup - Save the Backup ID to restore later'
        });

        await interaction.editReply({ embeds: [embed] });
        await sendLog(guild, 'Veri. Server Backup', `Server backup created by ${interaction.user.id}. Backup ID: ${saved._id}`);
      } catch (e) {
        console.error('Backup error:', e);
        await interaction.editReply({
          embeds: [boxEmbed({ title: 'Veri.', description: `Backup failed: ${e.message}`, footer: 'Veri.' })]
        });
      }
    }

    // -----------------------------------------------------------------------
    // /server-restore
    // -----------------------------------------------------------------------
    if (name === 'server-restore') {
      if (!(await canUseVeriCommands(interaction))) {
        return interaction.reply({
          embeds: [boxEmbed({ title: 'Veri.', description: 'You are not allowed to run this command.', footer: 'Veri.' })],
          ephemeral: true
        });
      }

      const modal = new ModalBuilder()
        .setTitle('Veri. Server Restore')
        .setCustomId('restore_backup_modal');

      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('backup_id')
            .setLabel('Backup ID (from /server-backup)')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setPlaceholder('e.g. 6650a1b2c3d4e5f6a7b8c9d0')
        )
      );

      await interaction.showModal(modal);
    }

    // -----------------------------------------------------------------------
    // /player info
    // -----------------------------------------------------------------------
    if (name === 'player') {
      const sub = interaction.options.getSubcommand();
      if (sub === 'info') {
        const userId = interaction.options.getString('user_id');

        let user = null;
        try {
          user = await client.users.fetch(userId);
        } catch {
          user = null;
        }

        const displayName = user?.globalName || user?.username || userId;
        const avatarURL = user?.displayAvatarURL({ size: 256 }) || null;

        const record = await VerifiedUser.findOne({ userId });

        let ownerExtra = '';
        if (userId === OWNER_ID) {
          ownerExtra =
            '\n\nStatus: OWNER\n' +
            'About Me: Creator of Veri. Thanks for using my service, it is appreciated! :D\n' +
            'Portfolio: https://www.stanzdev.uk/';
        }

        if (!record) {
          const embed = boxEmbed({
            title: 'Veri. Player Information',
            description:
              `Display Name: ${displayName}\nUser ID: ${userId}\n\nVerification Status: NOT VERIFIED\nFirst Verified: Never\nLast Verification: Never\n\nServers Verified In:\n- None\n\nVerification Stats:\n- Failed Captchas: 0\n- Honeypot Triggers: 0\n\nGlobal Honeypot Blacklist: No` + ownerExtra,
            footer: 'Veri.'
          });
          if (avatarURL) embed.setThumbnail(avatarURL);
          return interaction.reply({ embeds: [embed], ephemeral: false });
        }

        const blacklisted = await isBlacklisted(userId);
        const lines = [];
        lines.push(`Display Name: ${displayName}`);
        lines.push(`User ID: ${userId}`);
        lines.push('');
        lines.push(`Verification Status: ${record.firstVerified ? 'VERIFIED' : 'NOT VERIFIED'}`);
        lines.push(`First Verified: ${record.firstVerified ? new Date(record.firstVerified).toISOString() : 'Never'}`);
        lines.push(`Last Verification: ${record.lastVerification ? new Date(record.lastVerification).toISOString() : 'Never'}`);
        lines.push('');
        lines.push('Servers Verified In:\n' + (record.servers?.length > 0 ? record.servers.map(id => `- ${id}`).join('\n') : '- None'));
        lines.push('');
        lines.push('Verification Stats:');
        lines.push(`- Failed Captchas: ${record.fails || 0}`);
        lines.push(`- Honeypot Triggers: ${record.honeypotTriggers || 0}`);
        lines.push('');
        lines.push(`Global Honeypot Blacklist: ${blacklisted ? 'Yes' : 'No'}`);

        const embed = boxEmbed({ title: 'Veri. Player Information', description: lines.join('\n') + ownerExtra, footer: 'Veri.' });
        if (avatarURL) embed.setThumbnail(avatarURL);

        await interaction.reply({ embeds: [embed], ephemeral: false });

        if (interaction.guild) {
          await sendLog(interaction.guild, 'Veri. Player Info Viewed', `Player info requested for user id ${userId}.`);
        }
      }
    }

    // -----------------------------------------------------------------------
    // /security_score
    // -----------------------------------------------------------------------
    if (name === 'security_score') {
      if (!(await canUseVeriCommands(interaction))) {
        return interaction.reply({
          embeds: [boxEmbed({ title: 'Veri.', description: 'You are not allowed to run this command.', footer: 'Veri.' })],
          ephemeral: true
        });
      }

      const guild = interaction.guild;
      const { score, status, totalUsers, blacklistSize } = await computeSecurityScore(guild);

      const embed = boxEmbed({
        title: 'Veri. Server Security Score',
        description:
          `Server: ${guild.name}\nScore: ${score}/100\nStatus: ${status}\n\nVerified users tracked: ${totalUsers}\nGlobal blacklist size: ${blacklistSize}`,
        footer: 'Veri.'
      });

      return interaction.reply({ embeds: [embed], ephemeral: false });
    }

    // -----------------------------------------------------------------------
    // /veri_resend
    // -----------------------------------------------------------------------
    if (name === 'veri_resend') {
      if (!(await canUseVeriCommands(interaction))) {
        return interaction.reply({
          embeds: [boxEmbed({ title: 'Veri.', description: 'You are not allowed to run this command.', footer: 'Veri.' })],
          ephemeral: true
        });
      }

      const guild = interaction.guild;
      const cfg = await getGuildConfig(guild.id);
      const type = interaction.options.getString('type');

      if (type === 'verification') {
        const verificationChannel = cfg.verificationChannelId
          ? guild.channels.cache.get(cfg.verificationChannelId)
          : guild.channels.cache.find(ch => ch.name === 'verification' && ch.type === ChannelType.GuildText);

        if (!verificationChannel) {
          return interaction.reply({ embeds: [boxEmbed({ title: 'Veri.', description: 'No verification channel configured.', footer: 'Veri.' })], ephemeral: true });
        }

        await sendVerificationMessage(verificationChannel);
        await interaction.reply({ embeds: [boxEmbed({ title: 'Veri.', description: 'Verification message has been re-sent.', footer: 'Veri.' })] });
        await sendLog(guild, 'Veri. Verification Message Re-Sent', 'An administrator re-sent the verification message using /veri_resend.');
        return;
      }

      if (type === 'honeypot') {
        const honeypotChannel = cfg.honeypotChannelId
          ? guild.channels.cache.get(cfg.honeypotChannelId)
          : guild.channels.cache.find(ch => ch.name === '!DO NOT TYPE HERE!' && ch.type === ChannelType.GuildText);

        if (!honeypotChannel) {
          return interaction.reply({ embeds: [boxEmbed({ title: 'Veri.', description: 'No honeypot channel configured.', footer: 'Veri.' })], ephemeral: true });
        }

        await sendHoneypotMessage(honeypotChannel);
        await interaction.reply({ embeds: [boxEmbed({ title: 'Veri.', description: 'Honeypot warning message has been re-sent.', footer: 'Veri.' })] });
        await sendLog(guild, 'Veri. Honeypot Message Re-Sent', 'An administrator re-sent the honeypot message using /veri_resend.');
        return;
      }
    }

    // -----------------------------------------------------------------------
    // /veri_staff
    // -----------------------------------------------------------------------
    if (name === 'veri_staff') {
      if (interaction.user.id !== OWNER_ID) {
        return interaction.reply({
          embeds: [boxEmbed({ title: 'Veri.', description: 'ERROR: Only official Veri. staff can run this.\nIf you have any issues, visit our website.', footer: 'Veri.' })],
          ephemeral: true
        });
      }

      const panelEmbedMsg = panelEmbed({
        title: 'Veri. Staff Control Panel',
        description:
          '> **Owner-Only Panel**\n\n' +
          'All actions are logged and sent to your DMs.\n' +
          'Select an action from the buttons below.\n\n' +
          'Use with caution - some actions are irreversible.',
        fields: [
          { name: 'Quick Stats', value: `Guilds: \`${client.guilds.cache.size}\` | Uptime: \`${formatUptime(Date.now() - BOT_START_TIME)}\``, inline: false }
        ],
        footer: 'Veri. Staff Panel - Owner Only'
      });

      const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('vs_view_blacklist').setLabel('Blacklist').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('vs_view_logs').setLabel('Server Logs').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('vs_remove_this_server_data').setLabel('Remove This Server').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('vs_view_all_servers').setLabel('All Servers').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('vs_system_tools').setLabel('System').setStyle(ButtonStyle.Secondary)
      );
      const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('vs_remove_server_id').setLabel('Remove Server by ID').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('vs_force_verify').setLabel('Force Verify').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('vs_reset_user').setLabel('Reset User').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('vs_remove_blacklist').setLabel('Remove Blacklist').setStyle(ButtonStyle.Success)
      );
      const row3 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('vs_clear_honeypot').setLabel('Clear Honeypot').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('vs_clear_fails').setLabel('Clear Fails').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('vs_remove_bot_server').setLabel('Remove Bot (by ID)').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('vs_remove_bot_this_server').setLabel('Remove Bot (here)').setStyle(ButtonStyle.Danger)
      );
      const row4 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('vs_restore_db').setLabel('Restore Database').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('vs_resend_verification').setLabel('Resend Verify Msg').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('vs_resend_honeypot').setLabel('Resend Honeypot Msg').setStyle(ButtonStyle.Primary)
      );

      await interaction.reply({ embeds: [panelEmbedMsg], components: [row1, row2, row3, row4], ephemeral: false });
    }
  }

  // =========================================================================
  // BUTTONS
  // =========================================================================
  if (interaction.isButton()) {
    const id = interaction.customId;

    // -----------------------------------------------------------------------
    // Verify button
    // -----------------------------------------------------------------------
    if (id === 'veri_start') {
      const guild = interaction.guild;
      const cfg = await getGuildConfig(guild.id);

      if (!cfg.captchaEnabled) {
        return interaction.reply({ embeds: [boxEmbed({ title: 'Veri.', description: 'Verification is currently disabled on this server.', footer: 'Veri.' })], ephemeral: true });
      }

      if (cfg.raidLocked) {
        return interaction.reply({ embeds: [boxEmbed({ title: 'Veri.', description: 'This server is currently under a raid lock. Verification is temporarily disabled.\nPlease try again later.', footer: 'Veri.' })], ephemeral: true });
      }

      // Verification cooldown check
      const cooldownSeconds = cfg.verificationCooldownSeconds || 30;
      const lastAttempt = verifyCooldowns.get(interaction.user.id + guild.id);
      if (lastAttempt) {
        const elapsed = (Date.now() - lastAttempt) / 1000;
        if (elapsed < cooldownSeconds) {
          const remaining = Math.ceil(cooldownSeconds - elapsed);
          return interaction.reply({
            embeds: [boxEmbed({
              title: 'Veri.',
              description: `Please wait **${remaining} more second(s)** before requesting verification again.`,
              footer: 'Veri. Cooldown'
            })],
            ephemeral: true
          });
        }
      }
      verifyCooldowns.set(interaction.user.id + guild.id, Date.now());

      const dm = await interaction.user.createDM().catch(() => null);
      if (!dm) {
        await sendLog(guild, 'Veri. Verification DM Failed', `User ${interaction.user.id} clicked Verify but Veri. could not open a DM.`);
        return interaction.reply({ embeds: [boxEmbed({ title: 'Veri.', description: 'Veri. could not send you a DM.\nPlease enable DMs from server members and try again.', footer: 'Veri.' })], ephemeral: true });
      }

      const record = await VerifiedUser.findOne({ userId: interaction.user.id });
      if (record?.firstVerified && record.servers.includes(guild.id)) {
        return interaction.reply({ embeds: [boxEmbed({ title: 'Veri.', description: 'You are already verified in this server.', footer: 'Veri.' })], ephemeral: true });
      }

      const { file, answer } = getRandomCaptcha();
      captchaSessions.set(interaction.user.id, { answer, guildId: guild.id });

      const dmEmbed = boxEmbed({
        title: 'Veri. Verification',
        description: 'You are verifying for a server using Veri.\n\nLook at the image and reply with the correct number.\nReply with only the number.',
        footer: 'Veri.'
      });

      await dm.send({ embeds: [dmEmbed], files: [path.join(__dirname, file)] });

      return interaction.reply({ embeds: [boxEmbed({ title: 'Veri.', description: 'Veri. has sent you a DM with your verification captcha.', footer: 'Veri.' })], ephemeral: true });
    }

    // -----------------------------------------------------------------------
    // Help buttons
    // -----------------------------------------------------------------------
    if (id === 'help_quickstart') {
      const embed = panelEmbed({
        title: 'Veri. Quick Start Guide',
        description:
          'Getting Veri. set up is simple. Follow these steps:\n\n' +
          '**Step 1 - Invite Veri.**\nInvite Veri. to your server with **Administrator** permission.\n\n' +
          '**Step 2 - Set role position**\nMake sure the **Veri.** role is near the **top** of your role list (above all other roles you want it to manage).\n\n' +
          '**Step 3 - Run /setup**\nThis creates all channels, categories, and roles automatically.\n\n' +
          '**Step 4 - Customise**\nUse `/admin-panel` to toggle security features, change the honeypot mode, set roles, and more.\n\n' +
          '**Step 5 - Get help**\nJoin our support server at [discord.gg/K6x4qwZCNM](https://discord.gg/K6x4qwZCNM) for any issues.',
        footer: 'Veri. Quick Start'
      });
      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (id === 'help_features') {
      const embed = panelEmbed({
        title: 'Veri. Security Features',
        description: 'A breakdown of all security features you can enable in Veri.',
        fields: [
          { name: 'Captcha Verification', value: 'Sends new members a DM with an image captcha. They must answer correctly to gain access.', inline: false },
          { name: 'Honeypot Channel', value: 'A trap channel visible to new members. Anyone who types in it is flagged as a bot or compromised account.', inline: false },
          { name: 'Anti-Token-Logger', value: 'Flags accounts with no avatar and very new account age, or default username patterns. Suspicious accounts are kicked automatically.', inline: false },
          { name: 'Join-Age Requirement', value: 'Blocks accounts younger than a set number of days from joining. They are DM\'d explaining why and told to rejoin when eligible.', inline: false },
          { name: 'Anti-Raid Cooldown', value: 'Detects when too many users join too fast, locks verification, alerts all admins, and enables global ban on any honeypot triggers during the lock.', inline: false },
          { name: 'Verification Cooldown', value: 'Prevents users from spamming the verify button. Cooldown duration is configurable per server via the admin panel.', inline: false }
        ],
        footer: 'Veri. Security Features'
      });
      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    // -----------------------------------------------------------------------
    // Admin Panel buttons (ap_*)
    // -----------------------------------------------------------------------
    if (id.startsWith('ap_')) {
      if (!(await canUseVeriCommands(interaction))) {
        return interaction.reply({ embeds: [boxEmbed({ title: 'Veri.', description: 'You do not have permission to use the admin panel.', footer: 'Veri.' })], ephemeral: true });
      }

      const guild = interaction.guild;
      let cfg = await getGuildConfig(guild.id);

      // Toggle buttons
      if (id === 'ap_toggle_captcha') {
        cfg.captchaEnabled = !cfg.captchaEnabled;
        if (!cfg.captchaEnabled && cfg.verificationChannelId) {
          const ch = guild.channels.cache.get(cfg.verificationChannelId);
          if (ch) await ch.delete('Veri. captcha disabled via admin panel').catch(() => {});
          cfg.verificationChannelId = null;
        } else if (cfg.captchaEnabled && !cfg.verificationChannelId) {
          try {
            const category = await getOrCreateVeriCategory(guild, cfg);
            const verificationChannel = await guild.channels.create({ name: 'verification', type: ChannelType.GuildText, parent: category.id, reason: 'Veri. captcha re-enabled' });
            cfg.verificationChannelId = verificationChannel.id;
            await sendVerificationMessage(verificationChannel);
          } catch {
            // ignore
          }
        }
        await saveGuildConfig(cfg);
        await sendLog(guild, 'Veri. Admin Panel', `Captcha ${cfg.captchaEnabled ? 'enabled' : 'disabled'} by ${interaction.user.id}`);
        cfg = await getGuildConfig(guild.id);
        return interaction.update({ embeds: [await buildAdminPanelEmbed(guild, cfg)], components: buildAdminPanelRows(cfg) });
      }

      if (id === 'ap_toggle_honeypot') {
        cfg.honeypotEnabled = !cfg.honeypotEnabled;
        if (!cfg.honeypotEnabled && cfg.honeypotChannelId) {
          const ch = guild.channels.cache.get(cfg.honeypotChannelId);
          if (ch) await ch.delete('Veri. honeypot disabled via admin panel').catch(() => {});
          cfg.honeypotChannelId = null;
        } else if (cfg.honeypotEnabled && !cfg.honeypotChannelId) {
          try {
            const category = await getOrCreateVeriCategory(guild, cfg);
            const honeypotChannel = await guild.channels.create({ name: '!DO NOT TYPE HERE!', type: ChannelType.GuildText, parent: category.id, reason: 'Veri. honeypot re-enabled' });
            cfg.honeypotChannelId = honeypotChannel.id;
            await sendHoneypotMessage(honeypotChannel);
          } catch {
            // ignore
          }
        }
        await saveGuildConfig(cfg);
        await sendLog(guild, 'Veri. Admin Panel', `Honeypot ${cfg.honeypotEnabled ? 'enabled' : 'disabled'} by ${interaction.user.id}`);
        cfg = await getGuildConfig(guild.id);
        return interaction.update({ embeds: [await buildAdminPanelEmbed(guild, cfg)], components: buildAdminPanelRows(cfg) });
      }

      if (id === 'ap_toggle_antitokenlogger') {
        cfg.antiTokenLoggerEnabled = !cfg.antiTokenLoggerEnabled;
        await saveGuildConfig(cfg);
        await sendLog(guild, 'Veri. Admin Panel', `Anti-Token-Logger ${cfg.antiTokenLoggerEnabled ? 'enabled' : 'disabled'} by ${interaction.user.id}`);
        cfg = await getGuildConfig(guild.id);
        return interaction.update({ embeds: [await buildAdminPanelEmbed(guild, cfg)], components: buildAdminPanelRows(cfg) });
      }

      if (id === 'ap_toggle_joinage') {
        cfg.joinAgeEnabled = !cfg.joinAgeEnabled;
        await saveGuildConfig(cfg);
        await sendLog(guild, 'Veri. Admin Panel', `Join-Age Requirement ${cfg.joinAgeEnabled ? 'enabled' : 'disabled'} by ${interaction.user.id}`);
        cfg = await getGuildConfig(guild.id);
        return interaction.update({ embeds: [await buildAdminPanelEmbed(guild, cfg)], components: buildAdminPanelRows(cfg) });
      }

      if (id === 'ap_toggle_antiraid') {
        cfg.antiRaidEnabled = !cfg.antiRaidEnabled;
        await saveGuildConfig(cfg);
        await sendLog(guild, 'Veri. Admin Panel', `Anti-Raid ${cfg.antiRaidEnabled ? 'enabled' : 'disabled'} by ${interaction.user.id}`);
        cfg = await getGuildConfig(guild.id);
        return interaction.update({ embeds: [await buildAdminPanelEmbed(guild, cfg)], components: buildAdminPanelRows(cfg) });
      }

      if (id === 'ap_unlock_raid') {
        if (!cfg.raidLocked) {
          return interaction.reply({ embeds: [boxEmbed({ title: 'Veri.', description: 'There is no active raid lock to unlock.', footer: 'Veri.' })], ephemeral: true });
        }
        cfg.raidLocked = false;
        await saveGuildConfig(cfg);
        raidJoinTracker.delete(guild.id);
        await sendLog(guild, 'Veri. Raid Lock Lifted', `Raid lock manually lifted by ${interaction.user.id}. Verification is now open.`);
        cfg = await getGuildConfig(guild.id);
        return interaction.update({ embeds: [await buildAdminPanelEmbed(guild, cfg)], components: buildAdminPanelRows(cfg) });
      }

      if (id === 'ap_set_roles') {
        const modal = new ModalBuilder().setTitle('Set Veri. Roles').setCustomId('ap_set_roles_modal');
        modal.addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('verified_role_id')
              .setLabel("Verified Role ID")
              .setStyle(TextInputStyle.Short)
              .setRequired(false)
              .setPlaceholder(cfg.verificationRoleId || 'Paste a Role ID here')
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('admin_role_id')
              .setLabel('Admin Role ID')
              .setStyle(TextInputStyle.Short)
              .setRequired(false)
              .setPlaceholder(cfg.adminRoleId || 'Paste a Role ID here')
          )
        );
        await interaction.showModal(modal);
        return;
      }

      if (id === 'ap_config_settings') {
        const modal = new ModalBuilder().setTitle('Configure Veri. Settings').setCustomId('ap_config_settings_modal');
        modal.addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('verify_cooldown')
              .setLabel('Cooldown: seconds (default 30)')
              .setStyle(TextInputStyle.Short)
              .setRequired(false)
              .setPlaceholder(`${cfg.verificationCooldownSeconds || 30}`)
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('join_age_days')
              .setLabel('Join-Age: days (default 7)')
              .setStyle(TextInputStyle.Short)
              .setRequired(false)
              .setPlaceholder(`${cfg.joinAgeMinDays || 7}`)
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('token_logger_min_age')
              .setLabel('Token-Logger min age (days)')
              .setStyle(TextInputStyle.Short)
              .setRequired(false)
              .setPlaceholder(`${cfg.antiTokenLoggerMinAge || 7}`)
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('raid_threshold')
              .setLabel('Raid: joins trigger (default 10)')
              .setStyle(TextInputStyle.Short)
              .setRequired(false)
              .setPlaceholder(`${cfg.antiRaidThreshold || 10}`)
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('raid_window')
              .setLabel('Raid window: seconds (default 30)')
              .setStyle(TextInputStyle.Short)
              .setRequired(false)
              .setPlaceholder(`${cfg.antiRaidWindowSeconds || 30}`)
          )
        );
        await interaction.showModal(modal);
        return;
      }

      if (id === 'ap_role_sync') {
        await interaction.deferReply({ ephemeral: true });
        await guild.members.fetch();
        let synced = 0;
        let verifiedRole = cfg.verificationRoleId ? guild.roles.cache.get(cfg.verificationRoleId) : null;
        if (!verifiedRole) verifiedRole = guild.roles.cache.find(r => r.name === 'Captcha Verified');

        for (const [, member] of guild.members.cache) {
          if (member.user.bot) continue;
          const record = await VerifiedUser.findOne({ userId: member.id });
          if (record?.firstVerified && record.servers.includes(guild.id) && verifiedRole) {
            if (!member.roles.cache.has(verifiedRole.id)) {
              await member.roles.add(verifiedRole, 'Veri. role-sync from admin panel').catch(() => {});
              synced++;
            }
          }
        }
        await interaction.editReply({ embeds: [boxEmbed({ title: 'Veri. Role Sync', description: `Role sync complete. ${synced} member(s) updated.`, footer: 'Veri.' })] });
        await sendLog(guild, 'Veri. Role Sync', `Role sync ran from admin panel by ${interaction.user.id}. ${synced} members synced.`);
        const updatedCfg = await getGuildConfig(guild.id);
        await interaction.message.edit({ embeds: [await buildAdminPanelEmbed(guild, updatedCfg)], components: buildAdminPanelRows(updatedCfg) }).catch(() => {});
        return;
      }

      if (id === 'ap_server_backup') {
        await interaction.deferReply({ ephemeral: true });
        try {
          await guild.members.fetch();
          await guild.channels.fetch();
          await guild.roles.fetch();
          const backupData = { name: guild.name, icon: guild.iconURL(), roles: [], categories: [], channels: [], webhooks: [] };
          for (const [, role] of guild.roles.cache) {
            if (role.managed || role.id === guild.id) continue;
            backupData.roles.push({ id: role.id, name: role.name, color: role.color, hoist: role.hoist, position: role.position, permissions: role.permissions.toArray(), mentionable: role.mentionable });
          }
          for (const [, channel] of guild.channels.cache) {
            if (channel.type !== ChannelType.GuildCategory) continue;
            backupData.categories.push({ id: channel.id, name: channel.name, position: channel.position });
          }
          for (const [, channel] of guild.channels.cache) {
            if (channel.type === ChannelType.GuildCategory) continue;
            backupData.channels.push({ id: channel.id, name: channel.name, type: channel.type, parentId: channel.parentId, position: channel.position });
          }
          try {
            const webhooks = await guild.fetchWebhooks();
            for (const [, wh] of webhooks) {
              backupData.webhooks.push({ id: wh.id, name: wh.name, channelId: wh.channelId });
            }
          } catch { /* no webhook perms */ }

          const saved = await ServerBackup.create({ guildId: guild.id, createdBy: interaction.user.id, data: backupData });
          await interaction.editReply({ embeds: [panelEmbed({ title: 'Backup Complete', description: `Backup saved!\n\n**Backup ID:** \`${saved._id}\`\nRoles: ${backupData.roles.length} | Channels: ${backupData.channels.length} | Categories: ${backupData.categories.length} | Webhooks: ${backupData.webhooks.length}`, footer: 'Veri. Backup' })] });
          await sendLog(guild, 'Veri. Server Backup', `Backup created by ${interaction.user.id}. ID: ${saved._id}`);
        } catch (e) {
          await interaction.editReply({ embeds: [boxEmbed({ title: 'Veri.', description: `Backup failed: ${e.message}`, footer: 'Veri.' })] });
        }
        const updatedCfg = await getGuildConfig(guild.id);
        await interaction.message.edit({ embeds: [await buildAdminPanelEmbed(guild, updatedCfg)], components: buildAdminPanelRows(updatedCfg) }).catch(() => {});
        return;
      }

      if (id === 'ap_server_restore') {
        const modal = new ModalBuilder().setTitle('Restore Server Backup').setCustomId('restore_backup_modal');
        modal.addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('backup_id').setLabel('Backup ID').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('e.g. 6650a1b2c3d4e5f6a7b8c9d0')
          )
        );
        await interaction.showModal(modal);
        return;
      }

      if (id === 'ap_resend_verify') {
        const verificationChannel = cfg.verificationChannelId ? guild.channels.cache.get(cfg.verificationChannelId) : null;
        if (!verificationChannel) {
          return interaction.reply({ embeds: [boxEmbed({ title: 'Veri.', description: 'No verification channel configured.', footer: 'Veri.' })], ephemeral: true });
        }
        await sendVerificationMessage(verificationChannel);
        await interaction.reply({ embeds: [boxEmbed({ title: 'Veri.', description: 'Verification message re-sent.', footer: 'Veri.' })], ephemeral: true });
        await sendLog(guild, 'Veri. Verification Message Re-Sent', `Re-sent via admin panel by ${interaction.user.id}`);
        const updatedCfg = await getGuildConfig(guild.id);
        await interaction.message.edit({ embeds: [await buildAdminPanelEmbed(guild, updatedCfg)], components: buildAdminPanelRows(updatedCfg) }).catch(() => {});
        return;
      }

      if (id === 'ap_resend_honeypot') {
        const honeypotChannel = cfg.honeypotChannelId ? guild.channels.cache.get(cfg.honeypotChannelId) : null;
        if (!honeypotChannel) {
          return interaction.reply({ embeds: [boxEmbed({ title: 'Veri.', description: 'No honeypot channel configured.', footer: 'Veri.' })], ephemeral: true });
        }
        await sendHoneypotMessage(honeypotChannel);
        await interaction.reply({ embeds: [boxEmbed({ title: 'Veri.', description: 'Honeypot message re-sent.', footer: 'Veri.' })], ephemeral: true });
        await sendLog(guild, 'Veri. Honeypot Message Re-Sent', `Re-sent via admin panel by ${interaction.user.id}`);
        const updatedCfg = await getGuildConfig(guild.id);
        await interaction.message.edit({ embeds: [await buildAdminPanelEmbed(guild, updatedCfg)], components: buildAdminPanelRows(updatedCfg) }).catch(() => {});
        return;
      }

      if (id === 'ap_security_score') {
        const { score, status, totalUsers, blacklistSize } = await computeSecurityScore(guild);
        return interaction.reply({
          embeds: [panelEmbed({
            title: 'Security Score',
            description: `**${guild.name}** security overview`,
            fields: [
              { name: 'Score', value: `\`${score}/100\``, inline: true },
              { name: 'Status', value: `\`${status}\``, inline: true },
              { name: 'Verified Users', value: `\`${totalUsers}\``, inline: true },
              { name: 'Blacklist Size', value: `\`${blacklistSize}\``, inline: true }
            ],
            footer: 'Veri. Security Score'
          })],
          ephemeral: true
        });
      }

      if (id === 'ap_digest_setup') {
        const modal = new ModalBuilder().setTitle('Stats Digest Setup').setCustomId('ap_digest_modal');
        modal.addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('frequency')
              .setLabel('Frequency: daily, weekly, or monthly')
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
              .setPlaceholder('daily')
          )
        );
        await interaction.showModal(modal);
        return;
      }
    }

    // -----------------------------------------------------------------------
    // Staff buttons (vs_*)
    // -----------------------------------------------------------------------
    if (id.startsWith('vs_') && !id.startsWith('vs_guild_')) {
      if (interaction.user.id !== OWNER_ID) {
        return interaction.reply({ embeds: [boxEmbed({ title: 'Veri.', description: 'ERROR: Only official Veri. staff can run this.\nIf you have any issues, visit our website.', footer: 'Veri.' })], ephemeral: true });
      }

      const dm = await interaction.user.createDM().catch(() => null);
      if (!dm) {
        return interaction.reply({ embeds: [boxEmbed({ title: 'Veri.', description: 'Veri. could not send you a DM.\nStaff actions require DMs to be enabled.', footer: 'Veri.' })], ephemeral: true });
      }

      const guild = interaction.guild;

      if (id === 'vs_view_blacklist') {
        const list = await getBlacklistArray();
        if (list.length === 0) {
          await dm.send({ embeds: [boxEmbed({ title: 'Veri. Staff - Global Blacklist', description: 'The global blacklist is currently empty.', footer: 'Veri.' })] });
        } else {
          const chunks = [];
          let current = [];
          for (const uid of list) {
            current.push(`- ${uid}`);
            if (current.join('\n').length > 1500) { chunks.push(current.join('\n')); current = []; }
          }
          if (current.length) chunks.push(current.join('\n'));
          let index = 1;
          for (const chunk of chunks) {
            await dm.send({ embeds: [boxEmbed({ title: `Veri. Staff - Global Blacklist (Page ${index})`, description: chunk, footer: 'Veri.' })] });
            index++;
          }
        }
        return interaction.reply({ embeds: [boxEmbed({ title: 'Veri.', description: 'Global blacklist sent to your DMs.', footer: 'Veri.' })], ephemeral: false });
      }

      if (id === 'vs_view_logs') {
        const cfg = await getGuildConfig(guild.id);
        const logsChannel = cfg.logsChannelId ? guild.channels.cache.get(cfg.logsChannelId) : null;

        if (!logsChannel || logsChannel.type !== ChannelType.GuildText) {
          await dm.send({ embeds: [boxEmbed({ title: 'Veri. Staff - Server Logs', description: 'No valid logs channel is configured for this server.', footer: 'Veri.' })] });
        } else {
          const messages = await logsChannel.messages.fetch({ limit: 50 }).catch(() => null);
          if (!messages || messages.size === 0) {
            await dm.send({ embeds: [boxEmbed({ title: 'Veri. Staff - Server Logs', description: 'No recent Veri. logs found.', footer: 'Veri.' })] });
          } else {
            const sorted = [...messages.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
            const lines = sorted.map(m => `- [${new Date(m.createdTimestamp).toISOString()}] ${m.author.tag}: ${m.embeds[0]?.title || m.content || '(embed)'}`);
            const chunks = [];
            let current = [];
            for (const line of lines) {
              current.push(line);
              if (current.join('\n').length > 1500) { chunks.push(current.join('\n')); current = []; }
            }
            if (current.length) chunks.push(current.join('\n'));
            let index = 1;
            for (const chunk of chunks) {
              await dm.send({ embeds: [boxEmbed({ title: `Veri. Staff - Server Logs (Page ${index})`, description: chunk, footer: 'Veri.' })] });
              index++;
            }
          }
        }
        return interaction.reply({ embeds: [boxEmbed({ title: 'Veri.', description: 'Server logs sent to your DMs.', footer: 'Veri.' })], ephemeral: false });
      }

      if (id === 'vs_remove_this_server_data') {
        await GuildConfig.deleteOne({ guildId: guild.id });
        await dm.send({ embeds: [boxEmbed({ title: 'Veri. Staff - Remove This Server Data', description: `All Veri. data for server ID ${guild.id} removed.`, footer: 'Veri.' })] });
        return interaction.reply({ embeds: [boxEmbed({ title: 'Veri.', description: 'This server data has been removed. Details sent to your DMs.', footer: 'Veri.' })], ephemeral: false });
      }

      if (id === 'vs_view_all_servers') {
        const guilds = [...client.guilds.cache.values()];
        if (guilds.length === 0) {
          await dm.send({ embeds: [boxEmbed({ title: 'Veri. Staff - Global Server Overview', description: 'Veri. is not currently in any servers.', footer: 'Veri.' })] });
        } else {
          const chunkSize = 3;
          for (let i = 0; i < guilds.length; i += chunkSize) {
            const slice = guilds.slice(i, i + chunkSize);
            const lines = [];
            const rows = [];
            for (const g of slice) {
              const { score, status } = await computeSecurityScore(g);
              const { reputation, repLabel, risk } = await computeGuildReputationAndRisk(g);
              const verifiedCount = await VerifiedUser.countDocuments({ servers: g.id });
              const totalFails = (await VerifiedUser.find({ servers: g.id })).reduce((acc, r) => acc + (r.fails || 0), 0);
              const totalHoneypot = (await VerifiedUser.find({ servers: g.id })).reduce((acc, r) => acc + (r.honeypotTriggers || 0), 0);
              const memberCount = g.memberCount || 0;
              const unverifiedApprox = memberCount > verifiedCount ? memberCount - verifiedCount : 0;

              lines.push(`=== ${g.name} ===`);
              lines.push(`ID: ${g.id}`);
              lines.push(`Security Score: ${score}/100 (${status})`);
              lines.push(`Reputation: ${reputation}/100 (${repLabel})`);
              lines.push(`Risk Level: ${risk}`);
              lines.push(`Members: ${memberCount} | Verified (approx): ${verifiedCount} | Unverified: ${unverifiedApprox}`);
              lines.push(`Failed Captchas: ${totalFails} | Honeypot Triggers: ${totalHoneypot}`);
              lines.push('');

              const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`vs_guild_${g.id}_logs`).setLabel('View Logs').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId(`vs_guild_${g.id}_remove`).setLabel('Remove Server Data').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId(`vs_guild_${g.id}_system`).setLabel('System Tools').setStyle(ButtonStyle.Primary)
              );
              rows.push(row);
            }
            await dm.send({ embeds: [boxEmbed({ title: 'Veri. Global Server Overview', description: lines.join('\n'), footer: 'Veri.' })], components: rows });
          }
        }
        return interaction.reply({ embeds: [boxEmbed({ title: 'Veri.', description: 'Global server overview sent to your DMs.', footer: 'Veri.' })], ephemeral: false });
      }

      if (id === 'vs_system_tools') {
        const modal = new ModalBuilder().setTitle('Veri. Staff - System Tools').setCustomId('vs_system_tools_modal');
        modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('dummy').setLabel('Type "run" to execute system tools summary').setStyle(TextInputStyle.Short).setRequired(true)));
        await interaction.showModal(modal);
        return;
      }

      if (id === 'vs_resend_verification') {
        const cfg = await getGuildConfig(guild.id);
        const verificationChannel = cfg.verificationChannelId
          ? guild.channels.cache.get(cfg.verificationChannelId)
          : guild.channels.cache.find(ch => ch.name === 'verification' && ch.type === ChannelType.GuildText);
        if (!verificationChannel) {
          return interaction.reply({ embeds: [boxEmbed({ title: 'Veri.', description: 'No verification channel configured.', footer: 'Veri.' })], ephemeral: true });
        }
        await sendVerificationMessage(verificationChannel);
        await interaction.reply({ embeds: [boxEmbed({ title: 'Veri.', description: 'Verification message re-sent.', footer: 'Veri.' })], ephemeral: false });
        await sendLog(guild, 'Veri. Verification Message Re-Sent', 'Staff re-sent via Staff Panel.');
        return;
      }

      if (id === 'vs_resend_honeypot') {
        const cfg = await getGuildConfig(guild.id);
        const honeypotChannel = cfg.honeypotChannelId
          ? guild.channels.cache.get(cfg.honeypotChannelId)
          : guild.channels.cache.find(ch => ch.name === '!DO NOT TYPE HERE!' && ch.type === ChannelType.GuildText);
        if (!honeypotChannel) {
          return interaction.reply({ embeds: [boxEmbed({ title: 'Veri.', description: 'No honeypot channel configured.', footer: 'Veri.' })], ephemeral: true });
        }
        await sendHoneypotMessage(honeypotChannel);
        await interaction.reply({ embeds: [boxEmbed({ title: 'Veri.', description: 'Honeypot message re-sent.', footer: 'Veri.' })], ephemeral: false });
        await sendLog(guild, 'Veri. Honeypot Message Re-Sent', 'Staff re-sent via Staff Panel.');
        return;
      }

      if (id === 'vs_remove_bot_this_server') {
        await dm.send({ embeds: [boxEmbed({ title: 'Veri. Staff - Remove Bot From This Server', description: `Veri. will leave server ID ${guild.id} (${guild.name}).`, footer: 'Veri.' })] });
        await interaction.reply({ embeds: [boxEmbed({ title: 'Veri.', description: 'Veri. is leaving this server.', footer: 'Veri.' })], ephemeral: false });
        setTimeout(() => { guild.leave().catch(() => {}); }, 2000);
        return;
      }

      if (id === 'vs_remove_bot_server') {
        const modal = new ModalBuilder().setTitle('Veri. Staff - Remove Bot From Server').setCustomId('vs_remove_bot_server_modal');
        modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('server_id').setLabel('Server ID to remove Veri. from').setStyle(TextInputStyle.Short).setRequired(true)));
        await interaction.showModal(modal);
        return;
      }

      if (id === 'vs_restore_db') {
        const modal = new ModalBuilder().setTitle('Veri. Staff - Restore Database').setCustomId('vs_restore_db_modal');
        modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('db_json').setLabel('Paste Veri. JSON (type RESTORE at start)').setStyle(TextInputStyle.Paragraph).setRequired(true)));
        await interaction.showModal(modal);
        return;
      }

      const modal = new ModalBuilder().setTitle('Veri. Staff').setCustomId(id + '_modal');

      if (id === 'vs_remove_server_id') {
        modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('server_id').setLabel('Server ID to remove from Veri. data').setStyle(TextInputStyle.Short).setRequired(true)));
      } else if (id === 'vs_force_verify') {
        modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('user_id').setLabel('User ID to force verify').setStyle(TextInputStyle.Short).setRequired(true)));
      } else if (id === 'vs_reset_user') {
        modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('user_id').setLabel('User ID to reset').setStyle(TextInputStyle.Short).setRequired(true)));
      } else if (id === 'vs_clear_honeypot') {
        modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('user_id').setLabel('User ID to clear honeypot triggers').setStyle(TextInputStyle.Short).setRequired(true)));
      } else if (id === 'vs_clear_fails') {
        modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('user_id').setLabel('User ID to clear captcha fails').setStyle(TextInputStyle.Short).setRequired(true)));
      } else if (id === 'vs_remove_blacklist') {
        modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('user_id').setLabel('User ID to remove from global blacklist').setStyle(TextInputStyle.Short).setRequired(true)));
      } else {
        return;
      }

      await interaction.showModal(modal);
      return;
    }

    // Per-server buttons from global overview
    if (id.startsWith('vs_guild_')) {
      if (interaction.user.id !== OWNER_ID) {
        return interaction.reply({ embeds: [boxEmbed({ title: 'Veri.', description: 'ERROR: Only official Veri. staff can run this.', footer: 'Veri.' })], ephemeral: true });
      }

      const dm = await interaction.user.createDM().catch(() => null);
      if (!dm) {
        return interaction.reply({ embeds: [boxEmbed({ title: 'Veri.', description: 'Veri. could not send you a DM.', footer: 'Veri.' })], ephemeral: true });
      }

      const withoutPrefix = id.slice('vs_guild_'.length);
      const underscoreIdx = withoutPrefix.lastIndexOf('_');
      const guildId = withoutPrefix.slice(0, underscoreIdx);
      const action = withoutPrefix.slice(underscoreIdx + 1);

      const targetGuild = client.guilds.cache.get(guildId) || (await client.guilds.fetch(guildId).catch(() => null));
      if (!targetGuild) {
        return interaction.reply({ embeds: [boxEmbed({ title: 'Veri.', description: `Guild ${guildId} is no longer available.`, footer: 'Veri.' })], ephemeral: true });
      }

      if (action === 'logs') {
        const cfg = await getGuildConfig(targetGuild.id);
        const logsChannel = cfg.logsChannelId ? targetGuild.channels.cache.get(cfg.logsChannelId) : null;
        if (!logsChannel || logsChannel.type !== ChannelType.GuildText) {
          await dm.send({ embeds: [boxEmbed({ title: 'Veri. Staff - Server Logs', description: `No valid logs channel for server ${targetGuild.id}.`, footer: 'Veri.' })] });
        } else {
          const messages = await logsChannel.messages.fetch({ limit: 50 }).catch(() => null);
          if (!messages || messages.size === 0) {
            await dm.send({ embeds: [boxEmbed({ title: 'Veri. Staff - Server Logs', description: `No recent logs for server ${targetGuild.id}.`, footer: 'Veri.' })] });
          } else {
            const sorted = [...messages.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
            const lines = sorted.map(m => `- [${new Date(m.createdTimestamp).toISOString()}] ${m.author.tag}: ${m.embeds[0]?.title || m.content || '(embed)'}`);
            const chunks = [];
            let current = [];
            for (const line of lines) {
              current.push(line);
              if (current.join('\n').length > 1500) { chunks.push(current.join('\n')); current = []; }
            }
            if (current.length) chunks.push(current.join('\n'));
            let index = 1;
            for (const chunk of chunks) {
              await dm.send({ embeds: [boxEmbed({ title: `Veri. Staff - Server Logs (${targetGuild.name}) (Page ${index})`, description: chunk, footer: 'Veri.' })] });
              index++;
            }
          }
        }
        return interaction.reply({ embeds: [boxEmbed({ title: 'Veri.', description: `Logs for ${targetGuild.name} sent to your DMs.`, footer: 'Veri.' })], ephemeral: false });
      }

      if (action === 'remove') {
        await GuildConfig.deleteOne({ guildId: targetGuild.id });
        await dm.send({ embeds: [boxEmbed({ title: 'Veri. Staff - Remove Server Data', description: `Data for server ${targetGuild.id} (${targetGuild.name}) removed.`, footer: 'Veri.' })] });
        return interaction.reply({ embeds: [boxEmbed({ title: 'Veri.', description: `Server data for ${targetGuild.name} removed.`, footer: 'Veri.' })], ephemeral: false });
      }

      if (action === 'system') {
        const modal = new ModalBuilder().setTitle(`Veri. Staff - ${targetGuild.name}`).setCustomId(`vs_guild_${targetGuild.id}_system_modal`);
        modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('dummy').setLabel('Type "run" to execute system tools summary').setStyle(TextInputStyle.Short).setRequired(true)));
        await interaction.showModal(modal);
        return;
      }
    }
  }

  // =========================================================================
  // SELECT MENUS
  // =========================================================================
  if (interaction.isStringSelectMenu()) {
    const id = interaction.customId;

    if (id === 'ap_honeypot_mode') {
      if (!(await canUseVeriCommands(interaction))) {
        return interaction.reply({ embeds: [boxEmbed({ title: 'Veri.', description: 'You do not have permission.', footer: 'Veri.' })], ephemeral: true });
      }
      const guild = interaction.guild;
      const cfg = await getGuildConfig(guild.id);
      cfg.honeypotMode = interaction.values[0];
      await saveGuildConfig(cfg);
      await sendLog(guild, 'Veri. Admin Panel', `Honeypot mode set to ${cfg.honeypotMode} by ${interaction.user.id}`);
      const updatedCfg = await getGuildConfig(guild.id);
      return interaction.update({ embeds: [await buildAdminPanelEmbed(guild, updatedCfg)], components: buildAdminPanelRows(updatedCfg) });
    }

    if (id === 'help_category') {
      const val = interaction.values[0];
      let embed;

      if (val === 'open') {
        embed = panelEmbed({
          title: 'Open Commands',
          description:
            '`/ping` - Shows WebSocket ping, API ping, and MongoDB ping\n' +
            '`/uptime` - Shows how long Veri. has been online, last restart, memory usage, CPU usage\n' +
            '`/help` - This interactive help menu\n' +
            '`/player info <user_id>` - Look up any user\'s Veri. verification record',
          footer: 'Veri. Help - Open Commands'
        });
      } else if (val === 'staff') {
        embed = panelEmbed({
          title: 'Staff Commands',
          description:
            'These commands require the **Veri. Admin** role, **Administrator** permission, or server ownership.\n\n' +
            '`/setup` - Initial bot setup. Creates all channels, roles, and categories automatically.\n' +
            '`/admin-panel` - Full interactive panel with toggle buttons, dropdowns for honeypot mode, role sync, backup/restore, and personal stats digest setup.\n' +
            '`/role-sync` - Syncs the verified role to all users who have a verified record in this server.\n' +
            '`/server-backup` - Saves a snapshot of roles, channels, categories, permissions, and webhooks to the database.\n' +
            '`/server-restore` - Restores a previously saved backup using the Backup ID.\n' +
            '`/security_score` - Shows this server\'s current Veri. security score.\n' +
            '`/veri_resend verification|honeypot` - Re-sends the relevant message to its channel.',
          footer: 'Veri. Help - Staff Commands'
        });
      } else if (val === 'security') {
        embed = panelEmbed({
          title: 'Security Features',
          description: 'Toggle any of these features via the `/admin-panel`.',
          fields: [
            { name: 'Captcha Verification', value: 'Sends new members a DM with an image captcha. They must answer correctly to gain access.', inline: false },
            { name: 'Honeypot Channel', value: 'A hidden trap channel. Anyone typing in it gets caught and punished per your honeypot mode setting.', inline: false },
            { name: 'Anti-Token-Logger', value: 'Automatically kicks accounts with no avatar and suspicious age or username pattern.', inline: false },
            { name: 'Join-Age Requirement', value: 'Blocks accounts under a minimum age. The user is DM\'d explaining why and when they can rejoin.', inline: false },
            { name: 'Anti-Raid Cooldown', value: 'Detects rapid joins, locks verification, alerts admins via DM, and enables global ban mode for any honeypot triggers during the lock.', inline: false },
            { name: 'Verification Cooldown', value: 'Prevents spamming the Verify button. Configurable duration per server.', inline: false }
          ],
          footer: 'Veri. Help - Security Features'
        });
      } else if (val === 'quickstart') {
        embed = panelEmbed({
          title: 'Quick Start',
          description:
            '**Step 1** - Invite Veri. with **Administrator** permission.\n\n' +
            '**Step 2** - Move the **Veri.** role to near the **top** of your role list.\n\n' +
            '**Step 3** - Run `/setup` in your server. This creates:\n' +
            '- A **Veri.** category\n' +
            '- A **#verification** channel with the Verify button\n' +
            '- A **#veri-logs** channel\n' +
            '- A **#!DO NOT TYPE HERE!** honeypot channel\n' +
            '- A **Veri. Admin** role\n' +
            '- A **Captcha Verified** role\n\n' +
            '**Step 4** - Customise with `/admin-panel`.\n\n' +
            '**Step 5** - Need help? Join [discord.gg/K6x4qwZCNM](https://discord.gg/K6x4qwZCNM)',
          footer: 'Veri. Help - Quick Start'
        });
      } else if (val === 'stats') {
        embed = panelEmbed({
          title: 'Stats & Monitoring',
          description:
            '**`/ping`** - Real-time latency for WebSocket, API, and MongoDB.\n\n' +
            '**`/uptime`** - Bot uptime, last restart time, RSS memory, heap memory, and CPU load.\n\n' +
            '**`/security_score`** - A 0-100 score based on which features are active, channels present, roles set, etc.\n\n' +
            '**Personal Stats Digest** - Available via `/admin-panel` > My Stats Digest.\nEach staff member can opt in to receive a daily, weekly, or monthly summary of server stats to their DMs.',
          footer: 'Veri. Help - Stats & Monitoring'
        });
      } else {
        return interaction.reply({ embeds: [boxEmbed({ title: 'Veri.', description: 'Unknown category.', footer: 'Veri.' })], ephemeral: true });
      }

      return interaction.reply({ embeds: [embed], ephemeral: true });
    }
  }

  // =========================================================================
  // MODAL SUBMITS
  // =========================================================================
  if (interaction.isModalSubmit()) {
    const id = interaction.customId;

    // Set Roles modal
    if (id === 'ap_set_roles_modal') {
      if (!(await canUseVeriCommands(interaction))) {
        return interaction.reply({ embeds: [boxEmbed({ title: 'Veri.', description: 'You do not have permission.', footer: 'Veri.' })], ephemeral: true });
      }

      const guild = interaction.guild;
      const cfg = await getGuildConfig(guild.id);
      const verifiedRoleInput = interaction.fields.getTextInputValue('verified_role_id').trim();
      const adminRoleInput = interaction.fields.getTextInputValue('admin_role_id').trim();
      const changes = [];

      if (verifiedRoleInput) {
        const role = guild.roles.cache.get(verifiedRoleInput);
        if (!role) {
          return interaction.reply({ embeds: [boxEmbed({ title: 'Veri.', description: `No role found with ID \`${verifiedRoleInput}\`. Make sure you paste the Role ID, not the role name.`, footer: 'Veri.' })], ephemeral: true });
        }
        cfg.verificationRoleId = verifiedRoleInput;
        changes.push(`Verified role set to <@&${verifiedRoleInput}>`);
      }

      if (adminRoleInput) {
        const role = guild.roles.cache.get(adminRoleInput);
        if (!role) {
          return interaction.reply({ embeds: [boxEmbed({ title: 'Veri.', description: `No role found with ID \`${adminRoleInput}\`. Make sure you paste the Role ID, not the role name.`, footer: 'Veri.' })], ephemeral: true });
        }
        cfg.adminRoleId = adminRoleInput;
        changes.push(`Admin role set to <@&${adminRoleInput}>`);
      }

      await saveGuildConfig(cfg);
      await sendLog(guild, 'Veri. Roles Updated', `Roles updated by ${interaction.user.id}: ${changes.join(', ') || 'No changes.'}`);

      await interaction.reply({
        embeds: [boxEmbed({
          title: 'Veri. Roles Updated',
          description: changes.length > 0 ? changes.join('\n') : 'No changes were made (both fields were left blank).',
          footer: 'Veri.'
        })],
        ephemeral: true
      });
      return;
    }

    // Configure Settings modal
    if (id === 'ap_config_settings_modal') {
      if (!(await canUseVeriCommands(interaction))) {
        return interaction.reply({ embeds: [boxEmbed({ title: 'Veri.', description: 'You do not have permission.', footer: 'Veri.' })], ephemeral: true });
      }

      const guild = interaction.guild;
      const cfg = await getGuildConfig(guild.id);
      const changes = [];

      const parsePosInt = (val, fallback) => {
        const n = parseInt(val, 10);
        return (!isNaN(n) && n > 0) ? n : fallback;
      };

      const cooldownInput = interaction.fields.getTextInputValue('verify_cooldown').trim();
      const joinAgeDaysInput = interaction.fields.getTextInputValue('join_age_days').trim();
      const tokenLoggerAgeInput = interaction.fields.getTextInputValue('token_logger_min_age').trim();
      const raidThresholdInput = interaction.fields.getTextInputValue('raid_threshold').trim();
      const raidWindowInput = interaction.fields.getTextInputValue('raid_window').trim();

      if (cooldownInput) {
        const val = parsePosInt(cooldownInput, cfg.verificationCooldownSeconds || 30);
        cfg.verificationCooldownSeconds = val;
        changes.push(`Verification cooldown: ${val}s`);
      }
      if (joinAgeDaysInput) {
        const val = parsePosInt(joinAgeDaysInput, cfg.joinAgeMinDays || 7);
        cfg.joinAgeMinDays = val;
        changes.push(`Join-Age minimum: ${val} days`);
      }
      if (tokenLoggerAgeInput) {
        const val = parsePosInt(tokenLoggerAgeInput, cfg.antiTokenLoggerMinAge || 7);
        cfg.antiTokenLoggerMinAge = val;
        changes.push(`Anti-Token-Logger minimum age: ${val} days`);
      }
      if (raidThresholdInput) {
        const val = parsePosInt(raidThresholdInput, cfg.antiRaidThreshold || 10);
        cfg.antiRaidThreshold = val;
        changes.push(`Anti-Raid threshold: ${val} joins`);
      }
      if (raidWindowInput) {
        const val = parsePosInt(raidWindowInput, cfg.antiRaidWindowSeconds || 30);
        cfg.antiRaidWindowSeconds = val;
        changes.push(`Anti-Raid window: ${val}s`);
      }

      await saveGuildConfig(cfg);
      await sendLog(guild, 'Veri. Settings Updated', `Settings updated by ${interaction.user.id}: ${changes.join(', ') || 'No changes.'}`);

      await interaction.reply({
        embeds: [boxEmbed({
          title: 'Veri. Settings Updated',
          description: changes.length > 0 ? changes.join('\n') : 'No changes were made.',
          footer: 'Veri.'
        })],
        ephemeral: true
      });
      return;
    }

    // Restore backup modal
    if (id === 'restore_backup_modal') {
      if (!(await canUseVeriCommands(interaction))) {
        return interaction.reply({ embeds: [boxEmbed({ title: 'Veri.', description: 'You do not have permission.', footer: 'Veri.' })], ephemeral: true });
      }

      const backupId = interaction.fields.getTextInputValue('backup_id').trim();
      await interaction.deferReply({ ephemeral: true });

      try {
        const backup = await ServerBackup.findById(backupId);
        if (!backup) {
          return interaction.editReply({ embeds: [boxEmbed({ title: 'Veri.', description: `No backup found with ID \`${backupId}\`.`, footer: 'Veri.' })] });
        }

        const guild = interaction.guild;
        if (backup.guildId !== guild.id) {
          return interaction.editReply({ embeds: [boxEmbed({ title: 'Veri.', description: 'This backup does not belong to this server.', footer: 'Veri.' })] });
        }

        const data = backup.data;
        const restored = { roles: 0, channels: 0, categories: 0 };

        for (const roleData of (data.roles || [])) {
          const existing = guild.roles.cache.find(r => r.name === roleData.name);
          if (!existing) {
            try {
              await guild.roles.create({
                name: roleData.name,
                color: roleData.color,
                hoist: roleData.hoist,
                mentionable: roleData.mentionable,
                reason: 'Veri. server restore'
              });
              restored.roles++;
            } catch { /* skip */ }
          }
        }

        const categoryMap = new Map();
        for (const catData of (data.categories || [])) {
          const existing = guild.channels.cache.find(c => c.name === catData.name && c.type === ChannelType.GuildCategory);
          if (!existing) {
            try {
              const newCat = await guild.channels.create({ name: catData.name, type: ChannelType.GuildCategory, reason: 'Veri. server restore' });
              categoryMap.set(catData.id, newCat.id);
              restored.categories++;
            } catch { /* skip */ }
          } else {
            categoryMap.set(catData.id, existing.id);
          }
        }

        for (const chData of (data.channels || [])) {
          const existing = guild.channels.cache.find(c => c.name === chData.name);
          if (!existing) {
            try {
              const parentId = chData.parentId ? (categoryMap.get(chData.parentId) || chData.parentId) : null;
              const opts = { name: chData.name, type: chData.type, reason: 'Veri. server restore' };
              if (parentId) opts.parent = parentId;
              if (chData.topic) opts.topic = chData.topic;
              await guild.channels.create(opts);
              restored.channels++;
            } catch { /* skip */ }
          }
        }

        const embed = panelEmbed({
          title: 'Server Restore Complete',
          description: `Restore from backup \`${backupId}\` completed for **${guild.name}**.`,
          fields: [
            { name: 'Roles Restored', value: `\`${restored.roles}\``, inline: true },
            { name: 'Categories Restored', value: `\`${restored.categories}\``, inline: true },
            { name: 'Channels Restored', value: `\`${restored.channels}\``, inline: true }
          ],
          footer: 'Veri. Restore - Only missing items were recreated'
        });

        await interaction.editReply({ embeds: [embed] });
        await sendLog(guild, 'Veri. Server Restore', `Restore run by ${interaction.user.id} from backup ${backupId}. Roles: ${restored.roles}, Channels: ${restored.channels}, Categories: ${restored.categories}`);
      } catch (e) {
        console.error('Restore error:', e);
        await interaction.editReply({ embeds: [boxEmbed({ title: 'Veri.', description: `Restore failed: ${e.message}`, footer: 'Veri.' })] });
      }
      return;
    }

    // Digest setup modal
    if (id === 'ap_digest_modal') {
      if (!(await canUseVeriCommands(interaction))) {
        return interaction.reply({ embeds: [boxEmbed({ title: 'Veri.', description: 'You do not have permission.', footer: 'Veri.' })], ephemeral: true });
      }

      const raw = interaction.fields.getTextInputValue('frequency').trim().toLowerCase();
      const valid = ['daily', 'weekly', 'monthly'];
      if (!valid.includes(raw)) {
        return interaction.reply({ embeds: [boxEmbed({ title: 'Veri.', description: 'Invalid frequency. Please type: `daily`, `weekly`, or `monthly`.', footer: 'Veri.' })], ephemeral: true });
      }

      const guild = interaction.guild;
      await StatsDigest.findOneAndUpdate(
        { userId: interaction.user.id, guildId: guild.id },
        { frequency: raw, enabled: true, lastSent: null },
        { upsert: true }
      );

      return interaction.reply({
        embeds: [panelEmbed({
          title: 'Stats Digest Enabled',
          description: `You will now receive a **${raw}** stats digest for **${guild.name}** in your DMs.\n\nYour first digest will arrive within the next digest check cycle.\n\nTo cancel, run \`/admin-panel\` > My Stats Digest and type \`cancel\`.`,
          footer: 'Veri. Stats Digest'
        })],
        ephemeral: true
      });
    }

    // Staff modal submits
    if (id.startsWith('vs_')) {
      if (interaction.user.id !== OWNER_ID) {
        return interaction.reply({ embeds: [boxEmbed({ title: 'Veri.', description: 'ERROR: Only official Veri. staff can run this.', footer: 'Veri.' })], ephemeral: true });
      }

      const dm = await interaction.user.createDM().catch(() => null);
      if (!dm) {
        return interaction.reply({ embeds: [boxEmbed({ title: 'Veri.', description: 'Veri. could not send you a DM.', footer: 'Veri.' })], ephemeral: true });
      }

      if (id === 'vs_remove_bot_server_modal') {
        const serverId = interaction.fields.getTextInputValue('server_id').trim();
        const targetGuild = client.guilds.cache.get(serverId) || (await client.guilds.fetch(serverId).catch(() => null));
        if (!targetGuild) {
          await dm.send({ embeds: [boxEmbed({ title: 'Veri. Staff - Remove Bot From Server', description: `Veri. is not in server ID ${serverId}.`, footer: 'Veri.' })] });
          return interaction.reply({ embeds: [boxEmbed({ title: 'Veri.', description: 'Result sent to your DMs.', footer: 'Veri.' })], ephemeral: false });
        }
        await dm.send({ embeds: [boxEmbed({ title: 'Veri. Staff - Remove Bot From Server', description: `Veri. will leave server ID ${targetGuild.id} (${targetGuild.name}).`, footer: 'Veri.' })] });
        await interaction.reply({ embeds: [boxEmbed({ title: 'Veri.', description: 'Veri. is leaving the specified server.', footer: 'Veri.' })], ephemeral: false });
        setTimeout(() => { targetGuild.leave().catch(() => {}); }, 2000);
        return;
      }

      if (id === 'vs_restore_db_modal') {
        const raw = interaction.fields.getTextInputValue('db_json');
        const trimmed = raw.trim();
        if (!trimmed.toLowerCase().startsWith('restore')) {
          return interaction.reply({ embeds: [boxEmbed({ title: 'Veri.', description: 'Database restore cancelled (did not start with "RESTORE").', footer: 'Veri.' })], ephemeral: true });
        }
        const jsonPart = trimmed.slice('restore'.length).trim();
        if (!jsonPart) {
          return interaction.reply({ embeds: [boxEmbed({ title: 'Veri.', description: 'No JSON content provided after "RESTORE".', footer: 'Veri.' })], ephemeral: true });
        }
        try {
          await restoreDataFromJson(jsonPart);
          await dm.send({ embeds: [boxEmbed({ title: 'Veri. Staff - Database Restore', description: 'Database has been restored from the provided JSON.', footer: 'Veri.' })] });
          return interaction.reply({ embeds: [boxEmbed({ title: 'Veri.', description: 'Database restore completed.', footer: 'Veri.' })], ephemeral: false });
        } catch (e) {
          return interaction.reply({ embeds: [boxEmbed({ title: 'Veri.', description: `Database restore failed: ${e.message}`, footer: 'Veri.' })], ephemeral: true });
        }
      }

      if (id.startsWith('vs_guild_') && id.endsWith('_system_modal')) {
        const withoutPrefix = id.slice('vs_guild_'.length);
        const guildId = withoutPrefix.slice(0, withoutPrefix.length - '_system_modal'.length);
        const targetGuild = client.guilds.cache.get(guildId) || (await client.guilds.fetch(guildId).catch(() => null));
        if (!targetGuild) {
          return interaction.reply({ embeds: [boxEmbed({ title: 'Veri.', description: `Guild ${guildId} no longer available.`, footer: 'Veri.' })], ephemeral: true });
        }
        const value = interaction.fields.getTextInputValue('dummy').trim().toLowerCase();
        if (value !== 'run') {
          return interaction.reply({ embeds: [boxEmbed({ title: 'Veri.', description: 'System tools cancelled (you did not type "run").', footer: 'Veri.' })], ephemeral: true });
        }
        const cfg = await getGuildConfig(targetGuild.id);
        const totalGuilds = await GuildConfig.countDocuments();
        const totalUsers = await VerifiedUser.countDocuments();
        const blacklistSize = await Blacklist.countDocuments();
        const mem = process.memoryUsage();
        const lines = [
          'System Tools Summary', '',
          `Node.js: ${process.version}`,
          `Platform: ${process.platform}`,
          `Uptime: ${formatUptime(Date.now() - BOT_START_TIME)}`,
          `CPU Load: ${getCpuLoad()}`,
          `Memory (RSS): ${formatBytes(mem.rss)}`,
          `Heap Used: ${formatBytes(mem.heapUsed)} / ${formatBytes(mem.heapTotal)}`,
          `Shard: ${client.shard ? `${client.shard.ids.join(',')}` : 'None (no sharding)'}`,
          '',
          'Database Stats',
          `Guilds tracked: ${totalGuilds}`,
          `Verified users: ${totalUsers}`,
          `Global blacklist: ${blacklistSize}`,
          '',
          'Selected Guild',
          `ID: ${targetGuild.id}`, `Name: ${targetGuild.name}`,
          `Category: ${cfg.categoryId || 'None'}`,
          `Verification channel: ${cfg.verificationChannelId || 'None'}`,
          `Logs channel: ${cfg.logsChannelId || 'None'}`,
          `Honeypot channel: ${cfg.honeypotChannelId || 'None'}`,
          `Verify role: ${cfg.verificationRoleId || 'None'}`,
          `Admin role: ${cfg.adminRoleId || 'None'}`,
          `Captcha: ${cfg.captchaEnabled ? 'Yes' : 'No'}`,
          `Honeypot: ${cfg.honeypotEnabled ? 'Yes' : 'No'}`,
          `Anti-Token-Logger: ${cfg.antiTokenLoggerEnabled ? 'Yes' : 'No'}`,
          `Join-Age: ${cfg.joinAgeEnabled ? 'Yes' : 'No'} (min ${cfg.joinAgeMinDays || 7} days)`,
          `Anti-Raid: ${cfg.antiRaidEnabled ? 'Yes' : 'No'}`,
          `Raid Locked: ${cfg.raidLocked ? 'Yes' : 'No'}`,
          `Verify Cooldown: ${cfg.verificationCooldownSeconds || 30}s`
        ];
        await dm.send({ embeds: [boxEmbed({ title: 'Veri. Staff - System Tools', description: lines.join('\n'), footer: 'Veri.' })] });
        return interaction.reply({ embeds: [boxEmbed({ title: 'Veri.', description: 'System tools summary sent to your DMs.', footer: 'Veri.' })], ephemeral: false });
      }

      if (id === 'vs_remove_server_id_modal') {
        const serverId = interaction.fields.getTextInputValue('server_id').trim();
        await GuildConfig.deleteOne({ guildId: serverId });
        await dm.send({ embeds: [boxEmbed({ title: 'Veri. Staff - Remove Server Data by ID', description: `Data for server ID ${serverId} removed.`, footer: 'Veri.' })] });
        return interaction.reply({ embeds: [boxEmbed({ title: 'Veri.', description: 'Server data removal details sent to your DMs.', footer: 'Veri.' })], ephemeral: false });
      }

      if (id === 'vs_force_verify_modal') {
        const guild = interaction.guild;
        const userId = interaction.fields.getTextInputValue('user_id').trim();
        const cfg = await getGuildConfig(guild.id);

        let role = cfg.verificationRoleId ? guild.roles.cache.get(cfg.verificationRoleId) : null;
        if (!role) {
          role =
            guild.roles.cache.find(r => r.name === 'Captcha Verified') ||
            (await guild.roles.create({ name: 'Captcha Verified', reason: 'Veri. verification role' }));
          cfg.verificationRoleId = role.id;
          await saveGuildConfig(cfg);
        }

        const member = await guild.members.fetch(userId).catch(() => null);
        if (member && role) await member.roles.add(role).catch(() => {});

        const now = Date.now();
        await VerifiedUser.findOneAndUpdate(
          { userId },
          { $setOnInsert: { firstVerified: now }, $set: { lastVerification: now }, $addToSet: { servers: guild.id } },
          { upsert: true }
        );

        await dm.send({ embeds: [boxEmbed({ title: 'Veri. Staff - Force Verify User', description: `User ID ${userId} force-verified in server ${guild.id}.`, footer: 'Veri.' })] });
        return interaction.reply({ embeds: [boxEmbed({ title: 'Veri.', description: 'Force verify details sent to your DMs.', footer: 'Veri.' })], ephemeral: false });
      }

      if (id === 'vs_reset_user_modal') {
        const userId = interaction.fields.getTextInputValue('user_id').trim();
        await VerifiedUser.deleteOne({ userId });
        await dm.send({ embeds: [boxEmbed({ title: 'Veri. Staff - Reset User', description: `Veri. record for user ID ${userId} reset.`, footer: 'Veri.' })] });
        return interaction.reply({ embeds: [boxEmbed({ title: 'Veri.', description: 'User reset details sent to your DMs.', footer: 'Veri.' })], ephemeral: false });
      }

      if (id === 'vs_clear_honeypot_modal') {
        const userId = interaction.fields.getTextInputValue('user_id').trim();
        await VerifiedUser.updateOne({ userId }, { $set: { honeypotTriggers: 0 } }, { upsert: true });
        await dm.send({ embeds: [boxEmbed({ title: 'Veri. Staff - Clear Honeypot Triggers', description: `Honeypot triggers for user ID ${userId} cleared.`, footer: 'Veri.' })] });
        return interaction.reply({ embeds: [boxEmbed({ title: 'Veri.', description: 'Honeypot clear details sent to your DMs.', footer: 'Veri.' })], ephemeral: false });
      }

      if (id === 'vs_clear_fails_modal') {
        const userId = interaction.fields.getTextInputValue('user_id').trim();
        await VerifiedUser.updateOne({ userId }, { $set: { fails: 0 } }, { upsert: true });
        await dm.send({ embeds: [boxEmbed({ title: 'Veri. Staff - Clear Captcha Fails', description: `Captcha fails for user ID ${userId} cleared.`, footer: 'Veri.' })] });
        return interaction.reply({ embeds: [boxEmbed({ title: 'Veri.', description: 'Captcha fail clear details sent to your DMs.', footer: 'Veri.' })], ephemeral: false });
      }

      if (id === 'vs_remove_blacklist_modal') {
        const userId = interaction.fields.getTextInputValue('user_id').trim();
        const wasBlacklisted = await isBlacklisted(userId);
        await removeFromBlacklist(userId);
        await dm.send({
          embeds: [boxEmbed({
            title: 'Veri. Staff - Remove From Blacklist',
            description: wasBlacklisted
              ? `User ID ${userId} removed from global blacklist.`
              : `User ID ${userId} was not on the blacklist.`,
            footer: 'Veri.'
          })]
        });
        return interaction.reply({ embeds: [boxEmbed({ title: 'Veri.', description: 'Blacklist removal details sent to your DMs.', footer: 'Veri.' })], ephemeral: false });
      }

      if (id === 'vs_system_tools_modal') {
        const guild = interaction.guild;
        const value = interaction.fields.getTextInputValue('dummy').trim().toLowerCase();
        if (value !== 'run') {
          return interaction.reply({ embeds: [boxEmbed({ title: 'Veri.', description: 'System tools cancelled (you did not type "run").', footer: 'Veri.' })], ephemeral: true });
        }
        const totalGuilds = await GuildConfig.countDocuments();
        const totalUsers = await VerifiedUser.countDocuments();
        const blacklistSize = await Blacklist.countDocuments();
        const mem = process.memoryUsage();
        const lines = [
          'System Tools Summary', '',
          `Node.js: ${process.version}`,
          `Platform: ${process.platform}`,
          `Uptime: ${formatUptime(Date.now() - BOT_START_TIME)}`,
          `CPU Load: ${getCpuLoad()}`,
          `Memory (RSS): ${formatBytes(mem.rss)}`,
          `Heap Used: ${formatBytes(mem.heapUsed)} / ${formatBytes(mem.heapTotal)}`,
          `Shard: ${client.shard ? `${client.shard.ids.join(',')}` : 'None (no sharding)'}`,
          '',
          'Database Stats',
          `Guilds tracked: ${totalGuilds}`,
          `Verified users: ${totalUsers}`,
          `Global blacklist: ${blacklistSize}`
        ];
        if (guild) {
          const cfg = await getGuildConfig(guild.id);
          lines.push(
            '', 'Current Guild',
            `ID: ${guild.id}`, `Name: ${guild.name}`,
            `Captcha: ${cfg.captchaEnabled ? 'Yes' : 'No'}`,
            `Honeypot: ${cfg.honeypotEnabled ? 'Yes' : 'No'}`,
            `Anti-Token-Logger: ${cfg.antiTokenLoggerEnabled ? 'Yes' : 'No'}`,
            `Join-Age: ${cfg.joinAgeEnabled ? 'Yes' : 'No'}`,
            `Anti-Raid: ${cfg.antiRaidEnabled ? 'Yes' : 'No'}`,
            `Raid Locked: ${cfg.raidLocked ? 'Yes' : 'No'}`
          );
        }
        await dm.send({ embeds: [boxEmbed({ title: 'Veri. Staff - System Tools', description: lines.join('\n'), footer: 'Veri.' })] });
        return interaction.reply({ embeds: [boxEmbed({ title: 'Veri.', description: 'System tools summary sent to your DMs.', footer: 'Veri.' })], ephemeral: false });
      }
    }
  }

  } catch (err) {
    console.error('Interaction error:', err);
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply('An error occurred.').catch(() => {});
    } else {
      await interaction.reply({ content: 'An error occurred.', ephemeral: true }).catch(() => {});
    }
  }
});

// ---------------------------------------------------------------------------
// MESSAGES: DM captcha answers + honeypot detection
// ---------------------------------------------------------------------------
client.on('messageCreate', async message => {

  // DM captcha answers
  if (!message.guild && !message.author.bot) {
    const session = captchaSessions.get(message.author.id);
    if (!session) return;

    const content = message.content.trim();
    if (content.length === 0) {
      return message.channel.send({ embeds: [boxEmbed({ title: 'Veri.', description: 'Please reply with a number only.', footer: 'Veri.' })] });
    }

    const num = Number(content);
    if (!Number.isInteger(num)) {
      return message.channel.send({ embeds: [boxEmbed({ title: 'Veri.', description: 'Please reply with a number only.', footer: 'Veri.' })] });
    }

    const guild = client.guilds.cache.get(session.guildId);
    if (!guild) {
      captchaSessions.delete(message.author.id);
      return message.channel.send({ embeds: [boxEmbed({ title: 'Veri.', description: 'The server you were verifying for is no longer available.', footer: 'Veri.' })] });
    }

    const cfg = await getGuildConfig(guild.id);

    if (!cfg.captchaEnabled) {
      captchaSessions.delete(message.author.id);
      return message.channel.send({ embeds: [boxEmbed({ title: 'Veri.', description: 'Verification has been disabled on that server. You no longer need to verify.', footer: 'Veri.' })] });
    }

    if (num === session.answer) {
      const existingRecord = await VerifiedUser.findOne({ userId: message.author.id });
      if (existingRecord?.firstVerified && existingRecord.servers.includes(guild.id)) {
        captchaSessions.delete(message.author.id);
        return message.channel.send({ embeds: [boxEmbed({ title: 'Veri.', description: 'You are already verified in this server.', footer: 'Veri.' })] });
      }

      const now = Date.now();
      await VerifiedUser.findOneAndUpdate(
        { userId: message.author.id },
        { $setOnInsert: { firstVerified: now }, $set: { lastVerification: now }, $addToSet: { servers: guild.id } },
        { upsert: true }
      );

      guild.channels.cache.forEach(channel => {
        if (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildVoice) return;
        channel.permissionOverwrites.delete(message.author.id).catch(() => {});
      });

      let role = cfg.verificationRoleId ? guild.roles.cache.get(cfg.verificationRoleId) : null;
      if (!role) {
        role =
          guild.roles.cache.find(r => r.name === 'Captcha Verified') ||
          (await guild.roles.create({ name: 'Captcha Verified', reason: 'Veri. verification role' }));
        cfg.verificationRoleId = role.id;
        await saveGuildConfig(cfg);
      }

      const member = await guild.members.fetch(message.author.id).catch(() => null);
      if (member && role) member.roles.add(role).catch(() => {});

      await message.channel.send({ embeds: [boxEmbed({ title: 'Veri.', description: 'You answered correctly and have been verified in the server.', footer: 'Veri.' })] });
      await sendLog(guild, 'Veri. Verification Passed', `User ${message.author.id} passed verification via DM.`);
      captchaSessions.delete(message.author.id);
      return;

    } else {
      await VerifiedUser.findOneAndUpdate(
        { userId: message.author.id },
        { $inc: { fails: 1 } },
        { upsert: true }
      );

      await sendLog(guild, 'Veri. Verification Failed', `User ${message.author.id} failed a verification attempt via DM.`);

      const { file, answer } = getRandomCaptcha();
      captchaSessions.set(message.author.id, { answer, guildId: session.guildId });

      return message.channel.send({
        embeds: [boxEmbed({ title: 'Veri.', description: 'You failed the captcha. Try again.\nHere is a new captcha image.', footer: 'Veri.' })],
        files: [path.join(__dirname, file)]
      });
    }
  }

  // Guild messages
  if (!message.guild || message.author.bot) return;

  const guild = message.guild;
  const cfg = await getGuildConfig(guild.id);

  // Honeypot detection
  if (
    cfg.honeypotEnabled &&
    cfg.honeypotChannelId &&
    message.channel.id === cfg.honeypotChannelId &&
    guild.channels.cache.has(cfg.honeypotChannelId)
  ) {
    // Server owner gets a DM warning, not punishment
    if (message.author.id === guild.ownerId) {
      try {
        await message.delete().catch(() => {});
        const dm = await message.author.createDM().catch(() => null);
        if (dm) {
          await dm.send({
            embeds: [boxEmbed({
              title: 'Veri. - Honeypot Warning',
              description:
                `Hey! You just typed in the honeypot channel in **${guild.name}**.\n\n` +
                'As server owner, you are exempt from punishment - but please be aware: **this channel is a trap for bots and malicious users.**\n\n' +
                'If you meant to delete this channel, use Discord\'s channel settings.',
              footer: 'Veri. Honeypot'
            })]
          }).catch(() => {});
        }
      } catch { /* ignore */ }
      return;
    }

    // Bot owner is also immune
    if (message.author.id === OWNER_ID) return;

    await VerifiedUser.findOneAndUpdate(
      { userId: message.author.id },
      { $inc: { honeypotTriggers: 1 } },
      { upsert: true }
    );

    await sendLog(guild, 'Veri. Honeypot Triggered', `User ${message.author.id} sent a message in the honeypot channel.`);
    await message.delete().catch(() => {});

    const dm = await message.author.createDM().catch(() => null);
    if (dm) {
      await dm.send({
        embeds: [boxEmbed({
          title: 'Veri.',
          description:
            'You typed in a Veri. honeypot channel.\n' +
            'This channel exists solely to catch spam bots and malicious users.\n\n' +
            'If this was accidental, visit our website and email Veri. staff for assistance.',
          footer: 'Veri.'
        })]
      }).catch(() => {});
    }

    const member = await guild.members.fetch(message.author.id).catch(() => null);
    // If server is raid locked, always global ban any honeypot triggers
    const mode = cfg.raidLocked ? 'global_ban' : (cfg.honeypotMode || 'global_ban');

    if (mode === 'global_ban') {
      await addToBlacklist(message.author.id);
      if (member) await member.ban({ reason: 'Veri. honeypot trigger (global ban)' }).catch(() => {});
    } else if (mode === 'server_ban') {
      if (member) await member.ban({ reason: 'Veri. honeypot trigger (server ban)' }).catch(() => {});
    } else if (mode === 'kick') {
      if (member) await member.kick('Veri. honeypot trigger (kick)').catch(() => {});
    }
    // warn and dm_only modes: DM already sent above, no further action

    return;
  }
});

// ---------------------------------------------------------------------------
// CONNECT TO MONGODB, THEN START THE BOT
// ---------------------------------------------------------------------------

// Register slash commands + connect DB + start bot
(async () => {
  try {
    await mongoose.connect(MONGO_URI);
    console.log('MongoDB connected.');

    await registerCommands();
    console.log('Slash commands registered.');

    await client.login(BOT_TOKEN);
  } catch (err) {
    console.error('Startup error:', err);
    process.exit(1);
  }
})();
