async function addDiscordRole(discordId, roleName) {
  if (!discordId || !roleName) return;
  // Placeholder integration hook. Wire to your Discord bot service.
  if (process.env.NODE_ENV !== 'production') {
    console.log(`[DiscordRole] add ${roleName} -> ${discordId}`);
  }
}

async function removeDiscordRole(discordId, roleName) {
  if (!discordId || !roleName) return;
  // Placeholder integration hook. Wire to your Discord bot service.
  if (process.env.NODE_ENV !== 'production') {
    console.log(`[DiscordRole] remove ${roleName} -> ${discordId}`);
  }
}

module.exports = { addDiscordRole, removeDiscordRole };
