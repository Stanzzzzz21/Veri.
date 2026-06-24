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
  Collection
} from 'discord.js';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_PATH = path.join(__dirname, 'veri-data.json');
const DATA_BACKUP_PATH = path.join(__dirname, 'veri-data-backup.json');

const BOT_TOKEN = process.env.BOT_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const PORT = process.env.PORT || 3000;

// master ID
const OWNER_ID = '876731494805155851';

// verification banner
const VERIFICATION_BANNER_URL = 'https://i.postimg.cc/SKrVKYhT/Verify-msg-banner.png';

if (!BOT_TOKEN || !CLIENT_ID) {
  console.error('BOT_TOKEN and CLIENT_ID must be set as environment variables.');
  process.exit(1);
}

// keep-alive HTTP server
http
  .createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Veri. is running\n');
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
          guilds: {},
          blacklist: []
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

function backupData() {
  if (fs.existsSync(DATA_PATH)) {
    fs.copyFileSync(DATA_PATH, DATA_BACKUP_PATH);
  }
}

function restoreDataFromJson(jsonString) {
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
  backupData();
  fs.writeFileSync(DATA_PATH, JSON.stringify(parsed, null, 2));
  data = parsed;
}

// guild config
function getGuildConfig(guildId) {
  if (!data.guilds[guildId]) {
    data.guilds[guildId] = {
      verificationChannelId: null,
      logsChannelId: null,
      honeypotChannelId: null,
      categoryId: null,
      verificationRoleId: null,
      adminRoleId: null,
      captchaEnabled: true,
      honeypotEnabled: true,
      honeypotMode: 'global_ban',
      setupComplete: false
    };
    saveData(data);
  }
  // ensure categoryId field exists for older configs
  if (!('categoryId' in data.guilds[guildId])) {
    data.guilds[guildId].categoryId = null;
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

function isBlacklisted(userId) {
  return Array.isArray(data.blacklist) && data.blacklist.includes(userId);
}

function addToBlacklist(userId) {
  if (!Array.isArray(data.blacklist)) data.blacklist = [];
  if (!data.blacklist.includes(userId)) {
    data.blacklist.push(userId);
    saveData(data);
  }
}

function removeFromBlacklist(userId) {
  if (!Array.isArray(data.blacklist)) data.blacklist = [];
  data.blacklist = data.blacklist.filter(id => id !== userId);
  saveData(data);
}

// theme
const THEME_COLOR = 0x00c853;

// boxed embed helper
function boxEmbed({ title, description, fields = [], footer }) {
  const embed = new EmbedBuilder()
    .setColor(THEME_COLOR)
    .setTitle(title || 'Veri.')
    .setDescription(description || '');

  if (fields.length > 0) embed.addFields(fields);
  embed.setFooter({ text: footer || 'Veri.' });

  return embed;
}

// captcha files + answers
const captchaFiles = [
  'a.png.png',
  'b.png.png',
  'c.png.png',
  'd.png.png',
  'e.png.png',
  'f.png.png',
  'g.png.png',
  'h.png.png',
  'i.png.png',
  'j.png.png',
  'k.png.png',
  'l.png.png',
  'm.png.png',
  'n.png.png',
  'o.png.png'
];

const captchaAnswers = {
  'a.png.png': 2,
  'b.png.png': 8,
  'c.png.png': 2,
  'd.png.png': 3,
  'e.png.png': 7,
  'f.png.png': 4,
  'g.png.png': 5,
  'h.png.png': 5,
  'i.png.png': 7,
  'j.png.png': 5,
  'k.png.png': 5,
  'l.png.png': 9,
  'm.png.png': 6,
  'n.png.png': 8,
  'o.png.png': 1
};

function getRandomCaptcha() {
  const file = captchaFiles[Math.floor(Math.random() * captchaFiles.length)];
  const answer = captchaAnswers[file];
  return { file, answer };
}

// in-memory captcha sessions: userId -> { answer, guildId }
const captchaSessions = new Map();

// discord client
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

// ---------------------------------------------------------------------------
// SLASH COMMANDS
// Admin-only commands use setDefaultMemberPermissions(0) which hides them
// from everyone in the slash command picker unless the server admin explicitly
// grants them to a role. This means regular members NEVER see setup, settings,
// veri_staff, security_score, or veri_resend.
// player info stays visible to all (no permission restriction).
// ---------------------------------------------------------------------------

const setupCommand = new SlashCommandBuilder()
  .setName('setup')
  .setDescription('Initial setup for Veri.')
   // hidden from non-admins

const settingsCommand = new SlashCommandBuilder()
  .setName('settings')
  .setDescription('Configure Veri. settings.')
   // hidden from non-admins
  .addBooleanOption(opt =>
    opt
      .setName('captcha_enabled')
      .setDescription('Enable or disable captcha. Turning off deletes the verification channel; on recreates it.')
  )
  .addBooleanOption(opt =>
    opt
      .setName('honeypot_enabled')
      .setDescription('Enable or disable honeypot. Turning off deletes the honeypot channel; on recreates it.')
  )
  .addStringOption(opt =>
    opt
      .setName('honeypot_mode')
      .setDescription('Set honeypot punishment mode.')
      .addChoices(
        { name: 'Global Ban (default)', value: 'global_ban' },
        { name: 'Server Ban Only', value: 'server_ban' },
        { name: 'Kick Only', value: 'kick' },
        { name: 'Warn Only', value: 'warn' },
        { name: 'DM Warning Only', value: 'dm_only' }
      )
  )
  .addRoleOption(opt =>
    opt
      .setName('verification_role')
      .setDescription('Role to give when verified.')
  );

// player info - no permission restriction so everyone can see it
const playerInfoCommand = new SlashCommandBuilder()
  .setName('player')
  .setDescription('Look up Veri. info for a user.')
  .addSubcommand(sub =>
    sub
      .setName('info')
      .setDescription('Show Veri. info for a user id.')
      .addStringOption(opt =>
        opt
          .setName('user_id')
          .setDescription('User ID to inspect.')
          .setRequired(true)
      )
  );

const staffCommand = new SlashCommandBuilder()
  .setName('veri_staff')
  .setDescription('Veri. Staff control panel (owner only).')
   // hidden from non-admins

const securityScoreCommand = new SlashCommandBuilder()
  .setName('security_score')
  .setDescription('Show this server\'s Veri. security score.')
   // hidden from non-admins

const resendCommand = new SlashCommandBuilder()
  .setName('veri_resend')
  .setDescription('Resend Veri. verification or honeypot messages.')
   // hidden from non-admins
  .addStringOption(opt =>
    opt
      .setName('type')
      .setDescription('Which message to resend.')
      .setRequired(true)
      .addChoices(
        { name: 'Verification', value: 'verification' },
        { name: 'Honeypot', value: 'honeypot' }
      )
  );

// register
client.commands.set('setup', { data: setupCommand });
client.commands.set('settings', { data: settingsCommand });
client.commands.set('player', { data: playerInfoCommand });
client.commands.set('veri_staff', { data: staffCommand });
client.commands.set('security_score', { data: securityScoreCommand });
client.commands.set('veri_resend', { data: resendCommand });

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);
  const commands = [
    setupCommand.toJSON(),
    settingsCommand.toJSON(),
    playerInfoCommand.toJSON(),
    staffCommand.toJSON(),
    securityScoreCommand.toJSON(),
    resendCommand.toJSON()
  ];
  await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
  console.log('Slash commands registered for Veri.');
}

// ---------------------------------------------------------------------------
// HELPER: build and send the verification embed with button
// ---------------------------------------------------------------------------
async function sendVerificationMessage(channel) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('veri_start')
      .setLabel('Verify')
      .setStyle(ButtonStyle.Success)
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
// HELPER: build and send the honeypot warning embed
// ---------------------------------------------------------------------------
async function sendHoneypotMessage(channel) {
  const honeypotEmbed = boxEmbed({
    title: 'DO NOT TYPE HERE',
    description:
      'This channel is a Veri. honeypot.\n' +
      'Any message sent here will result in an immediate punishment based on this server\'s Veri. configuration.\n' +
      'There are no conversations here, no support here, and no reason to type here.\n\n' +
      'If you are reading this, close this channel and do not interact with it.',
    footer: 'Veri.'
  });
  await channel.send({ embeds: [honeypotEmbed] });
}

// ---------------------------------------------------------------------------
// HELPER: get or create the Veri. category in a guild
// ---------------------------------------------------------------------------
async function getOrCreateVeriCategory(guild, cfg) {
  // try stored category id first
  if (cfg.categoryId) {
    const existing = guild.channels.cache.get(cfg.categoryId);
    if (existing && existing.type === ChannelType.GuildCategory) return existing;
  }
  // try to find by name
  const byName = guild.channels.cache.find(
    ch => ch.name === 'Veri.' && ch.type === ChannelType.GuildCategory
  );
  if (byName) {
    cfg.categoryId = byName.id;
    saveData(data);
    return byName;
  }
  // create it
  const category = await guild.channels.create({
    name: 'Veri.',
    type: ChannelType.GuildCategory,
    reason: 'Veri. setup: channel category'
  });
  cfg.categoryId = category.id;
  saveData(data);
  return category;
}

// log helper
async function sendLog(guild, title, description) {
  const cfg = getGuildConfig(guild.id);
  if (!cfg.logsChannelId) return;
  const channel = guild.channels.cache.get(cfg.logsChannelId);
  if (!channel) return;

  const embed = boxEmbed({ title, description, footer: 'Veri.' });
  channel.send({ embeds: [embed] }).catch(() => {});
}

