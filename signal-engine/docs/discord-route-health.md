# Discord lifecycle route health

FateDrop verifies each dedicated lifecycle bot independently:

- Oru → Whisper
- Fenn → Echo
- Koru → Manifested
- Nyxen → Vanished

The runtime probe authenticates the dedicated bot token, verifies the bot identity, reads the assigned lifecycle channel, then calls Discord's non-persistent typing endpoint. It does not create a FateDrop signal, write a catalogue event, or post a persistent test message.

The cached public result is exposed at `/api/discord-route-health`. The response contains companion names, channel names and health reasons only; token values and channel IDs are never returned.

A route is unhealthy when the dedicated token or lifecycle channel is missing, the token belongs to the wrong companion, Discord authentication fails, the channel cannot be read, or the bot cannot interact with the channel. Legacy generic-token fallback remains available to ordinary signal delivery during migration, but it does not count as a healthy four-companion route.

During the spelling migration, `DISCORD_NYXEN_BOT_TOKEN` is canonical and `DISCORD_NIXON_BOT_TOKEN` remains a temporary backward-compatible fallback. The Vanished channel is bound by channel ID, so renaming an existing Discord channel does not break routing.
