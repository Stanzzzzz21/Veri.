// veri.js — FINAL, FULL, PATCHED VERSION (ALL FEATURES + FIXES)

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
  Collection,
  MessageFlags
} from "discord.js";

import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_PATH = path.join(__dirname, "veri-data.json");
const DATA_BACKUP_PATH = path.join(__dirname, "veri-data-backup.json");

const BOT_TOKEN = process.env.BOT_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const PORT = process.env.PORT || 3000;

const OWNER_ID = "876731494805155851";
const VERIFICATION_BANNER_URL = "https://i.postimg.cc/SKrVKYhT/Verify-msg-banner.png";
const THEME_COLOR = 0x00c853;

if (!BOT_TOKEN || !CLIENT_ID) {
  console.error("BOT_TOKEN and CLIENT_ID must be set.");
  process.exit(1);
}

// keep-alive
http.createServer((req, res) => {
  res.writeHead(200);
  res.end("Veri. running");
}).listen(PORT);

// =========================
// DATABASE
// =========================

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
  return JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
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
    throw new Error("Invalid JSON");
  }
  if (!parsed.verifiedUsers || !parsed.guilds || !parsed.blacklist) {
    throw new Error("Invalid Veri. data structure");
  }
  backupData();
  fs.writeFileSync(DATA_PATH, JSON.stringify(parsed, null, 2));
  data = parsed;
}

// =========================
// HELPERS
// =========================

function boxEmbed({ title, description, fields = [], footer }) {
  const embed = new EmbedBuilder()
    .setColor(THEME_COLOR)
    .setTitle(title)
    .setDescription(description);
  if (fields.length > 0) embed.addFields(fields);
  embed.setFooter({ text: footer || "Veri." });
  return embed;
}

async function ensureVeriCategory(guild) {
  let category = guild.channels.cache.find(
    c => c.name === "Veri." && c.type === ChannelType.GuildCategory
  );
  if (!category) {
    category = await guild.channels.create({
      name: "Veri.",
      type: ChannelType.GuildCategory
    });
  }
  return category;
}

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
      honeypotMode: "global_ban",
      setupComplete: false
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

function isBlacklisted(id) {
  return data.blacklist.includes(id);
}

function addToBlacklist(id) {
  if (!data.blacklist.includes(id)) {
    data.blacklist.push(id);
    saveData(data);
  }
}

function removeFromBlacklist(id) {
  data.blacklist = data.blacklist.filter(x => x !== id);
  saveData(data);
}

// YOU can use Veri commands everywhere; admins in their guild; admin role if set
function canUseVeriCommands(interaction) {
  const guild = interaction.guild;
  if (!guild) return false;

  if (interaction.user.id === OWNER_ID) return true;

  const cfg = getGuildConfig(guild.id);
  const member = interaction.member;

  if (guild.ownerId === interaction.user.id) return true;
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  if (cfg.adminRoleId && member.roles.cache.has(cfg.adminRoleId)) return true;

  return false;
}

// =========================
// CAPTCHA
// =========================

const captchaFiles = [
  "a.png.png",
  "b.png.png",
  "c.png.png",
  "d.png.png",
  "e.png.png",
  "f.png.png",
  "g.png.png",
  "h.png.png",
  "i.png.png",
  "j.png.png",
  "k.png.png",
  "l.png.png",
  "m.png.png",
  "n.png.png",
  "o.png.png"
];

const captchaAnswers = {
  "a.png.png": 2,
  "b.png.png": 8,
  "c.png.png": 2,
  "d.png.png": 3,
  "e.png.png": 7,
  "f.png.png": 4,
  "g.png.png": 5,
  "h.png.png": 5,
  "i.png.png": 7,
  "j.png.png": 5,
  "k.png.png": 5,
  "l.png.png": 9,
  "m.png.png": 6,
  "n.png.png": 8,
  "o.png.png": 1
};

