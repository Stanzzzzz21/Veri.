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

// keep-alive HTTP server for Render
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

// green theme (from your image)
const THEME_COLOR = 0x00c853;

// helper: boxed embed
function boxEmbed({ title, description, fields = [], footer }) {
  const embed = new EmbedBuilder()
    .setColor(THEME_COLOR)
    .setTitle(title || 'Veri')
    .setDescription(description || '');

  if (fields.length > 0) embed.addFields(fields);
  if (footer) embed.setFooter({ text: footer });

  return embed;
}

// captcha images: 30 IDs with mapped answers
// we generate a simple image per ID and use a fixed answer map
const captchaAnswers = {};
for (let i = 1; i <= 30; i++) {
  // example: answer = (i % 9) + 1 (1–9)
  captchaAnswers[i] = (i % 9) + 1;
}

function generateCaptchaImage(id) {
  const width = 400;
  const height = 200;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  // background
  ctx.fillStyle = '#f5fff7';
  ctx.fillRect(0, 0, width, height);

  // big ID text
  ctx.font = 'bold 80px Sans';
  ctx.fillStyle = '#00c853';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(`Image ${id}`, width / 2, height / 2 - 30);

  // small hint text
  ctx.font = '24px Sans';
  ctx.fillStyle = '#111111';
  ctx.fillText('Enter the correct number for this image.', width / 2, height / 2 + 40);

  return canvas.toBuffer();
}

// in-memory captcha sessions: userId -> { answer }
const captchaSessions = new Map();

// setup wizard sessions: userId -> { step, guildId, channelId, data }
const setupSessions = new Map();

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
  .setDescription('Run the Veri setup wizard.')
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

