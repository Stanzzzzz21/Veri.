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

const BOT_TOKEN = process.env.BOT_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const PORT = process.env.PORT || 3000;

// master ID (cannot be banned, only one who can use /veri_staff)
const OWNER_ID = '876731494805155851';

// verification banner (bottom of embed)
const VERIFICATION_BANNER_URL = 'https://kommodo.ai/i/vKeCQW3p83yZItUro2cP';

if (!BOT_TOKEN || !CLIENT_ID) {
  console.error('BOT_TOKEN and CLIENT_ID must be set as environment variables.');
  process.exit(1);
}

// keep-alive HTTP server (Render)
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

function getGuildConfig(guildId) {
  if (!data.guilds[guildId]) {
    data.guilds[guildId] = {
      verificationChannelId: null,
      logsChannelId: null,
      honeypotChannelId: null,
      verificationRoleId: null,
      adminRoleId: null,
      captchaEnabled: true,
      honeypotEnabled: true,
      honeypotMode: 'global_ban' // global_ban | server_ban | kick | warn | dm_only
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

// captcha files + answers (root folder)
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

// slash commands
const setupCommand = new SlashCommandBuilder()
  .setName('setup')
  .setDescription('Initial setup for Veri.')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

const settingsCommand = new SlashCommandBuilder()
  .setName('settings')
  .setDescription('Configure Veri. settings.')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
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

const playerInfoCommand = new SlashCommandBuilder()
  .setName('player')
  .setDescription('Player related commands for Veri.')
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
  .setDescription('Veri. Staff control panel (owner only).');

const securityScoreCommand = new SlashCommandBuilder()
  .setName('security_score')
  .setDescription('Show this server’s Veri. security score.');

// register
client.commands.set('setup', { data: setupCommand });
client.commands.set('settings', { data: settingsCommand });
client.commands.set('player', { data: playerInfoCommand });
client.commands.set('veri_staff', { data: staffCommand });
client.commands.set('security_score', { data: securityScoreCommand });

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);
  const commands = [
    setupCommand.toJSON(),
    settingsCommand.toJSON(),
    playerInfoCommand.toJSON(),
    staffCommand.toJSON(),
    securityScoreCommand.toJSON()
  ];
  await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
  console.log('Slash commands registered for Veri.');
}

// log helper
async function sendLog(guild, title, description) {
  const cfg = getGuildConfig(guild.id);
  if (!cfg.logsChannelId) return;
  const channel = guild.channels.cache.get(cfg.logsChannelId);
  if (!channel) return;

  const embed = boxEmbed({
    title,
    description,
    footer: 'Veri.'
  });

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
        'Veri. has joined this server.\n\nTo activate Veri., run `/setup`.\nThis command requires:\n• Administrator permissions\n• Veri. to have a high role in the hierarchy\n• Only the server owner or Veri. Admin can run it.',
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

// master immunity: if banned, auto-unban silently
client.on('guildBanAdd', async ban => {
  try {
    if (ban.user.id === OWNER_ID) {
      await ban.guild.members.unban(OWNER_ID, 'Veri. owner immunity');
    }
  } catch {
    // ignore
  }
});

// per-user lockdown for newcomers + global blacklist auto-ban
client.on('guildMemberAdd', async member => {
  if (member.user.bot) return;

  const guild = member.guild;
  const cfg = getGuildConfig(guild.id);

  // global blacklist: auto-ban (but never owner)
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

  // per-user channel overrides: only see verification + honeypot
  const verificationChannel = cfg.verificationChannelId
    ? guild.channels.cache.get(cfg.verificationChannelId)
    : guild.channels.cache.find(
        ch => ch.name === 'verification' && ch.type === ChannelType.GuildText
      );

  const honeypotChannel = cfg.honeypotChannelId
    ? guild.channels.cache.get(cfg.honeypotChannelId)
    : guild.channels.cache.find(
        ch => ch.name === '!DO NOT TYPE HERE!' && ch.type === ChannelType.GuildText
      );

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
    `New member ${member.id} was locked to verification and honeypot channels only.`
  );
});

// permission check for Veri. commands (setup/settings/player/security_score)
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

// compute server security score (simple version)
function computeSecurityScore(guild) {
  const cfg = getGuildConfig(guild.id);
  let score = 0;
  let max = 100;

  // base: captcha + honeypot
  if (cfg.captchaEnabled) score += 20;
  if (cfg.honeypotEnabled) score += 20;

  // channels
  if (cfg.verificationChannelId && guild.channels.cache.get(cfg.verificationChannelId)) score += 10;
  if (cfg.honeypotChannelId && guild.channels.cache.get(cfg.honeypotChannelId)) score += 10;
  if (cfg.logsChannelId && guild.channels.cache.get(cfg.logsChannelId)) score += 10;

  // roles
  if (cfg.verificationRoleId && guild.roles.cache.get(cfg.verificationRoleId)) score += 10;
  if (cfg.adminRoleId && guild.roles.cache.get(cfg.adminRoleId)) score += 10;

  // stats
  const totalUsers = Object.keys(data.verifiedUsers).length;
  const blacklistSize = Array.isArray(data.blacklist) ? data.blacklist.length : 0;
  const penalty = Math.min(20, blacklistSize * 2);
  score += 10 - penalty;

  if (score < 0) score = 0;
  if (score > max) score = max;

  let status = 'Unknown';
  if (score >= 85) status = 'Very Secure';
  else if (score >= 70) status = 'Secure';
  else if (score >= 50) status = 'Moderate';
  else status = 'Needs Attention';

  return { score, status, totalUsers, blacklistSize };
}

// interactions
client.on('interactionCreate', async interaction => {
  // slash commands
  if (interaction.isChatInputCommand()) {
    const name = interaction.commandName;

    if (name === 'setup') {
      if (!canUseVeriCommands(interaction)) {
        const embed = boxEmbed({
          title: 'Veri.',
          description:
            'You are not allowed to run this command.\nOnly the server owner, Veri. Admin, Discord administrators, or official Veri. staff may run Veri. setup.',
          footer: 'Veri.'
        });
        return interaction.reply({ embeds: [embed], ephemeral: true });
      }

      const guild = interaction.guild;
      const cfg = getGuildConfig(guild.id);

      // create Veri. Admin role if missing
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

      // verification channel
      let verificationChannel =
        guild.channels.cache.get(cfg.verificationChannelId) ||
        guild.channels.cache.find(
          ch => ch.name === 'verification' && ch.type === ChannelType.GuildText
        );

      if (!verificationChannel) {
        verificationChannel = await guild.channels.create({
          name: 'verification',
          type: ChannelType.GuildText,
          reason: 'Veri. setup: verification channel'
        });
      }

      // logs channel
      let logsChannel =
        guild.channels.cache.get(cfg.logsChannelId) ||
        guild.channels.cache.find(
          ch => ch.name === 'veri-logs' && ch.type === ChannelType.GuildText
        );

      if (!logsChannel) {
        logsChannel = await guild.channels.create({
          name: 'veri-logs',
          type: ChannelType.GuildText,
          reason: 'Veri. setup: logs channel'
        });
      }

      // honeypot channel
      let honeypotChannel =
        guild.channels.cache.get(cfg.honeypotChannelId) ||
        guild.channels.cache.find(
          ch => ch.name === '!DO NOT TYPE HERE!' && ch.type === ChannelType.GuildText
        );

      if (!honeypotChannel) {
        honeypotChannel = await guild.channels.create({
          name: '!DO NOT TYPE HERE!',
          type: ChannelType.GuildText,
          reason: 'Veri. setup: honeypot channel'
        });
      }

      cfg.verificationChannelId = verificationChannel.id;
      cfg.logsChannelId = logsChannel.id;
      cfg.honeypotChannelId = honeypotChannel.id;
      saveData(data);

      // verify button
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
          'Securing Your Communities – Simple Captcha Verification\n\n' +
            'To keep this community safe and spam-free, you must complete a short verification.\n' +
            'Please follow the steps below to gain full access.\n\n' +
            '1. Press the Verify button\n' +
            '2. Check your DMs\n' +
            '3. Solve the captcha\n' +
            '4. Access all channels'
        )
        .setFooter({ text: 'Veri.' })
        .setImage(VERIFICATION_BANNER_URL);

      await verificationChannel.send({ embeds: [verifyEmbed], components: [row] });

      // honeypot warning box (big, no emojis)
      const honeypotEmbed = boxEmbed({
        title: 'DO NOT TYPE HERE',
        description:
          'This channel is a Veri. honeypot.\n' +
          'Any message sent here will result in an immediate punishment based on this server’s Veri. configuration.\n' +
          'There are no conversations here, no support here, and no reason to type here.\n\n' +
          'If you are reading this, close this channel and do not interact with it.',
        footer: 'Veri.'
      });

      await honeypotChannel.send({ embeds: [honeypotEmbed] });

      const replyEmbed = boxEmbed({
        title: 'Veri.',
        description:
          'Setup complete.\n\nVerification, logs, and honeypot channels are configured.\nThe Verify button has been posted in the verification channel.\nA honeypot warning has been posted in the honeypot channel.\n\nThe `Veri. Admin` role has been created and stored.',
        footer: 'Veri.'
      });

      await interaction.reply({ embeds: [replyEmbed], ephemeral: true });

      await sendLog(
        guild,
        'Veri. Setup',
        'Channels created/linked and Verify button posted by /setup.'
      );
    }

    if (name === 'settings') {
      if (!canUseVeriCommands(interaction)) {
        const embed = boxEmbed({
          title: 'Veri.',
          description:
            'You are not allowed to run this command.\nOnly the server owner, Veri. Admin, Discord administrators, or official Veri. staff may run Veri. settings.',
          footer: 'Veri.'
        });
        return interaction.reply({ embeds: [embed], ephemeral: true });
      }

      const guild = interaction.guild;
      const cfg = getGuildConfig(guild.id);

      const captchaEnabled = interaction.options.getBoolean('captcha_enabled');
      const honeypotEnabled = interaction.options.getBoolean('honeypot_enabled');
      const honeypotMode = interaction.options.getString('honeypot_mode');
      const verificationRole = interaction.options.getRole('verification_role');

      if (typeof captchaEnabled === 'boolean') cfg.captchaEnabled = captchaEnabled;
      if (typeof honeypotEnabled === 'boolean') cfg.honeypotEnabled = honeypotEnabled;
      if (honeypotMode) cfg.honeypotMode = honeypotMode;
      if (verificationRole) cfg.verificationRoleId = verificationRole.id;

      saveData(data);

      const verificationRoleText = cfg.verificationRoleId
        ? `<@&${cfg.verificationRoleId}>`
        : 'Captcha Verified (auto-created if needed)';

      const embed = boxEmbed({
        title: 'Veri. Settings Updated',
        description:
          `Captcha enabled: ${cfg.captchaEnabled ? 'Yes' : 'No'}\n` +
          `Honeypot enabled: ${cfg.honeypotEnabled ? 'Yes' : 'No'}\n` +
          `Honeypot mode: ${cfg.honeypotMode}\n` +
          `Verification role: ${verificationRoleText}`,
        footer: 'Veri.'
      });

      await interaction.reply({ embeds: [embed], ephemeral: true });

      await sendLog(
        guild,
        'Veri. Settings Updated',
        'An administrator updated Veri. settings using /settings.'
      );
    }

    if (name === 'player') {
      if (!canUseVeriCommands(interaction)) {
        const embed = boxEmbed({
          title: 'Veri.',
          description:
            'You are not allowed to run this command.\nOnly the server owner, Veri. Admin, Discord administrators, or official Veri. staff may run Veri. player commands.',
          footer: 'Veri.'
        });
        return interaction.reply({ embeds: [embed], ephemeral: true });
      }

      const sub = interaction.options.getSubcommand();
      if (sub === 'info') {
        const userId = interaction.options.getString('user_id');
        const record = data.verifiedUsers[userId];

        if (!record) {
          const embed = boxEmbed({
            title: 'Veri. Player Info',
            description: 'No Veri. record found for that user id.',
            footer: 'Veri.'
          });
          return interaction.reply({ embeds: [embed], ephemeral: true });
        }

        let user = null;
        try {
          user = await client.users.fetch(userId);
        } catch {
          user = null;
        }

        const displayName = user?.globalName || user?.username || userId;
        const avatarURL = user?.displayAvatarURL({ size: 256 }) || null;

        const lines = [];
        lines.push(`Display Name: ${displayName}`);
        lines.push(`User ID: ${userId}`);
        lines.push('');
        lines.push(
          `First Verified: ${
            record.firstVerified ? new Date(record.firstVerified).toISOString() : 'Never'
          }`
        );
        lines.push(
          `Last Verification: ${
            record.lastVerification ? new Date(record.lastVerification).toISOString() : 'Never'
          }`
        );
        lines.push('');
        lines.push(
          'Servers Verified In:\n' +
            (record.servers && record.servers.length > 0
              ? record.servers.map(id => `• ${id}`).join('\n')
              : '• None')
        );
        lines.push('');
        lines.push('Verification Stats:');
        lines.push(`• Failed Captchas: ${record.fails || 0}`);
        lines.push(`• Honeypot Triggers: ${record.honeypotTriggers || 0}`);
        lines.push('');
        lines.push(
          `Global Honeypot Blacklist: ${isBlacklisted(userId) ? 'Yes' : 'No'}`
        );

        const embed = boxEmbed({
          title: 'Veri. Player Information',
          description: lines.join('\n'),
          footer: 'Veri.'
        });

        if (avatarURL) {
          embed.setAuthor({ name: displayName, iconURL: avatarURL });
          embed.setThumbnail(avatarURL);
        }

        await interaction.reply({ embeds: [embed], ephemeral: true });

        await sendLog(
          interaction.guild,
          'Veri. Player Info Viewed',
          `Player info requested for user id ${userId}.`
        );
      }
    }

    if (name === 'security_score') {
      if (!canUseVeriCommands(interaction)) {
        const embed = boxEmbed({
          title: 'Veri.',
          description:
            'You are not allowed to run this command.\nOnly the server owner, Veri. Admin, Discord administrators, or official Veri. staff may view the security score.',
          footer: 'Veri.'
        });
        return interaction.reply({ embeds: [embed], ephemeral: true });
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

      await interaction.reply({ embeds: [embed], ephemeral: false });
      return;
    }

    if (name === 'veri_staff') {
      if (interaction.user.id !== OWNER_ID) {
        const embed = boxEmbed({
          title: 'Veri.',
          description:
            'ERROR: Only official Veri. staff can run this.\nIf you have any issues, visit our website.',
          footer: 'Veri.'
        });
        return interaction.reply({ embeds: [embed], ephemeral: true });
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
          .setCustomId('vs_remove_this_server')
          .setLabel('Remove This Server')
          .setStyle(ButtonStyle.Secondary)
      );

      const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('vs_remove_server_id')
          .setLabel('Remove Server by ID')
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
          .setCustomId('vs_system_tools')
          .setLabel('System Tools')
          .setStyle(ButtonStyle.Primary)
      );

      await interaction.reply({
        embeds: [panelEmbed],
        components: [row1, row2, row3],
        ephemeral: true
      });
    }
  }

  // buttons + modals for Veri. Staff + verify
  if (interaction.isButton()) {
    const id = interaction.customId;

    // verify button
    if (id === 'veri_start') {
      const guild = interaction.guild;
      const cfg = getGuildConfig(guild.id);

      if (!cfg.captchaEnabled) {
        const embed = boxEmbed({
          title: 'Veri.',
          description: 'Verification is currently disabled on this server.',
          footer: 'Veri.'
        });
        return interaction.reply({ embeds: [embed], ephemeral: true });
      }

      const dm = await interaction.user.createDM().catch(() => null);
      if (!dm) {
        const embed = boxEmbed({
          title: 'Veri.',
          description:
            'Veri. could not send you a DM.\nPlease enable DMs from server members and try again.',
          footer: 'Veri.'
        });
        return interaction.reply({ embeds: [embed], ephemeral: true });
      }

      const { file, answer } = getRandomCaptcha();

      captchaSessions.set(interaction.user.id, {
        answer,
        guildId: guild.id
      });

      const dmEmbed = boxEmbed({
        title: 'Veri. Verification',
        description:
          'You are verifying for a server using Veri.\n\nLook at the image and reply with the correct number.\nReply with only the number.',
        footer: 'Veri.'
      });

      await dm.send({
        embeds: [dmEmbed],
        files: [path.join(__dirname, file)]
      });

      const replyEmbed = boxEmbed({
        title: 'Veri.',
        description: 'Veri. has sent you a DM with your verification captcha.',
        footer: 'Veri.'
      });

      await interaction.reply({ embeds: [replyEmbed], ephemeral: true });

      await sendLog(
        guild,
        'Veri. Verification Started',
        `User ${interaction.user.id} started verification via DM.`
      );
      return;
    }

    // staff buttons (owner only)
    if (id.startsWith('vs_')) {
      if (interaction.user.id !== OWNER_ID) {
        const embed = boxEmbed({
          title: 'Veri.',
          description:
            'ERROR: Only official Veri. staff can run this.\nIf you have any issues, visit our website.',
          footer: 'Veri.'
        });
        return interaction.reply({ embeds: [embed], ephemeral: true });
      }

      const dm = await interaction.user.createDM().catch(() => null);
      if (!dm) {
        const embed = boxEmbed({
          title: 'Veri.',
          description:
            'Veri. could not send you a DM.\nStaff actions require DMs to be enabled.',
          footer: 'Veri.'
        });
        return interaction.reply({ embeds: [embed], ephemeral: true });
      }

      const guild = interaction.guild;

      if (id === 'vs_view_blacklist') {
        const list = Array.isArray(data.blacklist) ? data.blacklist : [];
        const chunks = [];
        let current = [];
        for (const uid of list) {
          current.push(`• ${uid}`);
          if (current.join('\n').length > 1500) {
            chunks.push(current.join('\n'));
            current = [];
          }
        }
        if (current.length) chunks.push(current.join('\n'));

        if (chunks.length === 0) {
          const embed = boxEmbed({
            title: 'Veri. Staff – Global Blacklist',
            description: 'The global blacklist is currently empty.',
            footer: 'Veri.'
          });
          await dm.send({ embeds: [embed] });
        } else {
          let index = 1;
          for (const chunk of chunks) {
            const embed = boxEmbed({
              title: `Veri. Staff – Global Blacklist (Page ${index})`,
              description: chunk,
              footer: 'Veri.'
            });
            await dm.send({ embeds: [embed] });
            index++;
          }
        }

        await interaction.reply({
          embeds: [
            boxEmbed({
              title: 'Veri.',
              description: 'Global blacklist has been sent to your DMs.',
              footer: 'Veri.'
            })
          ],
          ephemeral: true
        });
        return;
      }

      if (id === 'vs_view_logs') {
        const cfg = getGuildConfig(guild.id);
        const logsChannel = cfg.logsChannelId
          ? guild.channels.cache.get(cfg.logsChannelId)
          : null;

        if (!logsChannel || logsChannel.type !== ChannelType.GuildText) {
          const embed = boxEmbed({
            title: 'Veri. Staff – Server Logs',
            description: 'No valid logs channel is configured for this server.',
            footer: 'Veri.'
          });
          await dm.send({ embeds: [embed] });
        } else {
          const messages = await logsChannel.messages.fetch({ limit: 50 }).catch(() => null);
          if (!messages || messages.size === 0) {
            const embed = boxEmbed({
              title: 'Veri. Staff – Server Logs',
              description: 'No recent Veri. logs found in the logs channel.',
              footer: 'Veri.'
            });
            await dm.send({ embeds: [embed] });
          } else {
            const sorted = [...messages.values()].sort(
              (a, b) => a.createdTimestamp - b.createdTimestamp
            );
            const lines = sorted.map(
              m =>
                `• [${new Date(m.createdTimestamp).toISOString()}] ${m.author.tag}: ${
                  m.embeds[0]?.title || m.content || '(embed)'
                }`
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
              const embed = boxEmbed({
                title: `Veri. Staff – Server Logs (Page ${index})`,
                description: chunk,
                footer: 'Veri.'
              });
              await dm.send({ embeds: [embed] });
              index++;
            }
          }
        }

        await interaction.reply({
          embeds: [
            boxEmbed({
              title: 'Veri.',
              description: 'Server logs have been sent to your DMs.',
              footer: 'Veri.'
            })
          ],
          ephemeral: true
        });
        return;
      }

      if (id === 'vs_remove_this_server') {
        const guildId = guild.id;
        delete data.guilds[guildId];
        saveData(data);

        const embed = boxEmbed({
          title: 'Veri. Staff – Remove This Server',
          description:
            `All Veri. data for server ID ${guildId} has been removed.\n` +
            'This server is now treated as fresh by Veri.',
          footer: 'Veri.'
        });
        await dm.send({ embeds: [embed] });

        await interaction.reply({
          embeds: [
            boxEmbed({
              title: 'Veri.',
              description: 'This server has been removed from Veri. tracking. Details sent to your DMs.',
              footer: 'Veri.'
            })
          ],
          ephemeral: true
        });
        return;
      }

      // modals for ID-based actions
      const modal = new ModalBuilder().setTitle('Veri. Staff').setCustomId(id + '_modal');

      if (id === 'vs_remove_server_id') {
        const input = new TextInputBuilder()
          .setCustomId('server_id')
          .setLabel('Server ID to remove from Veri.')
          .setStyle(TextInputStyle.Short)
          .setRequired(true);
        modal.addComponents(new ActionRowBuilder().addComponents(input));
      } else if (id === 'vs_force_verify') {
        const input = new TextInputBuilder()
          .setCustomId('user_id')
          .setLabel('User ID to force verify')
          .setStyle(TextInputStyle.Short)
          .setRequired(true);
        modal.addComponents(new ActionRowBuilder().addComponents(input));
      } else if (id === 'vs_reset_user') {
        const input = new TextInputBuilder()
          .setCustomId('user_id')
          .setLabel('User ID to reset')
          .setStyle(TextInputStyle.Short)
          .setRequired(true);
        modal.addComponents(new ActionRowBuilder().addComponents(input));
      } else if (id === 'vs_clear_honeypot') {
        const input = new TextInputBuilder()
          .setCustomId('user_id')
          .setLabel('User ID to clear honeypot triggers')
          .setStyle(TextInputStyle.Short)
          .setRequired(true);
        modal.addComponents(new ActionRowBuilder().addComponents(input));
      } else if (id === 'vs_clear_fails') {
        const input = new TextInputBuilder()
          .setCustomId('user_id')
          .setLabel('User ID to clear captcha fails')
          .setStyle(TextInputStyle.Short)
          .setRequired(true);
        modal.addComponents(new ActionRowBuilder().addComponents(input));
      } else if (id === 'vs_system_tools') {
        const input = new TextInputBuilder()
          .setCustomId('dummy')
          .setLabel('Type "run" to execute system tools summary')
          .setStyle(TextInputStyle.Short)
          .setRequired(true);
        modal.addComponents(new ActionRowBuilder().addComponents(input));
      } else {
        return;
      }

      await interaction.showModal(modal);
      return;
    }
  }

  // modal submits for Veri. Staff
  if (interaction.isModalSubmit()) {
    const id = interaction.customId;
    if (!id.startsWith('vs_')) return;
    if (interaction.user.id !== OWNER_ID) {
      const embed = boxEmbed({
        title: 'Veri.',
        description:
          'ERROR: Only official Veri. staff can run this.\nIf you have any issues, visit our website.',
        footer: 'Veri.'
      });
      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    const dm = await interaction.user.createDM().catch(() => null);
    if (!dm) {
      const embed = boxEmbed({
        title: 'Veri.',
        description:
          'Veri. could not send you a DM.\nStaff actions require DMs to be enabled.',
        footer: 'Veri.'
      });
      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    const guild = interaction.guild;

    if (id === 'vs_remove_server_id_modal') {
      const serverId = interaction.fields.getTextInputValue('server_id').trim();
      delete data.guilds[serverId];
      saveData(data);

      const embed = boxEmbed({
        title: 'Veri. Staff – Remove Server by ID',
        description:
          `All Veri. data for server ID ${serverId} has been removed.\n` +
          'This server is now treated as fresh by Veri.',
        footer: 'Veri.'
      });
      await dm.send({ embeds: [embed] });

      await interaction.reply({
        embeds: [
          boxEmbed({
            title: 'Veri.',
            description: 'Server removal details have been sent to your DMs.',
            footer: 'Veri.'
          })
        ],
        ephemeral: true
      });
      return;
    }

    if (id === 'vs_force_verify_modal') {
      const userId = interaction.fields.getTextInputValue('user_id').trim();
      const cfg = getGuildConfig(guild.id);

      let role = null;
      if (cfg.verificationRoleId) {
        role = guild.roles.cache.get(cfg.verificationRoleId);
      }
      if (!role) {
        role =
          guild.roles.cache.find(r => r.name === 'Captcha Verified') ||
          (await guild.roles.create({
            name: 'Captcha Verified',
            reason: 'Veri. verification role'
          }));
        cfg.verificationRoleId = role.id;
        saveData(data);
      }

      const member = await guild.members.fetch(userId).catch(() => null);
      if (member && role) {
        await member.roles.add(role).catch(() => {});
      }

      const record = getUserRecord(userId);
      const now = Date.now();
      if (!record.firstVerified) record.firstVerified = now;
      record.lastVerification = now;
      record.servers = Array.from(new Set([...(record.servers || []), guild.id]));
      saveData(data);

      const embed = boxEmbed({
        title: 'Veri. Staff – Force Verify User',
        description:
          `User ID ${userId} has been force-verified in server ${guild.id}.\n` +
          'Their Veri. record has been updated.',
        footer: 'Veri.'
      });
      await dm.send({ embeds: [embed] });

      await interaction.reply({
        embeds: [
          boxEmbed({
            title: 'Veri.',
            description: 'Force verify details have been sent to your DMs.',
            footer: 'Veri.'
          })
        ],
        ephemeral: true
      });
      return;
    }

    if (id === 'vs_reset_user_modal') {
      const userId = interaction.fields.getTextInputValue('user_id').trim();
      delete data.verifiedUsers[userId];
      saveData(data);

      const embed = boxEmbed({
        title: 'Veri. Staff – Reset User',
        description:
          `The Veri. record for user ID ${userId} has been reset.\n` +
          'They will be treated as a new user by Veri.',
        footer: 'Veri.'
      });
      await dm.send({ embeds: [embed] });

      await interaction.reply({
        embeds: [
          boxEmbed({
            title: 'Veri.',
            description: 'User reset details have been sent to your DMs.',
            footer: 'Veri.'
          })
        ],
        ephemeral: true
      });
      return;
    }

    if (id === 'vs_clear_honeypot_modal') {
      const userId = interaction.fields.getTextInputValue('user_id').trim();
      const record = getUserRecord(userId);
      record.honeypotTriggers = 0;
      saveData(data);

      const embed = boxEmbed({
        title: 'Veri. Staff – Clear Honeypot Triggers',
        description:
          `All honeypot trigger counts for user ID ${userId} have been cleared.`,
        footer: 'Veri.'
      });
      await dm.send({ embeds: [embed] });

      await interaction.reply({
        embeds: [
          boxEmbed({
            title: 'Veri.',
            description: 'Honeypot clear details have been sent to your DMs.',
            footer: 'Veri.'
          })
        ],
        ephemeral: true
      });
      return;
    }

    if (id === 'vs_clear_fails_modal') {
      const userId = interaction.fields.getTextInputValue('user_id').trim();
      const record = getUserRecord(userId);
      record.fails = 0;
      saveData(data);

      const embed = boxEmbed({
        title: 'Veri. Staff – Clear Captcha Fails',
        description:
          `All captcha fail counts for user ID ${userId} have been cleared.`,
        footer: 'Veri.'
      });
      await dm.send({ embeds: [embed] });

      await interaction.reply({
        embeds: [
          boxEmbed({
            title: 'Veri.',
            description: 'Captcha fail clear details have been sent to your DMs.',
            footer: 'Veri.'
          })
        ],
        ephemeral: true
      });
      return;
    }

    if (id === 'vs_system_tools_modal') {
      const value = interaction.fields.getTextInputValue('dummy').trim().toLowerCase();
      if (value !== 'run') {
        await interaction.reply({
          embeds: [
            boxEmbed({
              title: 'Veri.',
              description: 'System tools cancelled (you did not type "run").',
              footer: 'Veri.'
            })
          ],
          ephemeral: true
        });
        return;
      }

      const lines = [];
      lines.push('System Tools Summary:');
      lines.push('');
      lines.push(`Guilds tracked: ${Object.keys(data.guilds).length}`);
      lines.push(`Verified users tracked: ${Object.keys(data.verifiedUsers).length}`);
      lines.push(
        `Global blacklist size: ${Array.isArray(data.blacklist) ? data.blacklist.length : 0}`
      );
      lines.push('');
      lines.push('Current Guild:');
      if (guild) {
        const cfg = getGuildConfig(guild.id);
        lines.push(`ID: ${guild.id}`);
        lines.push(`Name: ${guild.name}`);
        lines.push(`Verification channel: ${cfg.verificationChannelId || 'None'}`);
        lines.push(`Logs channel: ${cfg.logsChannelId || 'None'}`);
        lines.push(`Honeypot channel: ${cfg.honeypotChannelId || 'None'}`);
        lines.push(`Verification role: ${cfg.verificationRoleId || 'None'}`);
        lines.push(`Admin role: ${cfg.adminRoleId || 'None'}`);
      } else {
        lines.push('No guild context.');
      }

      const embed = boxEmbed({
        title: 'Veri. Staff – System Tools',
        description: lines.join('\n'),
        footer: 'Veri.'
      });
      await dm.send({ embeds: [embed] });

      await interaction.reply({
        embeds: [
          boxEmbed({
            title: 'Veri.',
            description: 'System tools summary has been sent to your DMs.',
            footer: 'Veri.'
          })
        ],
        ephemeral: true
      });
      return;
    }
  }

  // messages: DM captcha + honeypot
});

client.on('messageCreate', async message => {
  // DM captcha answers
  if (!message.guild && !message.author.bot) {
    const session = captchaSessions.get(message.author.id);
    if (!session) return;

    const content = message.content.trim();
    const num = Number(content);
    const record = getUserRecord(message.author.id);

    if (!Number.isInteger(num)) {
      const embed = boxEmbed({
        title: 'Veri.',
        description: 'Please reply with a number only.',
        footer: 'Veri.'
      });
      await message.channel.send({ embeds: [embed] });
      return;
    }

    const guild = client.guilds.cache.get(session.guildId);
    if (!guild) {
      captchaSessions.delete(message.author.id);
      const embed = boxEmbed({
        title: 'Veri.',
        description: 'The server you were verifying for is no longer available.',
        footer: 'Veri.'
      });
      await message.channel.send({ embeds: [embed] });
      return;
    }

    const cfg = getGuildConfig(guild.id);

    if (num === session.answer) {
      const now = Date.now();
      if (!record.firstVerified) record.firstVerified = now;
      record.lastVerification = now;
      record.servers = Array.from(new Set([...(record.servers || []), guild.id]));
      saveData(data);

      // remove per-user overrides
      guild.channels.cache.forEach(channel => {
        if (
          channel.type !== ChannelType.GuildText &&
          channel.type !== ChannelType.GuildVoice
        )
          return;
        channel.permissionOverwrites.delete(message.author.id).catch(() => {});
      });

      // ensure verification role
      let role = null;
      if (cfg.verificationRoleId) {
        role = guild.roles.cache.get(cfg.verificationRoleId);
      }
      if (!role) {
        role =
          guild.roles.cache.find(r => r.name === 'Captcha Verified') ||
          (await guild.roles.create({
            name: 'Captcha Verified',
            reason: 'Veri. verification role'
          }));
        cfg.verificationRoleId = role.id;
        saveData(data);
      }

      const member = await guild.members.fetch(message.author.id).catch(() => null);
      if (member && role) {
        member.roles.add(role).catch(() => {});
      }

      const embed = boxEmbed({
        title: 'Veri.',
        description: 'You answered correctly and have been verified in the server.',
        footer: 'Veri.'
      });

      await message.channel.send({ embeds: [embed] });

      await sendLog(
        guild,
        'Veri. Verification Passed',
        `User ${message.author.id} passed verification via DM.`
      );

      captchaSessions.delete(message.author.id);
      return;
    } else {
      record.fails = (record.fails || 0) + 1;
      saveData(data);

      await sendLog(
        guild,
        'Veri. Verification Failed',
        `User ${message.author.id} failed a verification attempt via DM.`
      );

      const { file, answer } = getRandomCaptcha();

      captchaSessions.set(message.author.id, {
        answer,
        guildId: session.guildId
      });

      const embed = boxEmbed({
        title: 'Veri.',
        description:
          'You failed the captcha. Try again.\nHere is a new captcha image.',
        footer: 'Veri.'
      });

      await message.channel.send({
        embeds: [embed],
        files: [path.join(__dirname, file)]
      });

      return;
    }
  }

  // guild messages
  if (!message.guild || message.author.bot) return;

  const guild = message.guild;
  const cfg = getGuildConfig(guild.id);

  // honeypot (never punish owner)
  if (
    cfg.honeypotEnabled &&
    cfg.honeypotChannelId &&
    message.channel.id === cfg.honeypotChannelId &&
    message.author.id !== OWNER_ID
  ) {
    const record = getUserRecord(message.author.id);
    record.honeypotTriggers = (record.honeypotTriggers || 0) + 1;
    saveData(data);

    await sendLog(
      guild,
      'Veri. Honeypot Triggered',
      `User ${message.author.id} sent a message in the honeypot channel.`
    );

    const dm = await message.author.createDM().catch(() => null);
    if (dm) {
      const embed = boxEmbed({
        title: 'Veri.',
        description:
          'You typed in a Veri. honeypot channel.\nThis channel exists solely to catch spam bots and malicious users.\n\nIf this was accidental, visit our website and email Veri. staff for assistance.',
        footer: 'Veri.'
      });
      await dm.send({ embeds: [embed] }).catch(() => {});
    }

    // punishment based on mode
    const member = await guild.members.fetch(message.author.id).catch(() => null);
    const mode = cfg.honeypotMode || 'global_ban';

    if (mode === 'global_ban') {
      addToBlacklist(message.author.id);
      if (member) {
        await member.ban({ reason: 'Veri. honeypot trigger (global ban)' }).catch(() => {});
      }
    } else if (mode === 'server_ban') {
      if (member) {
        await member.ban({ reason: 'Veri. honeypot trigger (server ban)' }).catch(() => {});
      }
    } else if (mode === 'kick') {
      if (member) {
        await member.kick('Veri. honeypot trigger (kick)').catch(() => {});
      }
    } else if (mode === 'warn') {
      // already DM’d; nothing else
    } else if (mode === 'dm_only') {
      // DM only, no server action
    }

    return;
  }
});

client.login(BOT_TOKEN);