function getRandomCaptcha() {
  const file = captchaFiles[Math.floor(Math.random() * captchaFiles.length)];
  return { file, answer: captchaAnswers[file] };
}

const captchaSessions = new Map();

// =========================
// CLIENT & COMMANDS
// =========================

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

const setupCommand = new SlashCommandBuilder()
  .setName("setup")
  .setDescription("Initial setup for Veri.")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .setDMPermission(false);

const settingsCommand = new SlashCommandBuilder()
  .setName("settings")
  .setDescription("Configure Veri. settings.")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .setDMPermission(false)
  .addBooleanOption(o =>
    o.setName("captcha_enabled").setDescription("Enable/disable captcha")
  )
  .addBooleanOption(o =>
    o.setName("honeypot_enabled").setDescription("Enable/disable honeypot")
  )
  .addStringOption(o =>
    o
      .setName("honeypot_mode")
      .setDescription("Set honeypot punishment mode")
      .addChoices(
        { name: "Global Ban", value: "global_ban" },
        { name: "Server Ban", value: "server_ban" },
        { name: "Kick", value: "kick" },
        { name: "Warn", value: "warn" },
        { name: "DM Only", value: "dm_only" }
      )
  )
  .addRoleOption(o =>
    o.setName("verification_role").setDescription("Role to give when verified")
  );

const playerInfoCommand = new SlashCommandBuilder()
  .setName("player")
  .setDescription("Player info commands")
  .addSubcommand(s =>
    s
      .setName("info")
      .setDescription("Show Veri. info for a user")
      .addStringOption(o =>
        o.setName("user_id").setDescription("User ID").setRequired(true)
      )
  );

const staffCommand = new SlashCommandBuilder()
  .setName("veri_staff")
  .setDescription("Veri. Staff Panel (OWNER ONLY)")
  .setDMPermission(false);

const securityScoreCommand = new SlashCommandBuilder()
  .setName("security_score")
  .setDescription("Show this server's Veri. security score")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .setDMPermission(false);

const resendCommand = new SlashCommandBuilder()
  .setName("veri_resend")
  .setDescription("Resend verification or honeypot messages")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .setDMPermission(false)
  .addStringOption(o =>
    o
      .setName("type")
      .setDescription("Which message to resend")
      .setRequired(true)
      .addChoices(
        { name: "Verification", value: "verification" },
        { name: "Honeypot", value: "honeypot" }
      )
  );

const restoreCommand = new SlashCommandBuilder()
  .setName("veri_restore")
  .setDescription("Restore Veri. database from JSON (OWNER ONLY)")
  .setDMPermission(false);

const removeBotCommand = new SlashCommandBuilder()
  .setName("veri_remove_bot")
  .setDescription("Remove Veri. from this server")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .setDMPermission(false);

client.commands.set("setup", { data: setupCommand });
client.commands.set("settings", { data: settingsCommand });
client.commands.set("player", { data: playerInfoCommand });
client.commands.set("veri_staff", { data: staffCommand });
client.commands.set("security_score", { data: securityScoreCommand });
client.commands.set("veri_resend", { data: resendCommand });
client.commands.set("veri_restore", { data: restoreCommand });
client.commands.set("veri_remove_bot", { data: removeBotCommand });

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(BOT_TOKEN);
  await rest.put(Routes.applicationCommands(CLIENT_ID), {
    body: [
      setupCommand.toJSON(),
      settingsCommand.toJSON(),
      playerInfoCommand.toJSON(),
      staffCommand.toJSON(),
      securityScoreCommand.toJSON(),
      resendCommand.toJSON(),
      restoreCommand.toJSON(),
      removeBotCommand.toJSON()
    ]
  });
  console.log("Commands registered.");
}

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await registerCommands();
});

// =========================
// INTERACTIONS
// =========================