// helper: log to guild logs channel
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

    const embed = boxEmbed({
      title: 'Veri Auto Verification',
      description:
        'You were already verified using Veri in another server. You have been verified here automatically.',
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

// setup wizard helpers
function buildSetupEmbed(step, cfg, guildName) {
  let title = 'Veri Setup Wizard';
  let description = '';
  const fields = [];

  if (step === 0) {
    description =
      'Welcome to Veri.\n\nThis wizard will configure basic settings for your server.\nUse the buttons below to move between steps.';
  } else if (step === 1) {
    description =
      'Step 1: Verification Channel\n\nThe channel where the Verify button and “Check DMs” messages will appear.';
    fields.push({
      name: 'Current',
      value: cfg.verificationChannelId ? `<#${cfg.verificationChannelId}>` : 'Not set',
      inline: false
    });
  } else if (step === 2) {
    description =
      'Step 2: Logs Channel\n\nThe channel where Veri will send logs for verification, honeypot, and system events.';
    fields.push({
      name: 'Current',
      value: cfg.logsChannelId ? `<#${cfg.logsChannelId}>` : 'Not set',
      inline: false
    });
  } else if (step === 3) {
    description =
      'Step 3: Honeypot Channel\n\nMessages sent in this channel will trigger honeypot punishment.';
    fields.push({
      name: 'Current',
      value: cfg.honeypotChannelId ? `<#${cfg.honeypotChannelId}>` : 'Not set',
      inline: false
    });
  } else if (step === 4) {
    description =
      'Step 4: Verification Role\n\nThis role will be given to users after they pass verification.';
    fields.push({
      name: 'Current',
      value: cfg.verificationRoleId ? `<@&${cfg.verificationRoleId}>` : 'Not set',
      inline: false
    });
  } else if (step === 5) {
    description =
      'Step 5: Honeypot Punishment\n\nChoose how Veri should punish users who trigger the honeypot.';
    fields.push(
      {
        name: 'Punishment',
        value: cfg.honeypotPunishment,
        inline: true
      },
      {
        name: 'Timeout Minutes',
        value: String(cfg.honeypotTimeoutMinutes),
        inline: true
      }
    );
  } else if (step === 6) {
    description =
      'Step 6: Features\n\nToggle captcha and honeypot features on or off.';
    fields.push(
      {
        name: 'Captcha Enabled',
        value: cfg.captchaEnabled ? 'Yes' : 'No',
        inline: true
      },
      {
        name: 'Honeypot Enabled',
        value: cfg.honeypotEnabled ? 'Yes' : 'No',
        inline: true
      }
    );
  } else if (step === 7) {
    description =
      'Review your settings and press Finish to apply them.\n\nYou can change them later with /settings.';
    fields.push(
      {
        name: 'Verification Channel',
        value: cfg.verificationChannelId ? `<#${cfg.verificationChannelId}>` : 'Not set',
        inline: false
      },
      {
        name: 'Logs Channel',
        value: cfg.logsChannelId ? `<#${cfg.logsChannelId}>` : 'Not set',
        inline: false
      },
      {
        name: 'Honeypot Channel',
        value: cfg.honeypotChannelId ? `<#${cfg.honeypotChannelId}>` : 'Not set',
        inline: false
      },
      {
        name: 'Verification Role',
        value: cfg.verificationRoleId ? `<@&${cfg.verificationRoleId}>` : 'Not set',
        inline: false
      },
      {
        name: 'Honeypot Punishment',
        value: cfg.honeypotPunishment,
        inline: true
      },
      {
        name: 'Timeout Minutes',
        value: String(cfg.honeypotTimeoutMinutes),
        inline: true
      },
      {
        name: 'Captcha Enabled',
        value: cfg.captchaEnabled ? 'Yes' : 'No',
        inline: true
      },
      {
        name: 'Honeypot Enabled',
        value: cfg.honeypotEnabled ? 'Yes' : 'No',
        inline: true
      }
    );
  }

  return boxEmbed({
    title,
    description,
    fields,
    footer: `Server: ${guildName}`
  });
}

function buildSetupButtons(step) {
  const row = new ActionRowBuilder();

  const back = new ButtonBuilder()
    .setCustomId('setup_back')
    .setLabel('Back')
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(step === 0);

  const next = new ButtonBuilder()
    .setCustomId('setup_next')
    .setLabel('Next')
    .setStyle(ButtonStyle.Primary)
    .setDisabled(step >= 7);

  const finish = new ButtonBuilder()
    .setCustomId('setup_finish')
    .setLabel('Finish')
    .setStyle(ButtonStyle.Success)
    .setDisabled(step < 7);

  const cancel = new ButtonBuilder()
    .setCustomId('setup_cancel')
    .setLabel('Cancel')
    .setStyle(ButtonStyle.Danger);

  row.addComponents(back, next, finish, cancel);
  return [row];
}

// interaction handler
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

      // default: use current channel as verification channel if not set
      if (!cfg.verificationChannelId) cfg.verificationChannelId = interaction.channel.id;
      if (!cfg.logsChannelId) cfg.logsChannelId = interaction.channel.id;

      const dm = await interaction.user.createDM().catch(() => null);
      if (!dm) {
        const embed = boxEmbed({
          title: 'Setup Failed',
          description: 'I could not open a DM with you. Please enable DMs and try again.',
          footer: 'Veri System'
        });
        return interaction.reply({ embeds: [embed], ephemeral: true });
      }

      const session = {
        step: 0,
        guildId: guild.id,
        channelId: interaction.channel.id
      };
      setupSessions.set(interaction.user.id, session);

      const embed = buildSetupEmbed(0, cfg, guild.name);
      const components = buildSetupButtons(0);

      const msg = await dm.send({ embeds: [embed], components });
      session.messageId = msg.id;

      const replyEmbed = boxEmbed({
        title: 'Veri Setup',
        description: 'I have sent you a DM with the setup wizard.',
        footer: 'Veri System'
      });

      await interaction.reply({ embeds: [replyEmbed], ephemeral: true });
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
        description: 'Veri settings have been updated.',
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

  // setup wizard buttons
  if (interaction.isButton()) {
    const customId = interaction.customId;

    // setup wizard
    if (
      customId === 'setup_next' ||
      customId === 'setup_back' ||
      customId === 'setup_finish' ||
      customId === 'setup_cancel'
    ) {
      const session = setupSessions.get(interaction.user.id);
      if (!session) {
        return interaction.reply({
          embeds: [
            boxEmbed({
              title: 'Setup Session Expired',
              description: 'There is no active setup session for you.',
              footer: 'Veri System'
            })
          ],
          ephemeral: true
        });
      }

      const guild = client.guilds.cache.get(session.guildId);
      if (!guild) {
        setupSessions.delete(interaction.user.id);
        return interaction.reply({
          embeds: [
            boxEmbed({
              title: 'Setup Failed',
              description: 'The server for this setup session no longer exists.',
              footer: 'Veri System'
            })
          ],
          ephemeral: true
        });
      }

      const cfg = getGuildConfig(guild.id);

      if (customId === 'setup_cancel') {
        setupSessions.delete(interaction.user.id);
        return interaction.update({
          embeds: [
            boxEmbed({
              title: 'Setup Cancelled',
              description: 'The Veri setup wizard has been cancelled.',
              footer: 'Veri System'
            })
          ],
          components: []
        });
      }

      if (customId === 'setup_next') {
        session.step = Math.min(session.step + 1, 7);
      } else if (customId === 'setup_back') {
        session.step = Math.max(session.step - 1, 0);
      } else if (customId === 'setup_finish') {
        // finish: post verify button and welcome message
        setupSessions.delete(interaction.user.id);

        // post verify button in verification channel
        if (cfg.verificationChannelId) {
          const vChan = guild.channels.cache.get(cfg.verificationChannelId);
          if (vChan && vChan.type === ChannelType.GuildText) {
            const row = new ActionRowBuilder().addComponents(
              new ButtonBuilder()
                .setCustomId('veri_start')
                .setLabel('Verify')
                .setStyle(ButtonStyle.Success)
            );

            const embed = boxEmbed({
              title: 'Verification',
              description:
                'Press the button below to start verification.\nYou will receive a DM with your captcha.',
              footer: 'Veri System'
            });

            await vChan.send({ embeds: [embed], components: [row] });
          }
        }

        // welcome message in logs
        if (cfg.logsChannelId) {
          const welcome = boxEmbed({
            title: 'Veri Enabled',
            description:
              'Welcome to Veri.\n\nThis bot provides DM-based captcha verification and honeypot protection for your server.\n\nCommands:\n• /setup – run the setup wizard\n• /settings – adjust Veri settings\n• /player info – view a user’s Veri record',
            footer: 'Veri System'
          });
          const logsChan = guild.channels.cache.get(cfg.logsChannelId);
          if (logsChan && logsChan.type === ChannelType.GuildText) {
            await logsChan.send({ embeds: [welcome] });
          }
        }

        return interaction.update({
          embeds: [
            boxEmbed({
              title: 'Setup Complete',
              description:
                'Veri setup is complete.\nThe Verify button has been posted in the verification channel.',
              footer: 'Veri System'
            })
          ],
          components: []
        });
      }

      // update config automatically based on step and where /setup was run
      const originChannel = guild.channels.cache.get(session.channelId);
      if (originChannel && originChannel.type === ChannelType.GuildText) {
        if (session.step === 1 && !cfg.verificationChannelId) {
          cfg.verificationChannelId = originChannel.id;
        }
        if (session.step === 2 && !cfg.logsChannelId) {
          cfg.logsChannelId = originChannel.id;
        }
        if (session.step === 3 && !cfg.honeypotChannelId) {
          cfg.honeypotChannelId = originChannel.id;
        }
      }

      saveData(data);

      const embed = buildSetupEmbed(session.step, cfg, guild.name);
      const components = buildSetupButtons(session.step);

      return interaction.update({ embeds: [embed], components });
    }

    // verify button
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

      // create captcha session
      const id = Math.floor(Math.random() * 30) + 1;
      const answer = captchaAnswers[id];
      const buffer = generateCaptchaImage(id);

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
        files: [{ attachment: buffer, name: `captcha_${id}.png` }]
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

// message handler: honeypot + DM captcha answers
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

      // new captcha
      const id = Math.floor(Math.random() * 30) + 1;
      const answer = captchaAnswers[id];
      const buffer = generateCaptchaImage(id);

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
        files: [{ attachment: buffer, name: `captcha_${id}.png` }]
      });

      return;
    }
  }

  // guild messages
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
