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

// theme
const THEME_COLOR = 0x00c853;

// boxed embed helper
function boxEmbed({ title, description, fields = [], footer }) {
  const embed = new EmbedBuilder()
    .setColor(THEME_COLOR)
    .setTitle(title || 'Veri.')
    .setDescription(description || '');

  if (fields.length > 0) embed.addFields(fields);
  if (footer) embed.setFooter({ text: footer });
  else embed.setFooter({ text: 'Veri.' });

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

// guild join: welcome message, delete after 5 minutes
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
      title: 'Veri.',
      description:
        'Veri. has joined this server.\n\nVeri. provides DM-based captcha verification, per-user channel lockdown for newcomers, and a global honeypot ban system.\n\nRun `/setup` to create the verification, logs, and honeypot channels and post the Verify button.',
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

// per-user lockdown for newcomers + global blacklist auto-ban
client.on('guildMemberAdd', async member => {
  if (member.user.bot) return;

  const guild = member.guild;
  const cfg = getGuildConfig(guild.id);

  // global blacklist: auto-ban
  if (isBlacklisted(member.id)) {
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

  // only newcomers after Veri. is installed are locked down
  // existing members before Veri. joined are untouched (they won't trigger this event)

  // per-user channel overrides: only see verification + honeypot
  const verificationChannel = cfg.verificationChannelId
    ? guild.channels.cache.get(cfg.verificationChannelId)
    : guild.channels.cache.find(ch => ch.name === 'verification' && ch.type === ChannelType.GuildText);

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

// interactions
client.on('interactionCreate', async interaction => {
  if (interaction.isChatInputCommand()) {
    const name = interaction.commandName;

    if (name === 'setup') {
      const member = interaction.member;
      if (!member.permissions.has(PermissionFlagsBits.Administrator)) {
        const embed = boxEmbed({
          title: 'Veri.',
          description: 'You must be an administrator to use this command.',
          footer: 'Veri.'
        });
        return interaction.reply({ embeds: [embed], ephemeral: true });
      }

      const guild = interaction.guild;
      const cfg = getGuildConfig(guild.id);

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

      const verifyEmbed = boxEmbed({
        title: 'Veri.',
        description:
          'Press the button below to start verification with Veri.\nYou will receive a DM with your captcha.\n\nYou will only see this channel and the honeypot channel until you pass verification.',
        footer: 'Veri.'
      });

      await verificationChannel.send({ embeds: [verifyEmbed], components: [row] });

      // honeypot warning box
      const honeypotEmbed = boxEmbed({
        title: 'DO NOT TYPE HERE',
        description:
          'This is a honeypot trap channel.\nAnyone typing here will be banned from all Veri. servers.\nNo exceptions can be made.',
        footer: 'Veri.'
      });

      await honeypotChannel.send({ embeds: [honeypotEmbed] });

      const replyEmbed = boxEmbed({
        title: 'Veri.',
        description:
          'Setup complete.\n\nVerification, logs, and honeypot channels are configured.\nThe Verify button has been posted in the verification channel.\nA honeypot warning has been posted in the honeypot channel.',
        footer: 'Veri.'
      });

      await interaction.reply({ embeds: [replyEmbed], ephemeral: true });

      const welcome = boxEmbed({
        title: 'Veri.',
        description:
          'Veri. is now active on this server.\n\nNew members will be locked to the verification and honeypot channels until they pass captcha verification.\nTyping in the honeypot channel results in a permanent ban from all Veri. servers.\n\nCommands:\n• `/setup` – configure channels and post the Verify button\n• `/settings` – adjust Veri. settings\n• `/player info` – view a user’s Veri. record',
        footer: 'Veri.'
      });
      await logsChannel.send({ embeds: [welcome] });

      await sendLog(
        guild,
        'Veri. Setup',
        'Channels created/linked and Verify button posted by /setup.'
      );
    }

    if (name === 'settings') {
      const guild = interaction.guild;
      const cfg = getGuildConfig(guild.id);

      const captchaEnabled = interaction.options.getBoolean('captcha_enabled');
      const honeypotEnabled = interaction.options.getBoolean('honeypot_enabled');
      const verificationRole = interaction.options.getRole('verification_role');

      if (typeof captchaEnabled === 'boolean') cfg.captchaEnabled = captchaEnabled;
      if (typeof honeypotEnabled === 'boolean') cfg.honeypotEnabled = honeypotEnabled;
      if (verificationRole) cfg.verificationRoleId = verificationRole.id;

      saveData(data);

      const verificationRoleText = cfg.verificationRoleId
        ? `<@&${cfg.verificationRoleId}>`
        : 'Captcha Verified (auto-created if needed)';

      const embed = boxEmbed({
        title: 'Veri. Settings Updated',
        description:
          `Captcha enabled: **${cfg.captchaEnabled ? 'Yes' : 'No'}**\n` +
          `Honeypot enabled: **${cfg.honeypotEnabled ? 'Yes' : 'No'}**\n` +
          `Verification role: **${verificationRoleText}**`,
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
          `Global Honeypot Blacklist: **${isBlacklisted(userId) ? 'Yes' : 'No'}**`
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
  }

  // verify button
  if (interaction.isButton()) {
    if (interaction.customId === 'veri_start') {
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
          'You are verifying for a server using Veri.\n\nLook at the image and reply with the correct number.\nReply with **only the number**.',
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

  // honeypot
  if (
    cfg.honeypotEnabled &&
    cfg.honeypotChannelId &&
    message.channel.id === cfg.honeypotChannelId
  ) {
    const record = getUserRecord(message.author.id);
    record.honeypotTriggers = (record.honeypotTriggers || 0) + 1;
    saveData(data);

    addToBlacklist(message.author.id);

    await sendLog(
      guild,
      'Veri. Honeypot Triggered',
      `User ${message.author.id} sent a message in the honeypot channel and was globally banned.`
    );

    const dm = await message.author.createDM().catch(() => null);
    if (dm) {
      const embed = boxEmbed({
        title: 'Veri.',
        description:
          'You typed in a Veri. honeypot channel.\nThis results in a permanent ban from all Veri. servers.\nNo exceptions can be made.',
        footer: 'Veri.'
      });
      await dm.send({ embeds: [embed] }).catch(() => {});
    }

    const member = await guild.members.fetch(message.author.id).catch(() => null);
    if (member) {
      await member.ban({ reason: 'Veri. honeypot trigger (global ban)' }).catch(() => {});
    }

    return;
  }
});

client.login(BOT_TOKEN);
