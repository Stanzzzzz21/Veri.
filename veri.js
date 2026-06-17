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

if (!BOT_TOKEN || !CLIENT_ID) {
  console.error('BOT_TOKEN and CLIENT_ID must be set as environment variables.');
  process.exit(1);
}

// keep-alive HTTP server (Render)
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

// green theme
const THEME_COLOR = 0x00c853;

// boxed embed helper
function boxEmbed({ title, description, fields = [], footer }) {
  const embed = new EmbedBuilder()
    .setColor(THEME_COLOR)
    .setTitle(title || 'Veri')
    .setDescription(description || '');

  if (fields.length > 0) embed.addFields(fields);
  if (footer) embed.setFooter({ text: footer });

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

const settingsCommand = new SlashCommandBuilder()
  .setName('settings')
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

client.commands.set('setup', { data: setupCommand });
client.commands.set('settings', { data: settingsCommand });
client.commands.set('player', { data: playerInfoCommand });

// register commands
async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);
  const commands = [
    setupCommand.toJSON(),
    settingsCommand.toJSON(),
    playerInfoCommand.toJSON()
  ];
  await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
  console.log('Slash commands registered.');
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
    footer: 'Veri System'
  });

  channel.send({ embeds: [embed] }).catch(() => {});
}

// honeypot punishment
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

// on join: hi message, delete after 5 minutes
client.on('guildCreate', async guild => {
  try {
    const systemChannel =
      guild.systemChannel ||
      guild.channels.cache.find(
        c =>
          c.type === ChannelType.GuildText &&
          c.permissionsFor(guild.members.me).has('SendMessages')
      );

    if (!systemChannel) return;

    const embed = boxEmbed({
      title: 'Veri Joined',
      description:
        'Hi, I am **Veri**.\n\nI provide DM-based captcha verification and honeypot protection for your server.\n\nRun `/setup` to create the verification, logs, and honeypot channels automatically.',
      footer: 'Veri System'
    });

    const msg = await systemChannel.send({ embeds: [embed] });
    setTimeout(() => {
      msg.delete().catch(() => {});
    }, 5 * 60 * 1000);
  } catch {
    // ignore
  }
});

// auto-verify if globally verified
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

    const embed = boxEmbed({
      title: 'Veri Auto Verification',
      description:
        'You were already verified using Veri in another server.\nYou have been verified here automatically.',
      footer: 'Veri System'
    });

    member.send({ embeds: [embed] }).catch(() => {});

    await sendLog(
      member.guild,
      'Auto Verification',
      `User ${member.id} was auto-verified based on global Veri record.`
    );
  }
});