client.on("interactionCreate", async interaction => {
  if (interaction.isChatInputCommand()) {
    const name = interaction.commandName;

    // /setup
    if (name === "setup") {
      if (!canUseVeriCommands(interaction)) {
        return interaction.reply({
          embeds: [
            boxEmbed({
              title: "Veri.",
              description: "You are not allowed to run this command.",
              footer: "Veri."
            })
          ],
          flags: MessageFlags.Ephemeral
        });
      }

      const guild = interaction.guild;
      const cfg = getGuildConfig(guild.id);

      if (cfg.setupComplete) {
        return interaction.reply({
          embeds: [
            boxEmbed({
              title: "Veri.",
              description: "Setup already completed.",
              footer: "Veri."
            })
          ],
          flags: MessageFlags.Ephemeral
        });
      }

      const category = await ensureVeriCategory(guild);

      let adminRole =
        (cfg.adminRoleId && guild.roles.cache.get(cfg.adminRoleId)) ||
        guild.roles.cache.find(r => r.name === "Veri. Admin");

      if (!adminRole) {
        adminRole = await guild.roles.create({
          name: "Veri. Admin",
          reason: "Veri. setup"
        });
        cfg.adminRoleId = adminRole.id;
      }

      const verificationChannel = await guild.channels.create({
        name: "verification",
        type: ChannelType.GuildText,
        parent: category.id
      });
      cfg.verificationChannelId = verificationChannel.id;

      const logsChannel = await guild.channels.create({
        name: "veri-logs",
        type: ChannelType.GuildText,
        parent: category.id
      });
      cfg.logsChannelId = logsChannel.id;

      const honeypotChannel = await guild.channels.create({
        name: "!DO NOT TYPE HERE!",
        type: ChannelType.GuildText,
        parent: category.id
      });
      cfg.honeypotChannelId = honeypotChannel.id;

      cfg.setupComplete = true;
      saveData(data);

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("veri_start")
          .setLabel("Verify")
          .setStyle(ButtonStyle.Success)
      );

      const verifyEmbed = new EmbedBuilder()
        .setColor(THEME_COLOR)
        .setTitle("WELCOME TO VERIFICATION")
        .setDescription(
          "Securing Your Communities – Simple Captcha Verification\n\n" +
            "1. Press Verify\n" +
            "2. Check your DMs\n" +
            "3. Solve the captcha\n" +
            "4. Access all channels"
        )
        .setImage(VERIFICATION_BANNER_URL)
        .setFooter({ text: "Veri." });

      await verificationChannel.send({ embeds: [verifyEmbed], components: [row] });

      const honeypotEmbed = boxEmbed({
        title: "DO NOT TYPE HERE",
        description:
          "This is a Veri. honeypot.\nTyping here triggers an automatic punishment.\nClose this channel immediately.",
        footer: "Veri."
      });

      await honeypotChannel.send({ embeds: [honeypotEmbed] });

      return interaction.reply({
        embeds: [
          boxEmbed({
            title: "Veri.",
            description: "Setup complete.",
            footer: "Veri."
          })
        ]
      });
    }

    // /settings
    if (name === "settings") {
      if (!canUseVeriCommands(interaction)) {
        return interaction.reply({
          embeds: [
            boxEmbed({
              title: "Veri.",
              description: "You are not allowed to run this command.",
              footer: "Veri."
            })
          ],
          flags: MessageFlags.Ephemeral
        });
      }

      const guild = interaction.guild;
      const cfg = getGuildConfig(guild.id);

      const captchaEnabled = interaction.options.getBoolean("captcha_enabled");
      const honeypotEnabled = interaction.options.getBoolean("honeypot_enabled");
      const honeypotMode = interaction.options.getString("honeypot_mode");
      const verificationRole = interaction.options.getRole("verification_role");

      const category = await ensureVeriCategory(guild);

      if (captchaEnabled !== null) cfg.captchaEnabled = captchaEnabled;
      if (honeypotEnabled !== null) cfg.honeypotEnabled = honeypotEnabled;
      if (honeypotMode) cfg.honeypotMode = honeypotMode;
      if (verificationRole) cfg.verificationRoleId = verificationRole.id;

      // captcha toggle
      if (captchaEnabled === false && cfg.verificationChannelId) {
        const ch = guild.channels.cache.get(cfg.verificationChannelId);
        if (ch) ch.delete().catch(() => {});
        cfg.verificationChannelId = null;
      }

      if (captchaEnabled === true && !cfg.verificationChannelId) {
        const ch = await guild.channels.create({
          name: "verification",
          type: ChannelType.GuildText,
          parent: category.id
        });
        cfg.verificationChannelId = ch.id;

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId("veri_start")
            .setLabel("Verify")
            .setStyle(ButtonStyle.Success)
        );

        const verifyEmbed = new EmbedBuilder()
          .setColor(THEME_COLOR)
          .setTitle("WELCOME TO VERIFICATION")
          .setDescription(
            "Securing Your Communities – Simple Captcha Verification\n\n" +
              "1. Press Verify\n" +
              "2. Check your DMs\n" +
              "3. Solve the captcha\n" +
              "4. Access all channels"
          )
          .setImage(VERIFICATION_BANNER_URL)
          .setFooter({ text: "Veri." });

        await ch.send({ embeds: [verifyEmbed], components: [row] });
      }

      // honeypot toggle
      if (honeypotEnabled === false && cfg.honeypotChannelId) {
        const ch = guild.channels.cache.get(cfg.honeypotChannelId);
        if (ch) ch.delete().catch(() => {});
        cfg.honeypotChannelId = null;
      }

      if (honeypotEnabled === true && !cfg.honeypotChannelId) {
        const ch = await guild.channels.create({
          name: "!DO NOT TYPE HERE!",
          type: ChannelType.GuildText,
          parent: category.id
        });
        cfg.honeypotChannelId = ch.id;

        const honeypotEmbed = boxEmbed({
          title: "DO NOT TYPE HERE",
          description:
            "This is a Veri. honeypot.\nTyping here triggers an automatic punishment.\nClose this channel immediately.",
          footer: "Veri."
        });

        await ch.send({ embeds: [honeypotEmbed] });
      }

      saveData(data);

      return interaction.reply({
        embeds: [
          boxEmbed({
            title: "Veri.",
            description: "Settings updated.",
            footer: "Veri."
          })
        ],
        flags: MessageFlags.Ephemeral
      });
    }

    // /player info
    if (name === "player") {
      const sub = interaction.options.getSubcommand();
      if (sub === "info") {
        const userId = interaction.options.getString("user_id");
        const record = getUserRecord(userId);

        const embed = boxEmbed({
          title: "Veri. Player Info",
          description: `User ID: ${userId}`,
          fields: [
            {
              name: "First Verified",
              value: record.firstVerified || "Never",
              inline: true
            },
            {
              name: "Last Verification",
              value: record.lastVerification || "Never",
              inline: true
            },
            {
              name: "Servers Verified",
              value: record.servers.length.toString(),
              inline: true
            },
            {
              name: "Captcha Fails",
              value: record.fails.toString(),
              inline: true
            },
            {
              name: "Honeypot Triggers",
              value: record.honeypotTriggers.toString(),
              inline: true
            }
          ],
          footer: "Veri."
        });

        return interaction.reply({ embeds: [embed] });
      }
    }

    // /veri_staff (OWNER ONLY)
    if (name === "veri_staff") {
      if (interaction.user.id !== OWNER_ID) {
        return interaction.reply({
          embeds: [
            boxEmbed({
              title: "Veri.",
              description: "Only the Veri. owner can use this.",
              footer: "Veri."
            })
          ],
          flags: MessageFlags.Ephemeral
        });
      }

      const embed = boxEmbed({
        title: "Veri. Staff Panel",
        description:
          "Owner tools:\n\n" +
          "- View global blacklist\n" +
          "- Remove from blacklist\n" +
          "- Restore database\n" +
          "- Supervise all servers",
        footer: "Veri."
      });

      return interaction.reply({ embeds: [embed] });
    }

    // /security_score
    if (name === "security_score") {
      if (!canUseVeriCommands(interaction)) {
        return interaction.reply({
          embeds: [
            boxEmbed({
              title: "Veri.",
              description: "You are not allowed to run this command.",
              footer: "Veri."
            })
          ],
          flags: MessageFlags.Ephemeral
        });
      }

      const guild = interaction.guild;
      const cfg = getGuildConfig(guild.id);

      let score = 0;
      if (cfg.captchaEnabled) score += 40;
      if (cfg.honeypotEnabled) score += 40;
      if (cfg.honeypotMode === "global_ban") score += 20;

      const embed = boxEmbed({
        title: "Veri. Security Score",
        description: `Security score for **${guild.name}**: **${score}/100**`,
        footer: "Veri."
      });

      return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }

    // /veri_resend
    if (name === "veri_resend") {
      if (!canUseVeriCommands(interaction)) {
        return interaction.reply({
          embeds: [
            boxEmbed({
              title: "Veri.",
              description: "You are not allowed to run this command.",
              footer: "Veri."
            })
          ],
          flags: MessageFlags.Ephemeral
        });
      }

      const type = interaction.options.getString("type");
      const guild = interaction.guild;
      const cfg = getGuildConfig(guild.id);
      const category = await ensureVeriCategory(guild);

      if (type === "verification") {
        let ch =
          cfg.verificationChannelId &&
          guild.channels.cache.get(cfg.verificationChannelId);

        if (!ch) {
          ch = await guild.channels.create({
            name: "verification",
            type: ChannelType.GuildText,
            parent: category.id
          });
          cfg.verificationChannelId = ch.id;
          saveData(data);
        }

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId("veri_start")
            .setLabel("Verify")
            .setStyle(ButtonStyle.Success)
        );

        const verifyEmbed = new EmbedBuilder()
          .setColor(THEME_COLOR)
          .setTitle("WELCOME TO VERIFICATION")
          .setDescription(
            "Securing Your Communities – Simple Captcha Verification\n\n" +
              "1. Press Verify\n" +
              "2. Check your DMs\n" +
              "3. Solve the captcha\n" +
              "4. Access all channels"
          )
          .setImage(VERIFICATION_BANNER_URL)
          .setFooter({ text: "Veri." });

        await ch.send({ embeds: [verifyEmbed], components: [row] });

        return interaction.reply({
          embeds: [
            boxEmbed({
              title: "Veri.",
              description: "Verification message resent.",
              footer: "Veri."
            })
          ],
          flags: MessageFlags.Ephemeral
        });
      }

      if (type === "honeypot") {
        let ch =
          cfg.honeypotChannelId &&
          guild.channels.cache.get(cfg.honeypotChannelId);

        if (!ch) {
          ch = await guild.channels.create({
            name: "!DO NOT TYPE HERE!",
            type: ChannelType.GuildText,
            parent: category.id
          });
          cfg.honeypotChannelId = ch.id;
          saveData(data);
        }

        const honeypotEmbed = boxEmbed({
          title: "DO NOT TYPE HERE",
          description:
            "This is a Veri. honeypot.\nTyping here triggers an automatic punishment.\nClose this channel immediately.",
          footer: "Veri."
        });

        await ch.send({ embeds: [honeypotEmbed] });

        return interaction.reply({
          embeds: [
            boxEmbed({
              title: "Veri.",
              description: "Honeypot message resent.",
              footer: "Veri."
            })
          ],
          flags: MessageFlags.Ephemeral
        });
      }
    }

    // /veri_restore (OWNER ONLY)
    if (name === "veri_restore") {
      if (interaction.user.id !== OWNER_ID) {
        return interaction.reply({
          embeds: [
            boxEmbed({
              title: "Veri.",
              description: "Only the Veri. owner can restore the database.",
              footer: "Veri."
            })
          ],
          flags: MessageFlags.Ephemeral
        });
      }

      const modal = new ModalBuilder()
        .setCustomId("veri_restore_modal")
        .setTitle("Veri. Database Restore");

      const jsonInput = new TextInputBuilder()
        .setCustomId("veri_restore_json")
        .setLabel("Paste Veri. JSON here")
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true);

      const row = new ActionRowBuilder().addComponents(jsonInput);
      modal.addComponents(row);

      return interaction.showModal(modal);
    }

    // /veri_remove_bot
    if (name === "veri_remove_bot") {
      if (!canUseVeriCommands(interaction)) {
        return interaction.reply({
          embeds: [
            boxEmbed({
              title: "Veri.",
              description: "You are not allowed to run this command.",
              footer: "Veri."
            })
          ],
          flags: MessageFlags.Ephemeral
        });
      }

      const guild = interaction.guild;

      await interaction.reply({
        embeds: [
          boxEmbed({
            title: "Veri.",
            description:
              "Veri. will now leave this server. Thank you for using Veri.",
            footer: "Veri."
          })
        ],
        flags: MessageFlags.Ephemeral
      });

      setTimeout(() => {
        guild.members.me.kick("Veri. remove bot command").catch(() => {});
      }, 2000);
    }
  }

  // MODAL SUBMIT (veri_restore)
  if (interaction.isModalSubmit()) {
    if (interaction.customId === "veri_restore_modal") {
      if (interaction.user.id !== OWNER_ID) {
        return interaction.reply({
          embeds: [
            boxEmbed({
              title: "Veri.",
              description: "Only the Veri. owner can restore the database.",
              footer: "Veri."
            })
          ],
          flags: MessageFlags.Ephemeral
        });
      }

      const json = interaction.fields.getTextInputValue("veri_restore_json");
      try {
        restoreDataFromJson(json);
        return interaction.reply({
          embeds: [
            boxEmbed({
              title: "Veri.",
              description: "Database restored successfully.",
              footer: "Veri."
            })
          ]
        });
      } catch (err) {
        return interaction.reply({
          embeds: [
            boxEmbed({
              title: "Veri.",
              description: `Restore failed: ${err.message}`,
              footer: "Veri."
            })
          ],
          flags: MessageFlags.Ephemeral
        });
      }
    }
  }

  // BUTTONS (verification start)
  if (interaction.isButton()) {
    if (interaction.customId === "veri_start") {
      const guild = interaction.guild;
      const cfg = getGuildConfig(guild.id);

      if (!cfg.captchaEnabled) {
        return interaction.reply({
          embeds: [
            boxEmbed({
              title: "Veri.",
              description: "Verification is currently disabled.",
              footer: "Veri."
            })
          ],
          flags: MessageFlags.Ephemeral
        });
      }

      if (isBlacklisted(interaction.user.id)) {
        const logsChannel =
          cfg.logsChannelId && guild.channels.cache.get(cfg.logsChannelId);

        if (logsChannel) {
          logsChannel
            .send({
              embeds: [
                boxEmbed({
                  title: "Veri. Global Blacklist",
                  description: `Blacklisted user <@${interaction.user.id}> attempted to verify and was blocked.`,
                  footer: "Veri."
                })
              ]
            })
            .catch(() => {});
        }

        return interaction.reply({
          embeds: [
            boxEmbed({
              title: "Veri.",
              description:
                "You are globally blacklisted from Veri. You cannot verify in any Veri. server.",
              footer: "Veri."
            })
          ],
          flags: MessageFlags.Ephemeral
        });
      }

      const { file, answer } = getRandomCaptcha();
      captchaSessions.set(interaction.user.id, {
        answer,
        guildId: guild.id,
        startedAt: Date.now()
      });

      try {
        await interaction.user.send({
          embeds: [
            boxEmbed({
              title: "Veri. Captcha",
              description:
                "Solve this captcha by entering the correct number.\nReply with the answer in this DM.",
              footer: "Veri."
            })
          ],
          files: [path.join(__dirname, "captchas", file)]
        });

        return interaction.reply({
          embeds: [
            boxEmbed({
              title: "Veri.",
              description:
                "Captcha sent to your DMs. Please check your DMs and answer.",
              footer: "Veri."
            })
          ],
          flags: MessageFlags.Ephemeral
        });
      } catch {
        return interaction.reply({
          embeds: [
            boxEmbed({
              title: "Veri.",
              description:
                "I couldn't DM you. Please enable DMs from server members and try again.",
              footer: "Veri."
            })
          ],
          flags: MessageFlags.Ephemeral
        });
      }
    }
  }
});

