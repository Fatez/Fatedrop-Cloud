export const CANONICAL_EPISODE_STAGES = Object.freeze(["whisper", "echo", "manifested", "vanished"]);

const STAGES = new Set(CANONICAL_EPISODE_STAGES);

export function availabilityEffectForStage(stage) {
  if (stage === "manifested") return "available";
  if (stage === "vanished") return "unavailable";
  if (stage === "whisper" || stage === "echo") return "none";
  return null;
}

function startEpisode(stage, nextCycleNumber) {
  if (stage === "vanished") {
    return { accepted: false, conflictReason: "vanished_without_prior_manifested" };
  }
  if (stage === "manifested") {
    return {
      accepted: true,
      create: true,
      cycleNumber: nextCycleNumber,
      episodeState: "available",
      availabilityState: "available",
    };
  }
  return {
    accepted: true,
    create: true,
    cycleNumber: nextCycleNumber,
    episodeState: "evidence_open",
    availabilityState: "never_manifested",
  };
}

export function canonicalEpisodeTransition({ stage, currentEpisode = null, occurredAt } = {}) {
  if (!STAGES.has(stage)) return { accepted: false, conflictReason: "unsupported_lifecycle_stage" };
  const eventTime = Number(occurredAt);
  if (!Number.isFinite(eventTime) || eventTime <= 0) {
    return { accepted: false, conflictReason: "invalid_event_time" };
  }

  if (!currentEpisode) return startEpisode(stage, 1);

  const latestEventAt = Number(currentEpisode.latestEventAt);
  if (Number.isFinite(latestEventAt) && eventTime < latestEventAt) {
    return { accepted: false, conflictReason: "out_of_order_episode_event" };
  }

  const cycleNumber = Math.max(1, Number(currentEpisode.cycleNumber) || 1);
  if (currentEpisode.episodeState === "closed") return startEpisode(stage, cycleNumber + 1);

  if (stage === "vanished") {
    if (currentEpisode.availabilityState !== "available" || !currentEpisode.manifestedAt) {
      return { accepted: false, conflictReason: "vanished_without_prior_manifested" };
    }
    return {
      accepted: true,
      create: false,
      cycleNumber,
      episodeState: "closed",
      availabilityState: "vanished",
    };
  }

  if (stage === "manifested") {
    return {
      accepted: true,
      create: false,
      cycleNumber,
      episodeState: "available",
      availabilityState: "available",
    };
  }

  // Whisper and Echo are evidence/readiness progression only. They can enrich
  // an evidence-only or available episode but can never alter stock truth.
  return {
    accepted: true,
    create: false,
    cycleNumber,
    episodeState: currentEpisode.episodeState,
    availabilityState: currentEpisode.availabilityState,
  };
}
