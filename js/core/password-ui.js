// js/core/password-ui.js
// Password helpers for the login and sign-up pages: a "Show password"
// checkbox, a live strength meter, and a live "passwords match" line.
//
// The meter is ADVICE only. The one hard rule is the minimum length, which
// signUpWithEmail() (auth.js) enforces; Firebase's own password policy, if
// you turn it on in the console, enforces it on the server too.

// A few of the most-used passwords. Not exhaustive — it just catches the
// ones people really type.
const COMMON_PASSWORDS = [
  'password', 'password1', 'password12', 'password123', 'passw0rd',
  '12345678', '123456789', '1234567890', '11111111', '00000000',
  'qwerty123', 'qwertyui', 'qwertyuiop', 'abc12345', 'abcd1234',
  'iloveyou', 'letmein1', 'welcome1', 'admin123', 'football',
  'baseball', 'sunshine', 'princess', 'superman', 'monkey123'
];

// Returns { level: 0-4, label, message }.
//   0 = nothing typed yet or too short, 1 = weak, 2 = okay, 3 = good, 4 = strong
function passwordStrength(pw) {
  pw = pw || '';
  if (!pw) return { level: 0, label: '', message: `At least ${MIN_PASSWORD_LENGTH} characters.` };

  if (pw.length < MIN_PASSWORD_LENGTH) {
    const left = MIN_PASSWORD_LENGTH - pw.length;
    return { level: 0, label: 'Too short', message: `Too short — ${left} more character${left === 1 ? '' : 's'} to go.` };
  }

  const lower = pw.toLowerCase();
  if (COMMON_PASSWORDS.includes(lower) || /^(.)\1+$/.test(pw)) {
    return { level: 1, label: 'Weak', message: "Weak — that's a very common password. Pick something less guessable." };
  }

  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter(r => r.test(pw)).length;
  let level = 1;
  if (pw.length >= 10 || classes >= 3) level = 2;
  if ((pw.length >= 12 && classes >= 2) || pw.length >= 16) level = 3;
  if ((pw.length >= 16 && classes >= 2) || pw.length >= 20) level = 4;

  const messages = {
    1: 'Weak — try making it longer, or mix in numbers or symbols.',
    2: 'Okay — a longer password is safer.',
    3: 'Good.',
    4: 'Strong.'
  };
  return { level, label: ['', 'Weak', 'Okay', 'Good', 'Strong'][level], message: messages[level] };
}

// "Show password" checkbox: flips every listed password field between
// hidden and visible.
function setupShowPassword(checkboxId, inputIds) {
  const box = document.getElementById(checkboxId);
  if (!box) return;
  box.addEventListener('change', () => {
    inputIds.forEach(id => {
      const input = document.getElementById(id);
      if (input) input.type = box.checked ? 'text' : 'password';
    });
  });
}

// Live strength bar + message under the password field.
function setupPasswordMeter(inputId, barId, hintId) {
  const input = document.getElementById(inputId);
  const bar = document.getElementById(barId);
  const hint = document.getElementById(hintId);
  if (!input || !bar || !hint) return;

  const update = () => {
    const s = passwordStrength(input.value);
    bar.className = 'pw-meter-bar pw-level-' + s.level;
    bar.style.width = (input.value ? Math.max(s.level, 1) * 25 : 0) + '%';
    hint.textContent = s.message;
  };
  input.addEventListener('input', update);
  update();
}

// Live "passwords match" line under the confirm field.
function setupConfirmMatch(passwordId, confirmId, hintId) {
  const pw = document.getElementById(passwordId);
  const confirm = document.getElementById(confirmId);
  const hint = document.getElementById(hintId);
  if (!pw || !confirm || !hint) return;

  const update = () => {
    if (!confirm.value) { hint.textContent = ''; hint.className = 'hint-text'; return; }
    const ok = confirm.value === pw.value;
    hint.textContent = ok ? '✔ Passwords match.' : "Passwords don't match yet.";
    hint.className = 'hint-text ' + (ok ? 'pw-match' : 'pw-nomatch');
  };
  pw.addEventListener('input', update);
  confirm.addEventListener('input', update);
}