// =========================
// MESSAGE HANDLING (DM captcha + honeypot)
// =========================

client.on("messageCreate", async message => {
  if (message.author.bot) return;

  // DM captcha answers
  if (message.channel.type === ChannelType.DM) {
    const session = captchaSessions.get(message.author.id);
    if (!session) return;

    const answer = parseInt(message.content.trim(), 10);
    if (isNaN(answer)) return;

    const { guildId } = session;
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return;

    const cfg = getGuildConfig(guildId);
    const logsChannel =
      cfg.logsChannelId && guild.channels.cache.get(cfg.logsChannelId);

    if (answer === session.answer) {
      captchaSessions.delete(message.author.id);

      const member = await guild.members.fetch(message.author.id).catch(() => null);
      if (!member) return;

      const record = getUserRecord(message.author.id);
      const now = new Date().toISOString();
      if (!record.firstVerified) record.firstVerified = now;
      record.lastVerification = now;
      if (!record.servers.includes(guildId)) record.servers.push(guildId);
      saveData(data);

      if (cfg.verificationRoleId) {
        const role = guild.roles.cache.get(cfg.verificationRoleId);
        if (role) {
          await member.roles.add(role).catch(() => {});
        }
      }

      if (logsChannel) {
        logsChannel
          .send({
            embeds: [
              boxEmbed({
                title: "Veri. Captcha Passed",
                description: `<@${message.author.id}> passed captcha in **${guild.name}**.`,
                footer: "Veri."
              })
            ]
          })
          .catch(() => {});
      }

      return message.channel.send({
        embeds: [
          boxEmbed({
            title: "Veri.",
            description:
              "Captcha correct. You are now verified in this server.",
            footer: "Veri."
          })
        ]
      });
    } else {
      const record = getUserRecord(message.author.id);
      record.fails += 1;
      saveData(data);

      if (logsChannel) {
        logsChannel
          .send({
            embeds: [
              boxEmbed({
                title: "Veri. Captcha Failed",
                description: `<@${message.author.id}> failed captcha in **${guild.name}**.`,
                footer: "Veri."
              })
            ]
          })
          .catch(() => {});
      }

      return message.channel.send({
        embeds: [
          boxEmbed({
            title: "Veri.",
            description:
              "Incorrect answer. Please press Verify again in the server to retry.",
            footer: "Veri."
          })
        ]
      });
    }
  }

  // honeypot trap
  if (message.guild) {
    const guild = message.guild;
    const cfg = getGuildConfig(guild.id);

    if (!cfg.honeypotEnabled || !cfg.honeypotChannelId) return;
    if (message.channel.id !== cfg.honeypotChannelId) return;

    const logsChannel =
      cfg.logsChannelId && guild.channels.cache.get(cfg.logsChannelId);

    const record = getUserRecord(message.author.id);
    record.honeypotTriggers += 1;
    saveData(data);

    const punishment = cfg.honeypotMode || "global_ban";

    if (punishment === "global_ban") {
      addToBlacklist(message.author.id);
      await guild.members.ban(message.author.id, {
        reason: "Veri. honeypot global ban"
      }).catch(() => {});

      if (logsChannel) {
        logsChannel
          .send({
            embeds: [
              boxEmbed({
                title: "Veri. Honeypot Global Ban",
                description: `<@${message.author.id}> triggered honeypot and was globally blacklisted.`,
                footer: "Veri."
              })
            ]
          })
          .catch(() => {});
      }

      message.author
        .send({
          embeds: [
            boxEmbed({
              title: "Veri.",
              description:
                "You triggered a Veri. honeypot and have been globally blacklisted from all Veri. servers.",
              footer: "Veri."
            })
          ]
        })
        .catch(() => {});
    } else if (punishment === "server_ban") {
      await guild.members.ban(message.author.id, {
        reason: "Veri. honeypot server ban"
      }).catch(() => {});
      if (logsChannel) {
        logsChannel
          .send({
            embeds: [
              boxEmbed({
                title: "Veri. Honeypot Server Ban",
                description: `<@${message.author.id}> triggered honeypot and was banned from this server.`,
                footer: "Veri."
              })
            ]
          })
          .catch(() => {});
      }
    } else if (punishment === "kick") {
      const member = await guild.members.fetch(message.author.id).catch(() => null);
      if (member) {
        await member.kick("Veri. honeypot kick").catch(() => {});
      }
      if (logsChannel) {
        logsChannel
          .send({
            embeds: [
              boxEmbed({
                title: "Veri. Honeypot Kick",
                description: `<@${message.author.id}> triggered honeypot and was kicked.`,
                footer: "Veri."
              })
            ]
          })
          .catch(() => {});
      }
    } else if (punishment === "warn") {
      if (logsChannel) {
        logsChannel
          .send({
            embeds: [
              boxEmbed({
                title: "Veri. Honeypot Warn",
                description: `<@${message.author.id}> triggered honeypot and was warned.`,
                footer: "Veri."
              })
            ]
          })
          .catch(() => {});
      }
    } else if (punishment === "dm_only") {
      message.author
        .send({
          embeds: [
            boxEmbed({
              title: "Veri.",
              description:
                "You typed in a Veri. honeypot channel. This is a serious security trigger.",
              footer: "Veri."
            })
          ]
        })
        .catch(() => {});
      if (logsChannel) {
        logsChannel
          .send({
            embeds: [
              boxEmbed({
                title: "Veri. Honeypot DM Only",
                description: `<@${message.author.id}> triggered honeypot and was DM warned.`,
                footer: "Veri."
              })
            ]
          })
          .catch(() => {});
      }
    }
  }
});

// =========================
// GLOBAL BLACKLIST ON JOIN
// =========================

client.on("guildMemberAdd", async member => {
  if (isBlacklisted(member.id)) {
    const guild = member.guild;
    const cfg = getGuildConfig(guild.id);
    const logsChannel =
      cfg.logsChannelId && guild.channels.cache.get(cfg.logsChannelId);

    await guild.members.ban(member.id, {
      reason: "Veri. global blacklist auto-ban"
    }).catch(() => {});

    if (logsChannel) {
      logsChannel
        .send({
          embeds: [
            boxEmbed({
              title: "Veri. Global Blacklist Auto-Ban",
              description: `Blacklisted user <@${member.id}> joined and was auto-banned.`,
              footer: "Veri."
            })
          ]
        })
        .catch(() => {});
    }

    member.user
      .send({
        embeds: [
          boxEmbed({
            title: "Veri.",
            description:
              "You are globally blacklisted from Veri. and cannot join Veri. protected servers.",
            footer: "Veri."
          })
        ]
      })
      .catch(() => {});
  }
});

client.login(BOT_TOKEN);