// ready
client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag} (Veri.)`);

  try {
    await registerCommands();
  } catch (e) {
    console.error('Failed to register commands for Veri.:', e);
  }

  // -------------------------------
  // GLOBAL VERIFICATION AUTO-REPAIR
  // -------------------------------
  for (const [guildId, guild] of client.guilds.cache) {
    try {
      await guild.members.fetch(); // load all members

      const guildSettings = data.guilds[guildId] || {};

      // 1. Try custom verification role from settings
      let verificationRole = null;

      if (guildSettings.verificationRoleId) {
        verificationRole = guild.roles.cache.get(guildSettings.verificationRoleId);
      }

      // 2. Fallback to "Captcha Verified"
      if (!verificationRole) {
        verificationRole = guild.roles.cache.find(r => r.name === "Captcha Verified");
      }

      if (!verificationRole) {
        console.log(`No verification role found in guild ${guild.name}. Skipping.`);
        continue;
      }

      // 3. Rebuild verifiedUsers for this guild
      guild.members.cache.forEach(member => {
        if (member.roles.cache.has(verificationRole.id)) {

          if (!data.verifiedUsers[member.id]) {
            data.verifiedUsers[member.id] = {
              firstVerified: Date.now(),
              servers: [],
              fails: 0,
              honeypotTriggers: 0,
              lastVerification: Date.now()
            };
          }

          if (!data.verifiedUsers[member.id].servers.includes(guildId)) {
            data.verifiedUsers[member.id].servers.push(guildId);
          }
        }
      });

      console.log(`Repaired verified users for guild: ${guild.name}`);

    } catch (err) {
      console.log(`Error repairing guild ${guildId}:`, err);
    }
  }

  // Save database after all guilds processed
  saveData(data);
  console.log("Global verification repair complete.");
});


// guild join: welcome message
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
    setTimeout(() => {
      msg.delete().catch(() => {});
    }, 5 * 60 * 1000);
  } catch {
    // ignore
  }
});

// master immunity
client.on('guildBanAdd', async ban => {
  try {
    if (ban.user.id === OWNER_ID) {
      await ban.guild.members.unban(OWNER_ID, 'Veri. owner immunity');
    }
  } catch {
    // ignore
  }
});

// clean up any pending captcha session if a member leaves before finishing
client.on('guildMemberRemove', member => {
  if (captchaSessions.has(member.id)) {
    const session = captchaSessions.get(member.id);
    if (session.guildId === member.guild.id) {
      captchaSessions.delete(member.id);
    }
  }
});

// per-user lockdown + global blacklist auto-ban
client.on('guildMemberAdd', async member => {
  if (member.user.bot) return;

  const guild = member.guild;
  const cfg = getGuildConfig(guild.id);

  // Always check global blacklist regardless of captcha setting
  if (isBlacklisted(member.id) && member.id !== OWNER_ID) {
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
      await sendLog(
        guild,
        'Veri. Global Ban',
        `User ${member.id} was auto-banned on join due to Veri. global blacklist.`
      );
    } catch {
      // ignore
    }
    return;
  }

  // If captcha is disabled, do not lock the member out of anything.
  // They get full access on join like a normal server.
  if (!cfg.captchaEnabled) {
    await sendLog(
      guild,
      'Veri. Member Joined',
      `New member ${member.id} joined. Captcha is disabled so no lockdown was applied.`
    );
    return;
  }

  // If this member already verified in this server before (e.g. they left and
  // rejoined), do not re-lock them. Give them the verified role back instead.
  const existingRecord = data.verifiedUsers[member.id];
  if (existingRecord && existingRecord.firstVerified && existingRecord.servers.includes(guild.id)) {
    let role = cfg.verificationRoleId ? guild.roles.cache.get(cfg.verificationRoleId) : null;
    if (role) {
      await member.roles.add(role).catch(() => {});
    }
    await sendLog(
      guild,
      'Veri. Returning Member',
      `Member ${member.id} rejoined and was already verified. Lockdown skipped, role restored.`
    );
    return;
  }

  // Captcha is enabled — lock member to verification channel only.
  // Only resolve the honeypot channel if honeypot is actually enabled.
  const verificationChannel = cfg.verificationChannelId
    ? guild.channels.cache.get(cfg.verificationChannelId)
    : guild.channels.cache.find(
        ch => ch.name === 'verification' && ch.type === ChannelType.GuildText
      );

  const honeypotChannel =
    cfg.honeypotEnabled && cfg.honeypotChannelId
      ? guild.channels.cache.get(cfg.honeypotChannelId)
      : cfg.honeypotEnabled
        ? guild.channels.cache.find(
            ch => ch.name === '!DO NOT TYPE HERE!' && ch.type === ChannelType.GuildText
          )
        : null;

  guild.channels.cache.forEach(channel => {
    if (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildVoice) return;

    if (
      (verificationChannel && channel.id === verificationChannel.id) ||
      (honeypotChannel && channel.id === honeypotChannel.id)
    ) {
      channel.permissionOverwrites
        .edit(member.id, { ViewChannel: true })
        .catch(() => {});
    } else {
      channel.permissionOverwrites
        .edit(member.id, { ViewChannel: false })
        .catch(() => {});
    }
  });

  await sendLog(
    guild,
    'Veri. Lockdown',
    `New member ${member.id} was locked to verification${honeypotChannel ? ' and honeypot' : ''} channel only.`
  );
});

// permission check
function canUseVeriCommands(interaction) {
  const guild = interaction.guild;
  if (!guild) return false;
  const cfg = getGuildConfig(guild.id);
  const member = interaction.member;

  if (interaction.user.id === OWNER_ID) return true;
  if (guild.ownerId === interaction.user.id) return true;
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  if (cfg.adminRoleId && member.roles.cache.has(cfg.adminRoleId)) return true;

  return false;
}

// compute server security score
function computeSecurityScore(guild) {
  const cfg = getGuildConfig(guild.id);
  let score = 0;
  const max = 100;

  if (cfg.captchaEnabled) score += 20;
  if (cfg.honeypotEnabled) score += 20;

  if (cfg.verificationChannelId && guild.channels.cache.get(cfg.verificationChannelId)) score += 10;
  if (cfg.honeypotChannelId && guild.channels.cache.get(cfg.honeypotChannelId)) score += 10;
  if (cfg.logsChannelId && guild.channels.cache.get(cfg.logsChannelId)) score += 10;

  if (cfg.verificationRoleId && guild.roles.cache.get(cfg.verificationRoleId)) score += 10;
  if (cfg.adminRoleId && guild.roles.cache.get(cfg.adminRoleId)) score += 10;

  const blacklistSize = Array.isArray(data.blacklist) ? data.blacklist.length : 0;
  const penalty = Math.min(20, blacklistSize * 2);
  score += 10 - penalty;

  if (score < 0) score = 0;
  if (score > max) score = max;

  const totalUsers = Object.keys(data.verifiedUsers).length;

  let status = 'Unknown';
  if (score >= 85) status = 'Very Secure';
  else if (score >= 70) status = 'Secure';
  else if (score >= 50) status = 'Moderate';
  else status = 'Needs Attention';

  return { score, status, totalUsers, blacklistSize };
}

function computeGuildReputationAndRisk(guild) {
  const { score } = computeSecurityScore(guild);

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
// INTERACTIONS
// ---------------------------------------------------------------------------
client.on('interactionCreate', async interaction => {

  // -------------------------------------------------------------------------
  // SLASH COMMANDS
  // -------------------------------------------------------------------------
  if (interaction.isChatInputCommand()) {
    const name = interaction.commandName;

    // -----------------------------------------------------------------------
    // /setup
    // -----------------------------------------------------------------------
    if (name === 'setup') {
      if (!canUseVeriCommands(interaction)) {
        return interaction.reply({
          embeds: [
            boxEmbed({
              title: 'Veri.',
              description:
                'You are not allowed to run this command.\nOnly the server owner, Veri. Admin, Discord administrators, or official Veri. staff may run Veri. setup.',
              footer: 'Veri.'
            })
          ],
          ephemeral: true
        });
      }

      const guild = interaction.guild;
      const cfg = getGuildConfig(guild.id);

      if (cfg.setupComplete) {
        return interaction.reply({
          embeds: [
            boxEmbed({
              title: 'Veri.',
              description: 'Setup has already been completed for this server. It cannot be run again.',
              footer: 'Veri.'
            })
          ],
          ephemeral: true
        });
      }

      const botMember = guild.members.me;
      const requiredPerms = [
        PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.ManageRoles,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.EmbedLinks,
        PermissionFlagsBits.AttachFiles
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
          embeds: [
            boxEmbed({
              title: 'Veri.',
              description:
                `Setup cannot continue. Veri. is missing required permissions:\n${missingNames}\n\n` +
                'Grant Veri. these permissions (and make sure its role is high enough in the role list) and try again.',
              footer: 'Veri.'
            })
          ],
          ephemeral: true
        });
      }

      await interaction.deferReply({ ephemeral: false });

      try {
        // create or find admin role
        let adminRole = cfg.adminRoleId
          ? guild.roles.cache.get(cfg.adminRoleId)
          : guild.roles.cache.find(r => r.name === 'Veri. Admin');

        if (!adminRole) {
          adminRole = await guild.roles.create({
            name: 'Veri. Admin',
            reason: 'Veri. setup: admin role'
          });
          cfg.adminRoleId = adminRole.id;
          saveData(data);
        }

        // get or create Veri. category
        const category = await getOrCreateVeriCategory(guild, cfg);

        // verification channel
        let verificationChannel =
          (cfg.verificationChannelId ? guild.channels.cache.get(cfg.verificationChannelId) : null) ||
          guild.channels.cache.find(
            ch => ch.name === 'verification' && ch.type === ChannelType.GuildText
          );

        if (!verificationChannel) {
          verificationChannel = await guild.channels.create({
            name: 'verification',
            type: ChannelType.GuildText,
            parent: category.id,
            reason: 'Veri. setup: verification channel'
          });
        } else if (verificationChannel.parentId !== category.id) {
          await verificationChannel.setParent(category.id, { lockPermissions: false }).catch(() => {});
        }

        // logs channel
        let logsChannel =
          (cfg.logsChannelId ? guild.channels.cache.get(cfg.logsChannelId) : null) ||
          guild.channels.cache.find(
            ch => ch.name === 'veri-logs' && ch.type === ChannelType.GuildText
          );

        if (!logsChannel) {
          logsChannel = await guild.channels.create({
            name: 'veri-logs',
            type: ChannelType.GuildText,
            parent: category.id,
            reason: 'Veri. setup: logs channel'
          });
        } else if (logsChannel.parentId !== category.id) {
          await logsChannel.setParent(category.id, { lockPermissions: false }).catch(() => {});
        }

        // honeypot channel
        let honeypotChannel =
          (cfg.honeypotChannelId ? guild.channels.cache.get(cfg.honeypotChannelId) : null) ||
          guild.channels.cache.find(
            ch => ch.name === '!DO NOT TYPE HERE!' && ch.type === ChannelType.GuildText
          );

        if (!honeypotChannel) {
          honeypotChannel = await guild.channels.create({
            name: '!DO NOT TYPE HERE!',
            type: ChannelType.GuildText,
            parent: category.id,
            reason: 'Veri. setup: honeypot channel'
          });
        } else if (honeypotChannel.parentId !== category.id) {
          await honeypotChannel.setParent(category.id, { lockPermissions: false }).catch(() => {});
        }

        cfg.verificationChannelId = verificationChannel.id;
        cfg.logsChannelId = logsChannel.id;
        cfg.honeypotChannelId = honeypotChannel.id;
        cfg.captchaEnabled = true;
        cfg.honeypotEnabled = true;
        cfg.setupComplete = true;
        saveData(data);

        await sendVerificationMessage(verificationChannel);
        await sendHoneypotMessage(honeypotChannel);

        await interaction.editReply({
          embeds: [
            boxEmbed({
              title: 'Veri.',
              description:
                'Setup complete.\n\nAll Veri. channels have been created inside the "Veri." category.\nVerification, logs, and honeypot channels are configured.\nThe Verify button has been posted in the verification channel.\nA honeypot warning has been posted in the honeypot channel.\n\nThe "Veri. Admin" role has been created and stored.',
              footer: 'Veri.'
            })
          ]
        });

        await sendLog(guild, 'Veri. Setup', 'Channels created/linked and Verify button posted by /setup.');
      } catch (e) {
        console.error('Veri. setup failed:', e);
        await interaction.editReply({
          embeds: [
            boxEmbed({
              title: 'Veri.',
              description:
                'Setup failed partway through. This is usually caused by missing permissions or role hierarchy issues.\n' +
                'Check that Veri. has Manage Channels, Manage Roles, and a high enough role, then run /setup again.\n\n' +
                `Error: ${e.message}`,
              footer: 'Veri.'
            })
          ]
        });
      }
    }

    // -----------------------------------------------------------------------
    // /settings
    // -----------------------------------------------------------------------
    if (name === 'settings') {
      if (!canUseVeriCommands(interaction)) {
        return interaction.reply({
          embeds: [
            boxEmbed({
              title: 'Veri.',
              description:
                'You are not allowed to run this command.\nOnly the server owner, Veri. Admin, Discord administrators, or official Veri. staff may run Veri. settings.',
              footer: 'Veri.'
            })
          ],
          ephemeral: true
        });
      }

      const guild = interaction.guild;
      const cfg = getGuildConfig(guild.id);

      const captchaEnabled = interaction.options.getBoolean('captcha_enabled');
      const honeypotEnabled = interaction.options.getBoolean('honeypot_enabled');
      const honeypotMode = interaction.options.getString('honeypot_mode');
      const verificationRole = interaction.options.getRole('verification_role');

      await interaction.deferReply({ ephemeral: false });

      const changes = [];

      // ---- captcha toggle ----
      if (typeof captchaEnabled === 'boolean') {
        const wasEnabled = cfg.captchaEnabled;
        cfg.captchaEnabled = captchaEnabled;

        if (!captchaEnabled && wasEnabled) {
          // turning OFF: delete verification channel
          if (cfg.verificationChannelId) {
            const ch = guild.channels.cache.get(cfg.verificationChannelId);
            if (ch) {
              await ch.delete('Veri. captcha disabled').catch(() => {});
            }
            cfg.verificationChannelId = null;
          }
          changes.push('Captcha disabled. Verification channel deleted.');
        } else if (captchaEnabled && !wasEnabled) {
          // turning ON: recreate verification channel in category
          try {
            const category = await getOrCreateVeriCategory(guild, cfg);
            const verificationChannel = await guild.channels.create({
              name: 'verification',
              type: ChannelType.GuildText,
              parent: category.id,
              reason: 'Veri. captcha re-enabled'
            });
            cfg.verificationChannelId = verificationChannel.id;
            await sendVerificationMessage(verificationChannel);
            changes.push('Captcha enabled. Verification channel recreated in the Veri. category.');
          } catch (e) {
            cfg.captchaEnabled = false;
            changes.push(`Failed to recreate verification channel (check Veri. permissions): ${e.message}`);
          }
        } else {
          changes.push(`Captcha already set to ${captchaEnabled ? 'enabled' : 'disabled'}. No channel changes needed.`);
        }
      }

      // ---- honeypot toggle ----
      if (typeof honeypotEnabled === 'boolean') {
        const wasEnabled = cfg.honeypotEnabled;
        cfg.honeypotEnabled = honeypotEnabled;

        if (!honeypotEnabled && wasEnabled) {
          // turning OFF: delete honeypot channel
          if (cfg.honeypotChannelId) {
            const ch = guild.channels.cache.get(cfg.honeypotChannelId);
            if (ch) {
              await ch.delete('Veri. honeypot disabled').catch(() => {});
            }
            cfg.honeypotChannelId = null;
          }
          changes.push('Honeypot disabled. Honeypot channel deleted.');
        } else if (honeypotEnabled && !wasEnabled) {
          // turning ON: recreate honeypot channel in category
          try {
            const category = await getOrCreateVeriCategory(guild, cfg);
            const honeypotChannel = await guild.channels.create({
              name: '!DO NOT TYPE HERE!',
              type: ChannelType.GuildText,
              parent: category.id,
              reason: 'Veri. honeypot re-enabled'
            });
            cfg.honeypotChannelId = honeypotChannel.id;
            await sendHoneypotMessage(honeypotChannel);
            changes.push('Honeypot enabled. Honeypot channel recreated in the Veri. category.');
          } catch (e) {
            cfg.honeypotEnabled = false;
            changes.push(`Failed to recreate honeypot channel (check Veri. permissions): ${e.message}`);
          }
        } else {
          changes.push(`Honeypot already set to ${honeypotEnabled ? 'enabled' : 'disabled'}. No channel changes needed.`);
        }
      }

      if (honeypotMode) {
        cfg.honeypotMode = honeypotMode;
        changes.push(`Honeypot mode set to: ${honeypotMode}`);
      }
      if (verificationRole) {
        cfg.verificationRoleId = verificationRole.id;
        changes.push(`Verification role set to: <@&${verificationRole.id}>`);
      }

      saveData(data);

      const verificationRoleText = cfg.verificationRoleId
        ? `<@&${cfg.verificationRoleId}>`
        : 'Captcha Verified (auto-created if needed)';

      const summaryLines = [
        `Captcha enabled: ${cfg.captchaEnabled ? 'Yes' : 'No'}`,
        `Honeypot enabled: ${cfg.honeypotEnabled ? 'Yes' : 'No'}`,
        `Honeypot mode: ${cfg.honeypotMode}`,
        `Verification role: ${verificationRoleText}`,
        '',
        'Changes made:'
      ];
      if (changes.length === 0) summaryLines.push('No changes.');
      else changes.forEach(c => summaryLines.push(`- ${c}`));

      await interaction.editReply({
        embeds: [
          boxEmbed({
            title: 'Veri. Settings Updated',
            description: summaryLines.join('\n'),
            footer: 'Veri.'
          })
        ]
      });

      await sendLog(guild, 'Veri. Settings Updated', 'An administrator updated Veri. settings using /settings.');
    }

    // -----------------------------------------------------------------------
    // /player info
    // -----------------------------------------------------------------------
    if (name === 'player') {
      // player info is visible to everyone but admin-run features inside
      // still use canUseVeriCommands to restrict. If you want ALL users to
      // be able to look themselves up, remove the check below.
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

        const record = data.verifiedUsers[userId];

        let ownerExtra = '';
        if (userId === OWNER_ID) {
          ownerExtra =
            '\n\nStatus: OWNER\n' +
            'About Me: Creator of Veri.\n' +
            'Portfolio: https://stanzportfolio.vercel.app/';
        }

        if (!record) {
          const embed = boxEmbed({
            title: 'Veri. Player Information',
            description:
              `Display Name: ${displayName}\n` +
              `User ID: ${userId}\n\n` +
              `Verification Status: NOT VERIFIED\n` +
              `First Verified: Never\n` +
              `Last Verification: Never\n\n` +
              `Servers Verified In:\n` +
              `- None\n\n` +
              `Verification Stats:\n` +
              `- Failed Captchas: 0\n` +
              `- Honeypot Triggers: 0\n\n` +
              `Global Honeypot Blacklist: No` +
              ownerExtra,
            footer: 'Veri.'
          });

          if (avatarURL) embed.setThumbnail(avatarURL);
          return interaction.reply({ embeds: [embed], ephemeral: false });
        }

        const lines = [];
        lines.push(`Display Name: ${displayName}`);
        lines.push(`User ID: ${userId}`);
        lines.push('');
        lines.push(`Verification Status: ${record.firstVerified ? 'VERIFIED' : 'NOT VERIFIED'}`);
        lines.push(`First Verified: ${record.firstVerified ? new Date(record.firstVerified).toISOString() : 'Never'}`);
        lines.push(`Last Verification: ${record.lastVerification ? new Date(record.lastVerification).toISOString() : 'Never'}`);
        lines.push('');
        lines.push(
          'Servers Verified In:\n' +
            (record.servers && record.servers.length > 0
              ? record.servers.map(id => `- ${id}`).join('\n')
              : '- None')
        );
        lines.push('');
        lines.push('Verification Stats:');
        lines.push(`- Failed Captchas: ${record.fails || 0}`);
        lines.push(`- Honeypot Triggers: ${record.honeypotTriggers || 0}`);
        lines.push('');
        lines.push(`Global Honeypot Blacklist: ${isBlacklisted(userId) ? 'Yes' : 'No'}`);

        const embed = boxEmbed({
          title: 'Veri. Player Information',
          description: lines.join('\n') + ownerExtra,
          footer: 'Veri.'
        });

        if (avatarURL) embed.setThumbnail(avatarURL);

        await interaction.reply({ embeds: [embed], ephemeral: false });

        if (interaction.guild) {
          await sendLog(
            interaction.guild,
            'Veri. Player Info Viewed',
            `Player info requested for user id ${userId}.`
          );
        }
      }
    }

    // -----------------------------------------------------------------------
    // /security_score
    // -----------------------------------------------------------------------
    if (name === 'security_score') {
      if (!canUseVeriCommands(interaction)) {
        return interaction.reply({
          embeds: [
            boxEmbed({
              title: 'Veri.',
              description:
                'You are not allowed to run this command.\nOnly the server owner, Veri. Admin, Discord administrators, or official Veri. staff may view the security score.',
              footer: 'Veri.'
            })
          ],
          ephemeral: true
        });
      }

      const guild = interaction.guild;
      const { score, status, totalUsers, blacklistSize } = computeSecurityScore(guild);

      const embed = boxEmbed({
        title: 'Veri. Server Security Score',
        description:
          `Server: ${guild.name}\n` +
          `Score: ${score}/100\n` +
          `Status: ${status}\n\n` +
          `Verified users tracked: ${totalUsers}\n` +
          `Global blacklist size: ${blacklistSize}`,
        footer: 'Veri.'
      });

      return interaction.reply({ embeds: [embed], ephemeral: false });
    }

    // -----------------------------------------------------------------------
    // /veri_resend
    // -----------------------------------------------------------------------
    if (name === 'veri_resend') {
      if (!canUseVeriCommands(interaction)) {
        return interaction.reply({
          embeds: [
            boxEmbed({
              title: 'Veri.',
              description:
                'You are not allowed to run this command.\nOnly the server owner, Veri. Admin, Discord administrators, or official Veri. staff may run Veri. resend.',
              footer: 'Veri.'
            })
          ],
          ephemeral: true
        });
      }

      const guild = interaction.guild;
      const cfg = getGuildConfig(guild.id);
      const type = interaction.options.getString('type');

      if (type === 'verification') {
        const verificationChannel = cfg.verificationChannelId
          ? guild.channels.cache.get(cfg.verificationChannelId)
          : guild.channels.cache.find(
              ch => ch.name === 'verification' && ch.type === ChannelType.GuildText
            );

        if (!verificationChannel) {
          return interaction.reply({
            embeds: [
              boxEmbed({
                title: 'Veri.',
                description: 'No verification channel is configured. Run /setup or update settings.',
                footer: 'Veri.'
              })
            ],
            ephemeral: true
          });
        }

        await sendVerificationMessage(verificationChannel);

        await interaction.reply({
          embeds: [boxEmbed({ title: 'Veri.', description: 'Verification message has been re-sent.', footer: 'Veri.' })]
        });

        await sendLog(guild, 'Veri. Verification Message Re-Sent', 'An administrator re-sent the verification message using /veri_resend.');
        return;
      }

      if (type === 'honeypot') {
        const honeypotChannel = cfg.honeypotChannelId
          ? guild.channels.cache.get(cfg.honeypotChannelId)
          : guild.channels.cache.find(
              ch => ch.name === '!DO NOT TYPE HERE!' && ch.type === ChannelType.GuildText
            );

        if (!honeypotChannel) {
          return interaction.reply({
            embeds: [
              boxEmbed({
                title: 'Veri.',
                description: 'No honeypot channel is configured. Run /setup or update settings.',
                footer: 'Veri.'
              })
            ],
            ephemeral: true
          });
        }

        await sendHoneypotMessage(honeypotChannel);

        await interaction.reply({
          embeds: [boxEmbed({ title: 'Veri.', description: 'Honeypot warning message has been re-sent.', footer: 'Veri.' })]
        });

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
          embeds: [
            boxEmbed({
              title: 'Veri.',
              description:
                'ERROR: Only official Veri. staff can run this.\nIf you have any issues, visit our website.',
              footer: 'Veri.'
            })
          ],
          ephemeral: true
        });
      }

      const panelEmbed = boxEmbed({
        title: 'Veri. Staff Control Panel',
        description:
          'This panel is only visible to official Veri. staff.\n\nAll actions will send detailed results to your DMs.\n\nSelect an action below:',
        footer: 'Veri.'
      });

      const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('vs_view_blacklist')
          .setLabel('View Global Blacklist')
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId('vs_view_logs')
          .setLabel('View Server Logs')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId('vs_remove_this_server_data')
          .setLabel('Remove This Server Data')
          .setStyle(ButtonStyle.Secondary)
      );

      const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('vs_remove_server_id')
          .setLabel('Remove Server Data by ID')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('vs_force_verify')
          .setLabel('Force Verify User')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId('vs_reset_user')
          .setLabel('Reset User')
          .setStyle(ButtonStyle.Secondary)
      );

      const row3 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('vs_clear_honeypot')
          .setLabel('Clear Honeypot Triggers')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('vs_clear_fails')
          .setLabel('Clear Captcha Fails')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('vs_remove_blacklist')
          .setLabel('Remove From Blacklist')
          .setStyle(ButtonStyle.Success)
      );

      const row4 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('vs_view_all_servers')
          .setLabel('View All Servers')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId('vs_remove_bot_server')
          .setLabel('Remove Bot From Server')
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId('vs_remove_bot_this_server')
          .setLabel('Remove Bot From This Server')
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId('vs_system_tools')
          .setLabel('System Tools')
          .setStyle(ButtonStyle.Primary)
      );

      const row5 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('vs_restore_db')
          .setLabel('Restore Database')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('vs_resend_verification')
          .setLabel('Resend Verification Message')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId('vs_resend_honeypot')
          .setLabel('Resend Honeypot Message')
          .setStyle(ButtonStyle.Primary)
      );

      await interaction.reply({
        embeds: [panelEmbed],
        components: [row1, row2, row3, row4, row5],
        ephemeral: false
      });
    }
  }

  // -------------------------------------------------------------------------
  // BUTTONS
  // -------------------------------------------------------------------------
  if (interaction.isButton()) {
    const id = interaction.customId;

    // -----------------------------------------------------------------------
    // Verify button
    // -----------------------------------------------------------------------
    if (id === 'veri_start') {
      const guild = interaction.guild;
      const cfg = getGuildConfig(guild.id);

      if (!cfg.captchaEnabled) {
        return interaction.reply({
          embeds: [
            boxEmbed({
              title: 'Veri.',
              description: 'Verification is currently disabled on this server.',
              footer: 'Veri.'
            })
          ],
          ephemeral: true
        });
      }

      const dm = await interaction.user.createDM().catch(() => null);
      if (!dm) {
        await sendLog(
          guild,
          'Veri. Verification DM Failed',
          `User ${interaction.user.id} clicked Verify but Veri. could not open a DM with them.`
        );
        return interaction.reply({
          embeds: [
            boxEmbed({
              title: 'Veri.',
              description:
                'Veri. could not send you a DM.\nPlease enable DMs from server members and try again.',
              footer: 'Veri.'
            })
          ],
          ephemeral: true
        });
      }

      const record = getUserRecord(interaction.user.id);
      if (record.firstVerified && record.servers.includes(guild.id)) {
        return interaction.reply({
          embeds: [
            boxEmbed({
              title: 'Veri.',
              description: 'You are already verified in this server.',
              footer: 'Veri.'
            })
          ],
          ephemeral: true
        });
      }

      const { file, answer } = getRandomCaptcha();

      captchaSessions.set(interaction.user.id, { answer, guildId: guild.id });

      const dmEmbed = boxEmbed({
        title: 'Veri. Verification',
        description:
          'You are verifying for a server using Veri.\n\nLook at the image and reply with the correct number.\nReply with only the number.',
        footer: 'Veri.'
      });

      await dm.send({ embeds: [dmEmbed], files: [path.join(__dirname, file)] });

      return interaction.reply({
        embeds: [
          boxEmbed({
            title: 'Veri.',
            description: 'Veri. has sent you a DM with your verification captcha.',
            footer: 'Veri.'
          })
        ],
        ephemeral: true
      });
    }

    // -----------------------------------------------------------------------
    // Staff buttons (global, not per-guild)
    // -----------------------------------------------------------------------
    if (id.startsWith('vs_') && !id.startsWith('vs_guild_')) {
      if (interaction.user.id !== OWNER_ID) {
        return interaction.reply({
          embeds: [
            boxEmbed({
              title: 'Veri.',
              description:
                'ERROR: Only official Veri. staff can run this.\nIf you have any issues, visit our website.',
              footer: 'Veri.'
            })
          ],
          ephemeral: true
        });
      }

      const dm = await interaction.user.createDM().catch(() => null);
      if (!dm) {
        return interaction.reply({
          embeds: [
            boxEmbed({
              title: 'Veri.',
              description: 'Veri. could not send you a DM.\nStaff actions require DMs to be enabled.',
              footer: 'Veri.'
            })
          ],
          ephemeral: true
        });
      }

      const guild = interaction.guild;

      // View Global Blacklist
      if (id === 'vs_view_blacklist') {
        const list = Array.isArray(data.blacklist) ? data.blacklist : [];
        if (list.length === 0) {
          await dm.send({
            embeds: [
              boxEmbed({
                title: 'Veri. Staff - Global Blacklist',
                description: 'The global blacklist is currently empty.',
                footer: 'Veri.'
              })
            ]
          });
        } else {
          const chunks = [];
          let current = [];
          for (const uid of list) {
            current.push(`- ${uid}`);
            if (current.join('\n').length > 1500) {
              chunks.push(current.join('\n'));
              current = [];
            }
          }
          if (current.length) chunks.push(current.join('\n'));

          let index = 1;
          for (const chunk of chunks) {
            await dm.send({
              embeds: [
                boxEmbed({
                  title: `Veri. Staff - Global Blacklist (Page ${index})`,
                  description: chunk,
                  footer: 'Veri.'
                })
              ]
            });
            index++;
          }
        }

        return interaction.reply({
          embeds: [
            boxEmbed({
              title: 'Veri.',
              description: 'Global blacklist has been sent to your DMs.',
              footer: 'Veri.'
            })
          ],
          ephemeral: false
        });
      }

      // View Server Logs
      if (id === 'vs_view_logs') {
        const cfg = getGuildConfig(guild.id);
        const logsChannel = cfg.logsChannelId ? guild.channels.cache.get(cfg.logsChannelId) : null;

        if (!logsChannel || logsChannel.type !== ChannelType.GuildText) {
          await dm.send({
            embeds: [
              boxEmbed({
                title: 'Veri. Staff - Server Logs',
                description: 'No valid logs channel is configured for this server.',
                footer: 'Veri.'
              })
            ]
          });
        } else {
          const messages = await logsChannel.messages.fetch({ limit: 50 }).catch(() => null);
          if (!messages || messages.size === 0) {
            await dm.send({
              embeds: [
                boxEmbed({
                  title: 'Veri. Staff - Server Logs',
                  description: 'No recent Veri. logs found in the logs channel.',
                  footer: 'Veri.'
                })
              ]
            });
          } else {
            const sorted = [...messages.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
            const lines = sorted.map(
              m =>
                `- [${new Date(m.createdTimestamp).toISOString()}] ${m.author.tag}: ${m.embeds[0]?.title || m.content || '(embed)'}`
            );
            const chunks = [];
            let current = [];
            for (const line of lines) {
              current.push(line);
              if (current.join('\n').length > 1500) {
                chunks.push(current.join('\n'));
                current = [];
              }
            }
            if (current.length) chunks.push(current.join('\n'));

            let index = 1;
            for (const chunk of chunks) {
              await dm.send({
                embeds: [
                  boxEmbed({ title: `Veri. Staff - Server Logs (Page ${index})`, description: chunk, footer: 'Veri.' })
                ]
              });
              index++;
            }
          }
        }

        return interaction.reply({
          embeds: [boxEmbed({ title: 'Veri.', description: 'Server logs have been sent to your DMs.', footer: 'Veri.' })],
          ephemeral: false
        });
      }

      // Remove This Server Data
      if (id === 'vs_remove_this_server_data') {
        const guildId = guild.id;
        delete data.guilds[guildId];
        saveData(data);

        await dm.send({
          embeds: [
            boxEmbed({
              title: 'Veri. Staff - Remove This Server Data',
              description: `All Veri. data for server ID ${guildId} has been removed.\nThis server is now treated as fresh by Veri.`,
              footer: 'Veri.'
            })
          ]
        });

        return interaction.reply({
          embeds: [
            boxEmbed({
              title: 'Veri.',
              description: 'This server data has been removed from Veri. tracking. Details sent to your DMs.',
              footer: 'Veri.'
            })
          ],
          ephemeral: false
        });
      }

      // View All Servers
      if (id === 'vs_view_all_servers') {
        const guilds = [...client.guilds.cache.values()];

        if (guilds.length === 0) {
          await dm.send({
            embeds: [
              boxEmbed({
                title: 'Veri. Staff - Global Server Overview',
                description: 'Veri. is not currently in any servers.',
                footer: 'Veri.'
              })
            ]
          });
        } else {
          const chunkSize = 3;
          for (let i = 0; i < guilds.length; i += chunkSize) {
            const slice = guilds.slice(i, i + chunkSize);
            const lines = [];
            const rows = [];

            for (const g of slice) {
              const cfg = getGuildConfig(g.id);
              const { score, status } = computeSecurityScore(g);
              const { reputation, repLabel, risk } = computeGuildReputationAndRisk(g);

              let verifiedCount = 0;
              let totalFails = 0;
              let totalHoneypot = 0;

              for (const rec of Object.values(data.verifiedUsers)) {
                if (rec.servers && rec.servers.includes(g.id)) {
                  verifiedCount++;
                  totalFails += rec.fails || 0;
                  totalHoneypot += rec.honeypotTriggers || 0;
                }
              }

              const memberCount = g.memberCount || 0;
              const unverifiedApprox = memberCount > verifiedCount ? memberCount - verifiedCount : 0;

              lines.push(`=== ${g.name} ===`);
              lines.push(`ID: ${g.id}`);
              lines.push(`Security Score: ${score}/100 (${status})`);
              lines.push(`Reputation: ${reputation}/100 (${repLabel})`);
              lines.push(`Risk Level: ${risk}`);
              lines.push('');
              lines.push(`Members: ${memberCount}`);
              lines.push(`Verified (approx): ${verifiedCount}`);
              lines.push(`Unverified (approx): ${unverifiedApprox}`);
              lines.push('');
              lines.push(
                `Verification Stats (approx):\n` +
                  `- Total Failed Captchas: ${totalFails}\n` +
                  `- Total Honeypot Triggers: ${totalHoneypot}`
              );
              lines.push('');

              // NOTE: per-guild button customId format is vs_guild_<guildId>_<action>
              // action options: logs | remove | system (modal = vs_guild_<guildId>_system_modal)
              const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                  .setCustomId(`vs_guild_${g.id}_logs`)
                  .setLabel('View Logs')
                  .setStyle(ButtonStyle.Primary),
                new ButtonBuilder()
                  .setCustomId(`vs_guild_${g.id}_remove`)
                  .setLabel('Remove Server Data')
                  .setStyle(ButtonStyle.Secondary),
                new ButtonBuilder()
                  .setCustomId(`vs_guild_${g.id}_system`)
                  .setLabel('System Tools')
                  .setStyle(ButtonStyle.Primary)
              );
              rows.push(row);
            }

            await dm.send({
              embeds: [
                boxEmbed({
                  title: 'Veri. Global Server Overview',
                  description: lines.join('\n'),
                  footer: 'Veri.'
                })
              ],
              components: rows
            });
          }
        }

        return interaction.reply({
          embeds: [
            boxEmbed({
              title: 'Veri.',
              description: 'Global server overview has been sent to your DMs.',
              footer: 'Veri.'
            })
          ],
          ephemeral: false
        });
      }

      // Resend Verification
      if (id === 'vs_resend_verification') {
        const cfg = getGuildConfig(guild.id);
        const verificationChannel = cfg.verificationChannelId
          ? guild.channels.cache.get(cfg.verificationChannelId)
          : guild.channels.cache.find(ch => ch.name === 'verification' && ch.type === ChannelType.GuildText);

        if (!verificationChannel) {
          return interaction.reply({
            embeds: [
              boxEmbed({
                title: 'Veri.',
                description: 'No verification channel is configured. Run /setup or update settings.',
                footer: 'Veri.'
              })
            ],
            ephemeral: true
          });
        }

        await sendVerificationMessage(verificationChannel);

        await interaction.reply({
          embeds: [boxEmbed({ title: 'Veri.', description: 'Verification message has been re-sent.', footer: 'Veri.' })],
          ephemeral: false
        });

        await sendLog(guild, 'Veri. Verification Message Re-Sent', 'Staff re-sent the verification message from Veri. Staff Panel.');
        return;
      }

      // Resend Honeypot
      if (id === 'vs_resend_honeypot') {
        const cfg = getGuildConfig(guild.id);
        const honeypotChannel = cfg.honeypotChannelId
          ? guild.channels.cache.get(cfg.honeypotChannelId)
          : guild.channels.cache.find(ch => ch.name === '!DO NOT TYPE HERE!' && ch.type === ChannelType.GuildText);

        if (!honeypotChannel) {
          return interaction.reply({
            embeds: [
              boxEmbed({
                title: 'Veri.',
                description: 'No honeypot channel is configured. Run /setup or update settings.',
                footer: 'Veri.'
              })
            ],
            ephemeral: true
          });
        }

        await sendHoneypotMessage(honeypotChannel);

        await interaction.reply({
          embeds: [boxEmbed({ title: 'Veri.', description: 'Honeypot warning message has been re-sent.', footer: 'Veri.' })],
          ephemeral: false
        });

        await sendLog(guild, 'Veri. Honeypot Message Re-Sent', 'Staff re-sent the honeypot message from Veri. Staff Panel.');
        return;
      }

      // Remove Bot From This Server
      if (id === 'vs_remove_bot_this_server') {
        await dm.send({
          embeds: [
            boxEmbed({
              title: 'Veri. Staff - Remove Bot From This Server',
              description:
                `Veri. will leave server ID ${guild.id} (${guild.name}).\n` +
                'Server data will remain unless removed separately.',
              footer: 'Veri.'
            })
          ]
        });

        await interaction.reply({
          embeds: [
            boxEmbed({
              title: 'Veri.',
              description: 'Veri. is leaving this server. Details sent to your DMs.',
              footer: 'Veri.'
            })
          ],
          ephemeral: false
        });

        setTimeout(() => { guild.leave().catch(() => {}); }, 2000);
        return;
      }

      // Remove Bot From Server (by ID - modal)
      if (id === 'vs_remove_bot_server') {
        const modal = new ModalBuilder()
          .setTitle('Veri. Staff - Remove Bot From Server')
          .setCustomId('vs_remove_bot_server_modal');

        const input = new TextInputBuilder()
          .setCustomId('server_id')
          .setLabel('Server ID to remove Veri. from')
          .setStyle(TextInputStyle.Short)
          .setRequired(true);

        modal.addComponents(new ActionRowBuilder().addComponents(input));
        await interaction.showModal(modal);
        return;
      }

      // Restore Database (modal)
      if (id === 'vs_restore_db') {
        const modal = new ModalBuilder()
          .setTitle('Veri. Staff - Restore Database')
          .setCustomId('vs_restore_db_modal');

        const input = new TextInputBuilder()
          .setCustomId('db_json')
          .setLabel('Paste Veri. JSON here (type RESTORE at start)')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true);

        modal.addComponents(new ActionRowBuilder().addComponents(input));
        await interaction.showModal(modal);
        return;
      }

      // Modals for ID-based actions
      const modal = new ModalBuilder().setTitle('Veri. Staff').setCustomId(id + '_modal');

      if (id === 'vs_remove_server_id') {
        modal.addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('server_id')
              .setLabel('Server ID to remove from Veri. data')
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
          )
        );
      } else if (id === 'vs_force_verify') {
        modal.addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('user_id')
              .setLabel('User ID to force verify')
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
          )
        );
      } else if (id === 'vs_reset_user') {
        modal.addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('user_id')
              .setLabel('User ID to reset')
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
          )
        );
      } else if (id === 'vs_clear_honeypot') {
        modal.addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('user_id')
              .setLabel('User ID to clear honeypot triggers')
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
          )
        );
      } else if (id === 'vs_clear_fails') {
        modal.addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('user_id')
              .setLabel('User ID to clear captcha fails')
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
          )
        );
      } else if (id === 'vs_remove_blacklist') {
        modal.addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('user_id')
              .setLabel('User ID to remove from global blacklist')
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
          )
        );
      } else if (id === 'vs_system_tools') {
        modal.addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('dummy')
              .setLabel('Type "run" to execute system tools summary')
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
          )
        );
      } else {
        return;
      }

      await interaction.showModal(modal);
      return;
    }

    // -----------------------------------------------------------------------
    // Per-server buttons from global overview (sent via DM)
    // Format: vs_guild_<guildId>_<action>
    // -----------------------------------------------------------------------
    if (id.startsWith('vs_guild_')) {
      if (interaction.user.id !== OWNER_ID) {
        return interaction.reply({
          embeds: [
            boxEmbed({
              title: 'Veri.',
              description:
                'ERROR: Only official Veri. staff can run this.\nIf you have any issues, visit our website.',
              footer: 'Veri.'
            })
          ],
          ephemeral: true
        });
      }

      const dm = await interaction.user.createDM().catch(() => null);
      if (!dm) {
        return interaction.reply({
          embeds: [
            boxEmbed({
              title: 'Veri.',
              description: 'Veri. could not send you a DM.\nStaff actions require DMs to be enabled.',
              footer: 'Veri.'
            })
          ],
          ephemeral: true
        });
      }

      // parse: vs_guild_<guildId>_<action>
      // guildId can contain underscores? No - Discord snowflakes are numeric only, safe to split at index 2
      const withoutPrefix = id.slice('vs_guild_'.length); // "<guildId>_<action>"
      const underscoreIdx = withoutPrefix.lastIndexOf('_');
      const guildId = withoutPrefix.slice(0, underscoreIdx);
      const action = withoutPrefix.slice(underscoreIdx + 1);

      const targetGuild =
        client.guilds.cache.get(guildId) ||
        (await client.guilds.fetch(guildId).catch(() => null));

      if (!targetGuild) {
        return interaction.reply({
          embeds: [
            boxEmbed({
              title: 'Veri.',
              description: `Guild ${guildId} is no longer available.`,
              footer: 'Veri.'
            })
          ],
          ephemeral: true
        });
      }

      if (action === 'logs') {
        const cfg = getGuildConfig(targetGuild.id);
        const logsChannel = cfg.logsChannelId ? targetGuild.channels.cache.get(cfg.logsChannelId) : null;

        if (!logsChannel || logsChannel.type !== ChannelType.GuildText) {
          await dm.send({
            embeds: [
              boxEmbed({
                title: 'Veri. Staff - Server Logs',
                description: `No valid logs channel is configured for server ${targetGuild.id}.`,
                footer: 'Veri.'
              })
            ]
          });
        } else {
          const messages = await logsChannel.messages.fetch({ limit: 50 }).catch(() => null);
          if (!messages || messages.size === 0) {
            await dm.send({
              embeds: [
                boxEmbed({
                  title: 'Veri. Staff - Server Logs',
                  description: `No recent Veri. logs found in the logs channel for server ${targetGuild.id}.`,
                  footer: 'Veri.'
                })
              ]
            });
          } else {
            const sorted = [...messages.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
            const lines = sorted.map(
              m =>
                `- [${new Date(m.createdTimestamp).toISOString()}] ${m.author.tag}: ${m.embeds[0]?.title || m.content || '(embed)'}`
            );
            const chunks = [];
            let current = [];
            for (const line of lines) {
              current.push(line);
              if (current.join('\n').length > 1500) {
                chunks.push(current.join('\n'));
                current = [];
              }
            }
            if (current.length) chunks.push(current.join('\n'));

            let index = 1;
            for (const chunk of chunks) {
              await dm.send({
                embeds: [
                  boxEmbed({
                    title: `Veri. Staff - Server Logs (${targetGuild.name}) (Page ${index})`,
                    description: chunk,
                    footer: 'Veri.'
                  })
                ]
              });
              index++;
            }
          }
        }

        return interaction.reply({
          embeds: [
            boxEmbed({
              title: 'Veri.',
              description: `Server logs for ${targetGuild.name} have been sent to your DMs.`,
              footer: 'Veri.'
            })
          ],
          ephemeral: false
        });
      }

      if (action === 'remove') {
        delete data.guilds[targetGuild.id];
        saveData(data);

        await dm.send({
          embeds: [
            boxEmbed({
              title: 'Veri. Staff - Remove Server Data',
              description:
                `All Veri. data for server ID ${targetGuild.id} (${targetGuild.name}) has been removed.\n` +
                'This server is now treated as fresh by Veri.',
              footer: 'Veri.'
            })
          ]
        });

        return interaction.reply({
          embeds: [
            boxEmbed({
              title: 'Veri.',
              description: `Server data for ${targetGuild.name} has been removed from Veri. tracking. Details sent to your DMs.`,
              footer: 'Veri.'
            })
          ],
          ephemeral: false
        });
      }

      // system: show modal
      if (action === 'system') {
        const modal = new ModalBuilder()
          .setTitle(`Veri. Staff - ${targetGuild.name}`)
          .setCustomId(`vs_guild_${targetGuild.id}_system_modal`);

        modal.addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('dummy')
              .setLabel('Type "run" to execute system tools summary')
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
          )
        );

        await interaction.showModal(modal);
        return;
      }

      return;
    }
  }

  // -------------------------------------------------------------------------
  // MODAL SUBMITS
  // -------------------------------------------------------------------------
  if (interaction.isModalSubmit()) {
    const id = interaction.customId;

    if (!id.startsWith('vs_')) return;

    if (interaction.user.id !== OWNER_ID) {
      return interaction.reply({
        embeds: [
          boxEmbed({
            title: 'Veri.',
            description:
              'ERROR: Only official Veri. staff can run this.\nIf you have any issues, visit our website.',
            footer: 'Veri.'
          })
        ],
        ephemeral: true
      });
    }

    const dm = await interaction.user.createDM().catch(() => null);
    if (!dm) {
      return interaction.reply({
        embeds: [
          boxEmbed({
            title: 'Veri.',
            description: 'Veri. could not send you a DM.\nStaff actions require DMs to be enabled.',
            footer: 'Veri.'
          })
        ],
        ephemeral: true
      });
    }

    // Remove Bot From Server (by ID)
    if (id === 'vs_remove_bot_server_modal') {
      const serverId = interaction.fields.getTextInputValue('server_id').trim();
      const targetGuild =
        client.guilds.cache.get(serverId) ||
        (await client.guilds.fetch(serverId).catch(() => null));

      if (!targetGuild) {
        await dm.send({
          embeds: [
            boxEmbed({
              title: 'Veri. Staff - Remove Bot From Server',
              description: `Veri. is not in server ID ${serverId}.`,
              footer: 'Veri.'
            })
          ]
        });

        return interaction.reply({
          embeds: [boxEmbed({ title: 'Veri.', description: 'Result has been sent to your DMs.', footer: 'Veri.' })],
          ephemeral: false
        });
      }

      await dm.send({
        embeds: [
          boxEmbed({
            title: 'Veri. Staff - Remove Bot From Server',
            description:
              `Veri. will leave server ID ${targetGuild.id} (${targetGuild.name}).\n` +
              'Server data will remain unless removed separately.',
            footer: 'Veri.'
          })
        ]
      });

      await interaction.reply({
        embeds: [
          boxEmbed({
            title: 'Veri.',
            description: 'Veri. is leaving the specified server. Details sent to your DMs.',
            footer: 'Veri.'
          })
        ],
        ephemeral: false
      });

      setTimeout(() => { targetGuild.leave().catch(() => {}); }, 2000);
      return;
    }

    // Restore Database
    if (id === 'vs_restore_db_modal') {
      const raw = interaction.fields.getTextInputValue('db_json');
      const trimmed = raw.trim();

      if (!trimmed.toLowerCase().startsWith('restore')) {
        return interaction.reply({
          embeds: [
            boxEmbed({
              title: 'Veri.',
              description: 'Database restore cancelled (you did not start with "RESTORE").',
              footer: 'Veri.'
            })
          ],
          ephemeral: true
        });
      }

      const jsonPart = trimmed.slice('restore'.length).trim();
      if (!jsonPart) {
        return interaction.reply({
          embeds: [
            boxEmbed({
              title: 'Veri.',
              description: 'No JSON content provided after "RESTORE".',
              footer: 'Veri.'
            })
          ],
          ephemeral: true
        });
      }

      try {
        restoreDataFromJson(jsonPart);

        await dm.send({
          embeds: [
            boxEmbed({
              title: 'Veri. Staff - Database Restore',
              description:
                'Database has been restored from the provided JSON.\n' +
                'Previous database was backed up to veri-data-backup.json.',
              footer: 'Veri.'
            })
          ]
        });

        return interaction.reply({
          embeds: [boxEmbed({ title: 'Veri.', description: 'Database restore completed. Details sent to your DMs.', footer: 'Veri.' })],
          ephemeral: false
        });
      } catch (e) {
        return interaction.reply({
          embeds: [boxEmbed({ title: 'Veri.', description: `Database restore failed: ${e.message}`, footer: 'Veri.' })],
          ephemeral: true
        });
      }
    }

    // -----------------------------------------------------------------------
    // Per-guild system tools modal from global overview
    // Format: vs_guild_<guildId>_system_modal
    // -----------------------------------------------------------------------
    if (id.startsWith('vs_guild_') && id.endsWith('_system_modal')) {
      const withoutPrefix = id.slice('vs_guild_'.length);
      const withoutSuffix = withoutPrefix.slice(0, withoutPrefix.length - '_system_modal'.length);
      const guildId = withoutSuffix;

      const targetGuild =
        client.guilds.cache.get(guildId) ||
        (await client.guilds.fetch(guildId).catch(() => null));

      if (!targetGuild) {
        return interaction.reply({
          embeds: [boxEmbed({ title: 'Veri.', description: `Guild ${guildId} is no longer available.`, footer: 'Veri.' })],
          ephemeral: true
        });
      }

      const value = interaction.fields.getTextInputValue('dummy').trim().toLowerCase();
      if (value !== 'run') {
        return interaction.reply({
          embeds: [boxEmbed({ title: 'Veri.', description: 'System tools cancelled (you did not type "run").', footer: 'Veri.' })],
          ephemeral: true
        });
      }

      const lines = [];
      lines.push('System Tools Summary:');
      lines.push('');
      lines.push(`Guilds tracked: ${Object.keys(data.guilds).length}`);
      lines.push(`Verified users tracked: ${Object.keys(data.verifiedUsers).length}`);
      lines.push(`Global blacklist size: ${Array.isArray(data.blacklist) ? data.blacklist.length : 0}`);
      lines.push('');
      lines.push('Selected Guild:');
      const cfg = getGuildConfig(targetGuild.id);
      lines.push(`ID: ${targetGuild.id}`);
      lines.push(`Name: ${targetGuild.name}`);
      lines.push(`Category: ${cfg.categoryId || 'None'}`);
      lines.push(`Verification channel: ${cfg.verificationChannelId || 'None'}`);
      lines.push(`Logs channel: ${cfg.logsChannelId || 'None'}`);
      lines.push(`Honeypot channel: ${cfg.honeypotChannelId || 'None'}`);
      lines.push(`Verification role: ${cfg.verificationRoleId || 'None'}`);
      lines.push(`Admin role: ${cfg.adminRoleId || 'None'}`);
      lines.push(`Captcha enabled: ${cfg.captchaEnabled ? 'Yes' : 'No'}`);
      lines.push(`Honeypot enabled: ${cfg.honeypotEnabled ? 'Yes' : 'No'}`);

      await dm.send({
        embeds: [
          boxEmbed({ title: 'Veri. Staff - System Tools', description: lines.join('\n'), footer: 'Veri.' })
        ]
      });

      return interaction.reply({
        embeds: [boxEmbed({ title: 'Veri.', description: 'System tools summary has been sent to your DMs.', footer: 'Veri.' })],
        ephemeral: false
      });
    }

    // -----------------------------------------------------------------------
    // Original per-guild modals (current server context)
    // -----------------------------------------------------------------------
    if (id === 'vs_remove_server_id_modal') {
      const serverId = interaction.fields.getTextInputValue('server_id').trim();
      delete data.guilds[serverId];
      saveData(data);

      await dm.send({
        embeds: [
          boxEmbed({
            title: 'Veri. Staff - Remove Server Data by ID',
            description:
              `All Veri. data for server ID ${serverId} has been removed.\n` +
              'This server is now treated as fresh by Veri.',
            footer: 'Veri.'
          })
        ]
      });

      return interaction.reply({
        embeds: [boxEmbed({ title: 'Veri.', description: 'Server data removal details have been sent to your DMs.', footer: 'Veri.' })],
        ephemeral: false
      });
    }

    if (id === 'vs_force_verify_modal') {
      const guild = interaction.guild;
      const userId = interaction.fields.getTextInputValue('user_id').trim();
      const cfg = getGuildConfig(guild.id);

      let role = cfg.verificationRoleId ? guild.roles.cache.get(cfg.verificationRoleId) : null;
      if (!role) {
        role =
          guild.roles.cache.find(r => r.name === 'Captcha Verified') ||
          (await guild.roles.create({ name: 'Captcha Verified', reason: 'Veri. verification role' }));
        cfg.verificationRoleId = role.id;
        saveData(data);
      }

      const member = await guild.members.fetch(userId).catch(() => null);
      if (member && role) await member.roles.add(role).catch(() => {});

      const record = getUserRecord(userId);
      const now = Date.now();
      if (!record.firstVerified) record.firstVerified = now;
      record.lastVerification = now;
      record.servers = Array.from(new Set([...(record.servers || []), guild.id]));
      saveData(data);

      await dm.send({
        embeds: [
          boxEmbed({
            title: 'Veri. Staff - Force Verify User',
            description:
              `User ID ${userId} has been force-verified in server ${guild.id}.\n` +
              'Their Veri. record has been updated.',
            footer: 'Veri.'
          })
        ]
      });

      return interaction.reply({
        embeds: [boxEmbed({ title: 'Veri.', description: 'Force verify details have been sent to your DMs.', footer: 'Veri.' })],
        ephemeral: false
      });
    }

    if (id === 'vs_reset_user_modal') {
      const userId = interaction.fields.getTextInputValue('user_id').trim();
      delete data.verifiedUsers[userId];
      saveData(data);

      await dm.send({
        embeds: [
          boxEmbed({
            title: 'Veri. Staff - Reset User',
            description:
              `The Veri. record for user ID ${userId} has been reset.\n` +
              'They will be treated as a new user by Veri.',
            footer: 'Veri.'
          })
        ]
      });

      return interaction.reply({
        embeds: [boxEmbed({ title: 'Veri.', description: 'User reset details have been sent to your DMs.', footer: 'Veri.' })],
        ephemeral: false
      });
    }

    if (id === 'vs_clear_honeypot_modal') {
      const userId = interaction.fields.getTextInputValue('user_id').trim();
      const record = getUserRecord(userId);
      record.honeypotTriggers = 0;
      saveData(data);

      await dm.send({
        embeds: [
          boxEmbed({
            title: 'Veri. Staff - Clear Honeypot Triggers',
            description: `All honeypot trigger counts for user ID ${userId} have been cleared.`,
            footer: 'Veri.'
          })
        ]
      });

      return interaction.reply({
        embeds: [boxEmbed({ title: 'Veri.', description: 'Honeypot clear details have been sent to your DMs.', footer: 'Veri.' })],
        ephemeral: false
      });
    }

    if (id === 'vs_clear_fails_modal') {
      const userId = interaction.fields.getTextInputValue('user_id').trim();
      const record = getUserRecord(userId);
      record.fails = 0;
      saveData(data);

      await dm.send({
        embeds: [
          boxEmbed({
            title: 'Veri. Staff - Clear Captcha Fails',
            description: `All captcha fail counts for user ID ${userId} have been cleared.`,
            footer: 'Veri.'
          })
        ]
      });

      return interaction.reply({
        embeds: [boxEmbed({ title: 'Veri.', description: 'Captcha fail clear details have been sent to your DMs.', footer: 'Veri.' })],
        ephemeral: false
      });
    }

    if (id === 'vs_remove_blacklist_modal') {
      const userId = interaction.fields.getTextInputValue('user_id').trim();
      const wasBlacklisted = isBlacklisted(userId);
      removeFromBlacklist(userId);

      await dm.send({
        embeds: [
          boxEmbed({
            title: 'Veri. Staff - Remove From Blacklist',
            description: wasBlacklisted
              ? `User ID ${userId} has been removed from the global blacklist.\nThey will no longer be auto-banned on join.`
              : `User ID ${userId} was not on the global blacklist. No changes made.`,
            footer: 'Veri.'
          })
        ]
      });

      return interaction.reply({
        embeds: [boxEmbed({ title: 'Veri.', description: 'Blacklist removal details have been sent to your DMs.', footer: 'Veri.' })],
        ephemeral: false
      });
    }

    if (id === 'vs_system_tools_modal') {
      const guild = interaction.guild;
      const value = interaction.fields.getTextInputValue('dummy').trim().toLowerCase();
      if (value !== 'run') {
        return interaction.reply({
          embeds: [boxEmbed({ title: 'Veri.', description: 'System tools cancelled (you did not type "run").', footer: 'Veri.' })],
          ephemeral: true
        });
      }

      const lines = [];
      lines.push('System Tools Summary:');
      lines.push('');
      lines.push(`Guilds tracked: ${Object.keys(data.guilds).length}`);
      lines.push(`Verified users tracked: ${Object.keys(data.verifiedUsers).length}`);
      lines.push(`Global blacklist size: ${Array.isArray(data.blacklist) ? data.blacklist.length : 0}`);
      lines.push('');
      lines.push('Current Guild:');
      if (guild) {
        const cfg = getGuildConfig(guild.id);
        lines.push(`ID: ${guild.id}`);
        lines.push(`Name: ${guild.name}`);
        lines.push(`Category: ${cfg.categoryId || 'None'}`);
        lines.push(`Verification channel: ${cfg.verificationChannelId || 'None'}`);
        lines.push(`Logs channel: ${cfg.logsChannelId || 'None'}`);
        lines.push(`Honeypot channel: ${cfg.honeypotChannelId || 'None'}`);
        lines.push(`Verification role: ${cfg.verificationRoleId || 'None'}`);
        lines.push(`Admin role: ${cfg.adminRoleId || 'None'}`);
        lines.push(`Captcha enabled: ${cfg.captchaEnabled ? 'Yes' : 'No'}`);
        lines.push(`Honeypot enabled: ${cfg.honeypotEnabled ? 'Yes' : 'No'}`);
      } else {
        lines.push('No guild context.');
      }

      await dm.send({
        embeds: [boxEmbed({ title: 'Veri. Staff - System Tools', description: lines.join('\n'), footer: 'Veri.' })]
      });

      return interaction.reply({
        embeds: [boxEmbed({ title: 'Veri.', description: 'System tools summary has been sent to your DMs.', footer: 'Veri.' })],
        ephemeral: false
      });
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
      return message.channel.send({
        embeds: [boxEmbed({ title: 'Veri.', description: 'Please reply with a number only.', footer: 'Veri.' })]
      });
    }

    const num = Number(content);
    const record = getUserRecord(message.author.id);

    if (!Number.isInteger(num)) {
      return message.channel.send({
        embeds: [boxEmbed({ title: 'Veri.', description: 'Please reply with a number only.', footer: 'Veri.' })]
      });
    }

    const guild = client.guilds.cache.get(session.guildId);
    if (!guild) {
      captchaSessions.delete(message.author.id);
      return message.channel.send({
        embeds: [
          boxEmbed({
            title: 'Veri.',
            description: 'The server you were verifying for is no longer available.',
            footer: 'Veri.'
          })
        ]
      });
    }

    const cfg = getGuildConfig(guild.id);

    // If captcha was disabled after this session started, cancel it cleanly
    if (!cfg.captchaEnabled) {
      captchaSessions.delete(message.author.id);
      return message.channel.send({
        embeds: [
          boxEmbed({
            title: 'Veri.',
            description: 'Verification has been disabled on that server. You no longer need to verify.',
            footer: 'Veri.'
          })
        ]
      });
    }

    if (num === session.answer) {
      if (record.firstVerified && record.servers.includes(guild.id)) {
        captchaSessions.delete(message.author.id);
        return message.channel.send({
          embeds: [boxEmbed({ title: 'Veri.', description: 'You are already verified in this server.', footer: 'Veri.' })]
        });
      }

      const now = Date.now();
      if (!record.firstVerified) record.firstVerified = now;
      record.lastVerification = now;
      record.servers = Array.from(new Set([...(record.servers || []), guild.id]));
      saveData(data);

      // remove per-user permission overrides so they inherit default channel access
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
        saveData(data);
      }

      const member = await guild.members.fetch(message.author.id).catch(() => null);
      if (member && role) member.roles.add(role).catch(() => {});

      await message.channel.send({
        embeds: [
          boxEmbed({
            title: 'Veri.',
            description: 'You answered correctly and have been verified in the server.',
            footer: 'Veri.'
          })
        ]
      });

      await sendLog(guild, 'Veri. Verification Passed', `User ${message.author.id} passed verification via DM.`);

      captchaSessions.delete(message.author.id);
      return;
    } else {
      record.fails = (record.fails || 0) + 1;
      saveData(data);

      await sendLog(guild, 'Veri. Verification Failed', `User ${message.author.id} failed a verification attempt via DM.`);

      const { file, answer } = getRandomCaptcha();
      captchaSessions.set(message.author.id, { answer, guildId: session.guildId });

      return message.channel.send({
        embeds: [
          boxEmbed({
            title: 'Veri.',
            description: 'You failed the captcha. Try again.\nHere is a new captcha image.',
            footer: 'Veri.'
          })
        ],
        files: [path.join(__dirname, file)]
      });
    }
  }

  // guild messages
  if (!message.guild || message.author.bot) return;

  const guild = message.guild;
  const cfg = getGuildConfig(guild.id);

  if (
    cfg.honeypotEnabled &&
    cfg.honeypotChannelId &&
    message.channel.id === cfg.honeypotChannelId &&
    guild.channels.cache.has(cfg.honeypotChannelId) &&
    message.author.id !== OWNER_ID
  ) {
    const record = getUserRecord(message.author.id);
    record.honeypotTriggers = (record.honeypotTriggers || 0) + 1;
    saveData(data);

    await sendLog(guild, 'Veri. Honeypot Triggered', `User ${message.author.id} sent a message in the honeypot channel.`);

    const dm = await message.author.createDM().catch(() => null);
    if (dm) {
      await dm
        .send({
          embeds: [
            boxEmbed({
              title: 'Veri.',
              description:
                'You typed in a Veri. honeypot channel.\nThis channel exists solely to catch spam bots and malicious users.\n\nIf this was accidental, visit our website and email Veri. staff for assistance.',
              footer: 'Veri.'
            })
          ]
        })
        .catch(() => {});
    }

    const member = await guild.members.fetch(message.author.id).catch(() => null);
    const mode = cfg.honeypotMode || 'global_ban';

    if (mode === 'global_ban') {
      addToBlacklist(message.author.id);
      if (member) await member.ban({ reason: 'Veri. honeypot trigger (global ban)' }).catch(() => {});
    } else if (mode === 'server_ban') {
      if (member) await member.ban({ reason: 'Veri. honeypot trigger (server ban)' }).catch(() => {});
    } else if (mode === 'kick') {
      if (member) await member.kick('Veri. honeypot trigger (kick)').catch(() => {});
    }
    // warn and dm_only: DM already sent above

    return;
  }
});

client.login(BOT_TOKEN);
