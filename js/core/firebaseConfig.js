// js/core/firebaseConfig.js
// Firebase project for the whole platform. Paste YOUR project's web-app
// config below (Firebase console -> Project settings -> Your apps -> SDK
// setup and configuration -> "Config").
//
// These values are identifiers, not secrets: every visitor's browser has to
// have them. What protects the data is firestore.rules, not hiding this file.
//
// Collections: accounts are `users/{uid}`; each game has its own session
// collection (`werewolf_sessions`, `spyfall_sessions`, ...).

const firebaseConfig = {
  apiKey: "AIzaSyBwJzpnmSV845YrDDZYOVntL6sfFAVGaag",
  authDomain: "access-warrior-1d789.firebaseapp.com",
  projectId: "access-warrior-1d789",
  storageBucket: "access-warrior-1d789.firebasestorage.app",
  messagingSenderId: "875315539922",
  appId: "1:875315539922:web:df434dfd4316c0a457620b"
};

// Fail loudly (instead of with a confusing Firebase error) if the config
// above hasn't been filled in yet.
if (String(firebaseConfig.apiKey).startsWith('YOUR_')) {
  const msg = 'Firebase is not configured yet — edit js/core/firebaseConfig.js with your project\'s config.';
  console.error(msg);
  document.addEventListener('DOMContentLoaded', () => {
    const bar = document.createElement('div');
    bar.textContent = msg;
    bar.style.cssText = 'position:fixed;top:0;left:0;right:0;padding:10px;background:#a5203f;color:#fff;font:14px sans-serif;text-align:center;z-index:9999';
    document.body.appendChild(bar);
  });
}

firebase.initializeApp(firebaseConfig);

const auth = firebase.auth();
const db = firebase.firestore();
