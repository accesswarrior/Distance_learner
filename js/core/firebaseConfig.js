// js/core/firebaseConfig.js
// Reuses the existing access-warrior-1d789 Firebase project.
// Game data is namespaced under per-game prefixed collections ("werewolf_...")
// so it never collides with any other app sharing this project. The account
// collections keep the legacy "werewolf_" names but serve every game (README).

const firebaseConfig = {
  apiKey: "AIzaSyBwJzpnmSV845YrDDZYOVntL6sfFAVGaag",
  authDomain: "access-warrior-1d789.firebaseapp.com",
  projectId: "access-warrior-1d789",
  storageBucket: "access-warrior-1d789.firebasestorage.app",
  messagingSenderId: "875315539922",
  appId: "1:875315539922:web:df434dfd4316c0a457620b"
};

firebase.initializeApp(firebaseConfig);

const auth = firebase.auth();
const db = firebase.firestore();
