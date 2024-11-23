const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  StringSelectMenuBuilder,
  ComponentType,
} = require("discord.js");
const discordTranscripts = require("discord-html-transcripts");
const { TICKET } = require("@root/config.js");

// schemas
const { getSettings } = require("@schemas/Guild");

// helpers
const { error } = require("@helpers/Logger");

const OPEN_PERMS = ["ManageChannels"];
const CLOSE_PERMS = ["ManageChannels", "ReadMessageHistory"];

/**
 * @param {import('discord.js').Channel} channel
 */
function isTicketChannel(channel) {
  return (
    channel.type === ChannelType.GuildText &&
    channel.name.startsWith("ticket-") &&
    channel.topic &&
    channel.topic.startsWith("ticket|")
  );
}

/**
 * @param {import('discord.js').Guild} guild
 */
function getTicketChannels(guild) {
  return guild.channels.cache.filter((ch) => isTicketChannel(ch));
}

/**
 * @param {import('discord.js').Guild} guild
 * @param {string} userId
 */
function getExistingTicketChannel(guild, userId) {
  const tktChannels = getTicketChannels(guild);
  return tktChannels.filter((ch) => ch.topic.split("|")[1] === userId).first();
}

/**
 * @param {import('discord.js').BaseGuildTextChannel} channel
 */
async function parseTicketDetails(channel) {
  if (!channel.topic) return;
  const split = channel.topic?.split("|");
  const userId = split[1];
  const catName = split[2] || "Default";
  const user = await channel.client.users.fetch(userId, { cache: false }).catch(() => {});
  return { user, catName };
}

/**
 * @param {import('discord.js').BaseGuildTextChannel} channel
 * @param {import('discord.js').User} closedBy
 * @param {string} [reason]
 */
async function closeTicket(channel, closedBy, reason) {
  if (!channel.deletable || !channel.permissionsFor(channel.guild.members.me).has(CLOSE_PERMS)) {
    return "MISSING_PERMISSIONS";
  }

  try {
    const config = await getSettings(channel.guild);
    const ticketDetails = await parseTicketDetails(channel);

    const attachment = await discordTranscripts.createTranscript(channel, {
      limit: -1,
      returnType: "attachment",
      filename: `ticket-${channel.name}.html`,
      saveImages: true,
      poweredBy: false,
    });

    let transcript = null;
    if (config.ticket.log_channel) {
      const logChannel = channel.guild.channels.cache.get(config.ticket.log_channel);
      if (logChannel) {
        const message = await logChannel.send({
          files: [attachment],
        });
        if (message.attachments.size > 0) {
          transcript = message.attachments.first().url;
        }
      }
    }

    if (channel.deletable) await channel.delete();

    const embed = new EmbedBuilder().setAuthor({ name: "Ticket Closed" }).setColor(TICKET.CLOSE_EMBED);

    const fields = [
      { name: "Ticket Name", value: channel.name, inline: false },
      { name: "Transcript", value: transcript ? `[View Transcript](${transcript})` : "Not available", inline: false },
      { name: "Created At", value: `<t:${Math.floor(Date.now() / 1000)}:R>`, inline: false },
      { name: "Opened By", value: ticketDetails.user ? ticketDetails.user.username : "Unknown", inline: false },
      { name: "Closed By", value: closedBy ? closedBy.username : "Unknown", inline: false },
    ];

    embed.setFields(fields);

    if (config.ticket.log_channel) {
      const logChannel = channel.guild.channels.cache.get(config.ticket.log_channel);
      if (logChannel) {
        await logChannel.safeSend({
          embeds: [embed],
          files: transcript ? [] : [attachment],
        });
      }
    }

    if (ticketDetails.user) {
      const dmEmbed = embed
        .setDescription(`**Server:** ${channel.guild.name}\n**Category:** ${ticketDetails.catName}`)
        .setThumbnail(channel.guild.iconURL());
      await ticketDetails.user
        .send({
          embeds: [dmEmbed],
          files: transcript ? [] : [attachment],
        })
        .catch(() => {});
    }

    return "SUCCESS";
  } catch (ex) {
    error("closeTicket", ex);
    return "ERROR";
  }
}

/**
 * @param {import('discord.js').Guild} guild
 * @param {import('discord.js').User} author
 */
