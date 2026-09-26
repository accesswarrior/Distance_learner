// js/games/werewolf/narrator.js
// Turns the moderator's raw game state into a plain-language "what to say
// and do right now" line. Pure function — reads state, never writes.

const ROLE_DESCRIPTIONS = {
  chief_werewolf: "Chooses who the werewolves kill each night, after the group quietly agrees out loud.",
  werewolf:       "Knows the other werewolves. Discusses the kill out loud at night; only the Chief submits it in the app.",
  seer:           "Each night, checks one player and privately learns whether they're a Werewolf.",
  doctor:         "Each night, chooses one player to protect from the werewolves' kill.",
  witch:          "Sees who the werewolves targeted each night. Has one Heal Potion (saves that target) and one Poison Potion (eliminates anyone else) — each usable once per game.",
  hunter:         "If eliminated by any means, immediately chooses one more player to eliminate before play continues.",
  villager:       "No special ability. Wins by helping the group find and vote out the werewolves."
};

// sessionData: the live session doc.
// nightActionsMap: { role: {...} } from ui.js's listener — used only to
// know whether the active role has already chosen.
function narratorLine(sessionData, nightActionsMap) {
  if (sessionData.winner) {
    return 'Announce the winner, then tap "Play Again" if the group wants another round.';
  }

  if (sessionData.pendingHunterShot) {
    return "The Hunter was just eliminated — reveal that out loud. They're choosing a final target on their own phone right now; the game holds here until they do.";
  }

  const phase = sessionData.phase || 'day';
  const step  = sessionData.nightStep || null;

  if (phase === 'night') {
    const acted = role => !!nightActionsMap[role];
    if (step === 'doctor') {
      return acted('doctor')
        ? 'Say: "Doctor, go back to sleep." Then tap Next.'
        : 'Say: "Everyone, close your eyes. Doctor, wake up and choose who to protect tonight."';
    }
    if (step === 'chief_werewolf') {
      return acted('chief_werewolf')
        ? 'Say: "Werewolves, go back to sleep." Then tap Next.'
        : 'Say: "Werewolves, wake up and look around silently." Give them a moment to agree quietly out loud, then: "Chief Werewolf, choose your target."';
    }
    if (step === 'witch') {
      return acted('witch')
        ? 'Say: "Witch, go back to sleep." Then tap Next.'
        : 'Say: "Witch, wake up." They\u2019ll see who the werewolves targeted and decide whether to save, poison, or do nothing.';
    }
    if (step === 'seer') {
      return acted('seer')
        ? 'Say: "Seer, go back to sleep." Then tap Next.'
        : 'Say: "Seer, wake up and choose someone to check."';
    }
    if (step === 'done') {
      return 'Say: "Everyone... wake up." Tap "End Night" to reveal what happened.';
    }
    return 'Night in progress.';
  }

  // Day phase
  if (sessionData.votingOpen) {
    return sessionData.voteEligibleTargets
      ? "It's a runoff — only the tied names are eligible this round. Once most people have voted, tap Reveal Result."
      : 'Open the floor for discussion, then have everyone vote on their phones. Once most people have voted, tap Reveal Result.';
  }

  if (sessionData.announcement) {
    const type = sessionData.announcement.type;
    if (type === 'tie' || type === 'still_tied') {
      return 'Announce the tie out loud, then start the runoff vote when ready.';
    }
    if (type === 'hunter_pending') {
      return 'The Hunter is choosing their final shot. Wait for it before moving on.';
    }
    return 'Wait for every phone to tap "I\'ve seen this", then move on.';
  }

  return 'Once everyone has read their role, tap Start Night to begin Night 1 (or Start Voting to skip straight to a day round).';
}
