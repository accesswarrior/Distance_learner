// js/games/werewolf/rules.js

function assignRoles(playerCount) {
  // Simple distribution: 2 werewolves, 1 seer, 1 doctor, rest villagers.
  const numWerewolves = 2;
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