async function closeAllTickets(guild, author) {
  const channels = getTicketChannels(guild);
  let success = 0;
  let failed = 0;

  for (const ch of channels) {
    const status = await closeTicket(ch[1], author, "Force close all open tickets");
    if (status === "SUCCESS") success += 1;
    else failed += 1;
  }

  return [success, failed];
}

/**
 * @param {import("discord.js").ButtonInteraction} interaction
 */
async function handleTicketOpen(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const { guild, user } = interaction;

  if (!guild.members.me.permissions.has(OPEN_PERMS))
    return interaction.followUp(
      "Cannot create ticket channel, missing `Manage Channel` permission. Contact server manager for help!"
    );

  const alreadyExists = getExistingTicketChannel(guild, user.id);
  if (alreadyExists) return interaction.followUp("You already have an open ticket");

  const settings = await getSettings(guild);

  // limit check
  const existing = getTicketChannels(guild).size;
  if (existing >= settings.ticket.limit)
    return interaction.followUp("There are too many open tickets. Try again later");

  // check categories
  let catName = null;
  let catPerms = [];
  const categories = settings.ticket.categories;
  if (categories.length > 0) {
    const options = categories.map((cat) => ({ label: cat.name, value: cat.name }));
    const menuRow = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId("ticket-menu")
        .setPlaceholder("Choose the ticket category")
        .addOptions(options)
    );

    await interaction.followUp({ content: "Please choose a ticket category", components: [menuRow] });
    const res = await interaction.channel
      .awaitMessageComponent({
        componentType: ComponentType.StringSelect,
        time: 60 * 1000,
      })
      .catch(() => null);

    if (!res) return interaction.editReply({ content: "Timed out. Try again", components: [] });
    await interaction.editReply({ content: "Processing", components: [] });
    catName = res.values[0];
    catPerms = categories.find((cat) => cat.name === catName)?.staff_roles || [];
  }

  try {
    const ticketNumber = (existing + 1).toString();
    const ticketName = `${user.username}-${ticketNumber}`;
    const permissionOverwrites = [
      {
        id: guild.roles.everyone,
        deny: ["ViewChannel"],
      },
      {
        id: user.id,
        allow: ["ViewChannel", "SendMessages", "ReadMessageHistory"],
      },
      {
        id: guild.members.me.roles.highest.id,
        allow: ["ViewChannel", "SendMessages", "ReadMessageHistory"],
      },
    ];

    if (catPerms?.length > 0) {
      catPerms.forEach((roleId) => {
        const role = guild.roles.cache.get(roleId);
        if (role) {
          permissionOverwrites.push({
            id: role,
            allow: ["ViewChannel", "SendMessages", "ReadMessageHistory"],
          });
        }
      });
    }

    const tktChannel = await guild.channels.create({
      name: ticketName,
      type: ChannelType.GuildText,
      topic: `ticket|${user.id}|${catName || "Default"}`,
      permissionOverwrites,
    });

    const embed = new EmbedBuilder()
      .setAuthor({ name: `Ticket #${ticketNumber}` })
      .setDescription(
        `Hello ${user.toString()}
        Support will be with you shortly
        ${catName ? `\n**Category:** ${catName}` : ""}
        `
      )
      .setFooter({ text: "You may close your ticket anytime by clicking the button below" });

    const buttonsRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setLabel("Close Ticket")
        .setCustomId("TICKET_CLOSE")
        .setEmoji("ðŸ”’")
        .setStyle(ButtonStyle.Primary)
    );

    await tktChannel.send({ content: user.toString(), embeds: [embed], components: [buttonsRow] });

    await interaction.editReply(`Ticket created ðŸ”¥ in <#${tktChannel.id}>`);
  } catch (ex) {
    error("handleTicketOpen", ex);
    interaction.editReply("Failed to create ticket channel, an error occurred!");
  }
}

/**
 * @param {import("discord.js").ButtonInteraction} interaction
 */
async function handleTicketClose(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const status = await closeTicket(interaction.channel, interaction.user);
  if (status === "SUCCESS") return interaction.editReply("Ticket closed");
  else if (status === "MISSING_PERMISSIONS")
    return interaction.editReply("Failed to close ticket. Missing `ManageChannels` permission");
  else return interaction.editReply("Failed to close ticket. Something went wrong!");
}

module.exports = {
  getTicketChannels,
  getExistingTicketChannel,
  handleTicketOpen,
  handleTicketClose,
  closeTicket,
  closeAllTickets,
  isTicketChannel,
};
    