// interactions
client.on('interactionCreate', async interaction => {
  if (interaction.isChatInputCommand()) {
    const name = interaction.commandName;

    if (name === 'setup') {
      const member = interaction.member;
      if (!member.permissions.has(PermissionFlagsBits.Administrator)) {
        const embed = boxEmbed({
          title: 'Permission Denied',
          description: 'You must be an administrator to use this command.',
          footer: 'Veri System'
        });
        return interaction.reply({ embeds: [embed], ephemeral: true });
      }

      const guild = interaction.guild;
      const cfg = getGuildConfig(guild.id);

      // create channels automatically
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

      const verifyEmbed = boxEmbed({
        title: 'Verification',
        description:
          'Press the button below to start verification.\nYou will receive a DM with your captcha.\n\nIn this channel you will only see a message telling you to check your DMs.',
        footer: 'Veri System'
      });

      await verificationChannel.send({ embeds: [verifyEmbed], components: [row] });

      const replyEmbed = boxEmbed({
        title: 'Setup Complete',
        description:
          'Verification, logs, and honeypot channels have been created.\nThe Verify button has been posted in the verification channel.',
        footer: 'Veri System'
      });

      await interaction.reply({ embeds: [replyEmbed], ephemeral: true });

      const welcome = boxEmbed({
        title: 'Veri Enabled',
        description:
          'Welcome to Veri.\n\nThis bot provides DM-based captcha verification and honeypot protection.\n\nCommands:\n• `/setup` – create channels and Verify button\n• `/settings` – adjust Veri settings\n• `/player info` – view a user’s Veri record',
        footer: 'Veri System'
      });
      await logsChannel.send({ embeds: [welcome] });

      await sendLog(
        guild,
        'Setup Completed',
        'Channels created and Verify button posted by /setup.'
      );
    }

    if (name === 'settings') {
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

      const embed = boxEmbed({
        title: 'Settings Updated',
        description:
          `Veri settings have been updated.\n\nHoneypot punishment: **${cfg.honeypotPunishment}**\nTimeout minutes: **${cfg.honeypotTimeoutMinutes}**\nCaptcha enabled: **${cfg.captchaEnabled ? 'Yes' : 'No'}**\nHoneypot enabled: **${cfg.honeypotEnabled ? 'Yes' : 'No'}**`,
        footer: 'Veri System'
      });

      await interaction.reply({ embeds: [embed], ephemeral: true });

      await sendLog(
        guild,
        'Settings Updated',
        'An administrator updated Veri settings using /settings.'
      );
    }

    if (name === 'player') {
      const sub = interaction.options.getSubcommand();
      if (sub === 'info') {
        const userId = interaction.options.getString('user_id');
        const record = data.verifiedUsers[userId];

        if (!record) {
          const embed = boxEmbed({
            title: 'Player Info',
            description: 'No Veri record found for that user id.',
            footer: 'Veri System'
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

        const embed = boxEmbed({
          title: 'Player Information',
          description: lines.join('\n'),
          footer: 'Veri System'
        });

        if (avatarURL) {
          embed.setAuthor({ name: displayName, iconURL: avatarURL });
          embed.setThumbnail(avatarURL);
        }

        await interaction.reply({ embeds: [embed], ephemeral: true });

        await sendLog(
          interaction.guild,
          'Player Info Viewed',
          `Player info requested for user id ${userId}.`
        );
      }
    }
  }

  // verify button
  if (interaction.isButton()) {
    if (interaction.customId === 'veri_start') {
      const guild = interaction.guild;
      const cfg = getGuildConfig(guild.id);

      if (!cfg.captchaEnabled) {
        const embed = boxEmbed({
          title: 'Verification Disabled',
          description: 'Verification is currently disabled on this server.',
          footer: 'Veri System'
        });
        return interaction.reply({ embeds: [embed], ephemeral: true });
      }

      const dm = await interaction.user.createDM().catch(() => null);
      if (!dm) {
        const embed = boxEmbed({
          title: 'DM Failed',
          description:
            'I could not send you a DM. Please enable DMs from server members and try again.',
          footer: 'Veri System'
        });
        return interaction.reply({ embeds: [embed], ephemeral: true });
      }

      const { file, answer } = getRandomCaptcha();

      captchaSessions.set(interaction.user.id, {
        answer,
        guildId: guild.id
      });

      const dmEmbed = boxEmbed({
        title: 'Veri Verification',
        description:
          'You are verifying for a server using Veri.\n\nLook at the image and reply with the correct number.\nReply with **only the number**.',
        footer: 'Veri System'
      });

      await dm.send({
        embeds: [dmEmbed],
        files: [path.join(__dirname, file)]
      });

      const replyEmbed = boxEmbed({
        title: 'Check Your DMs',
        description: 'I have sent you a DM with your verification captcha.',
        footer: 'Veri System'
      });

      await interaction.reply({ embeds: [replyEmbed], ephemeral: true });

      await sendLog(
        guild,
        'Verification Started',
        `User ${interaction.user.id} started verification via DM.`
      );
    }
  }
});

// messages: DM captcha + honeypot
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
        title: 'Invalid Answer',
        description: 'Please reply with a number only.',
        footer: 'Veri System'
      });
      await message.channel.send({ embeds: [embed] });
      return;
    }

    const guild = client.guilds.cache.get(session.guildId);
    if (!guild) {
      captchaSessions.delete(message.author.id);
      const embed = boxEmbed({
        title: 'Verification Failed',
        description: 'The server you were verifying for is no longer available.',
        footer: 'Veri System'
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

      if (cfg.verificationRoleId) {
        const role = guild.roles.cache.get(cfg.verificationRoleId);
        if (role) {
          const member = await guild.members.fetch(message.author.id).catch(() => null);
          if (member) {
            member.roles.add(role).catch(() => {});
          }
        }
      }

      const embed = boxEmbed({
        title: 'Verification Passed',
        description: 'You answered correctly and have been verified in the server.',
        footer: 'Veri System'
      });

      await message.channel.send({ embeds: [embed] });

      await sendLog(
        guild,
        'Verification Passed',
        `User ${message.author.id} passed verification via DM.`
      );

      captchaSessions.delete(message.author.id);
      return;
    } else {
      record.fails = (record.fails || 0) + 1;
      saveData(data);

      await sendLog(
        guild,
        'Verification Failed',
        `User ${message.author.id} failed a verification attempt via DM.`
      );

      const { file, answer } = getRandomCaptcha();

      captchaSessions.set(message.author.id, {
        answer,
        guildId: session.guildId
      });

      const embed = boxEmbed({
        title: 'Incorrect Answer',
        description: 'That was not the correct number. Here is a new captcha.',
        footer: 'Veri System'
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

  // honeypot
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
      'Honeypot Triggered',
      `User ${message.author.id} sent a message in the honeypot channel.`
    );

    const member = await guild.members.fetch(message.author.id).catch(() => null);
    if (member) {
      await applyHoneypotPunishment(member, cfg);
    }

    const dm = await message.author.createDM().catch(() => null);
    if (dm) {
      const embed = boxEmbed({
        title: 'Honeypot Triggered',
        description:
          'You sent a message in a protected honeypot channel and have been punished according to the server settings.',
        footer: 'Veri System'
      });
      await dm.send({ embeds: [embed] }).catch(() => {});
    }

    return;
  }
});

client.login(BOT_TOKEN);
