import type { FateSignalState } from './scoring.js';

export interface SignalEpisode {
  id: string;
  retailerId: string;
  startedAt: string;
  endedAt?: string;
  highestState: FateSignalState;
  highestScore: number;
  signals: string[];
  manifested: boolean;
  manifestedAt?: string;
  minutesToManifestation?: number;
  falseAlarm?: boolean;
}

const episodes = new Map<string, SignalEpisode>();

export function saveSignalEpisode(episode: SignalEpisode): SignalEpisode {
  episodes.set(episode.id, episode);
  return episode;
}

export function getSignalEpisode(id: string): SignalEpisode | undefined {
  return episodes.get(id);
}

export function listSignalEpisodes(retailerId?: string): SignalEpisode[] {
  return [...episodes.values()]
    .filter((episode) => !retailerId || episode.retailerId === retailerId)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export function markManifested(id: string, manifestedAt = new Date().toISOString()): SignalEpisode {
  const episode = episodes.get(id);
  if (!episode) throw new Error(`Unknown signal episode: ${id}`);

  const minutesToManifestation = Math.max(
    0,
    Math.round((new Date(manifestedAt).getTime() - new Date(episode.startedAt).getTime()) / 60000),
  );

  const updated: SignalEpisode = {
    ...episode,
    endedAt: manifestedAt,
    manifested: true,
    manifestedAt,
    minutesToManifestation,
    falseAlarm: false,
  };
  episodes.set(id, updated);
  return updated;
}

export function markFalseAlarm(id: string, endedAt = new Date().toISOString()): SignalEpisode {
  const episode = episodes.get(id);
  if (!episode) throw new Error(`Unknown signal episode: ${id}`);

  const updated: SignalEpisode = {
    ...episode,
    endedAt,
    manifested: false,
    falseAlarm: true,
  };
  episodes.set(id, updated);
  return updated;
}
