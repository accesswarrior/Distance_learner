// js/games/werewolf/rules.js

function assignRoles(playerCount) {
  // Scales werewolves roughly 1 per 4 players (minimum 2), keeps seer and
  // doctor fixed at 1 each, and fills the rest with villagers.
  const numWerewolves = Math.max(2, Math.round(playerCount / 4));
  const numSeer = 1;
  const numDoctor = 1;
  const numVillagers = Math.max(0, playerCount - numWerewolves - numSeer - numDoctor);

  const roles = [];
  for (let i = 0; i < numWerewolves; i++) roles.push('werewolf');
  for (let i = 0; i < numSeer; i++) roles.push('seer');
  for (let i = 0; i < numDoctor; i++) roles.push('doctor');
  for (let i = 0; i < numVillagers; i++) roles.push('villager');

  // Shuffle (Fisher-Yates)
  for (let i = roles.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [roles[i], roles[j]] = [roles[j], roles[i]];
  }
  return roles;
}

// players: array of { role, alive }. Returns 'werewolves', 'villagers', or
// null if the game should continue. Checked after every elimination —
// whether it came from a vote or the moderator's manual "Eliminate" button.
function checkWinCondition(players) {
  const aliveWerewolves = players.filter(p => p.alive !== false && p.role === 'werewolf').length;
  const aliveOthers = players.filter(p => p.alive !== false && p.role !== 'werewolf').length;

  if (aliveWerewolves === 0) return 'villagers';
  if (aliveWerewolves >= aliveOthers) return 'werewolves';
  return null;
}
