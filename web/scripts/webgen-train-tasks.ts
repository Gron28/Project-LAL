// Training task registry for webgen SFT — DISJOINT from the webgen bench suite
// (different apps entirely; snake is deliberately absent and must stay absent: it is
// the user's private blind test). Each task: a bench-style one-shot prompt, probes for
// the headless grader, and a Claude-authored exemplar that must pass its own probes
// before it may enter the training set.
export type TrainTask = { id: string; prompt: string; probes: string; exemplar: string };

const H = (s: string) => "```html\n" + s.trim() + "\n```";

export const TRAIN_TASKS: TrainTask[] = [
  {
    id: "tic-tac-toe",
    prompt: "Code a two-player tic-tac-toe game as a single self-contained HTML file. A 3x3 grid inside a container with id \"board\", a status line with id \"status\" saying whose turn it is (X starts) and announcing the winner or a draw, and a restart button with id \"restart\". Winning cells should be visually highlighted. Reply with one complete HTML file in a ```html code block.",
    probes: "const b=$('#board');probe('board exists',!!b&&b.children.length>=9);probe('status exists',!!$('#status'));probe('restart exists',!!$('#restart'));\nif(b){const c=Array.from(b.children);clickEl(c[0]);await sleep(100);probe('click marks cell',/[XO]/.test(c[0].textContent));const t0=$('#status').textContent;clickEl(c[1]);await sleep(100);probe('turn changes',$('#status').textContent!==t0||/O/.test(c[1].textContent));clickEl($('#restart'));await sleep(100);probe('restart clears',!/[XO]/.test(b.textContent));}else{probe('click marks cell',false);probe('turn changes',false);probe('restart clears',false);}",
    exemplar: H(`
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Tic-Tac-Toe</title>
<style>
  body { font-family: system-ui, sans-serif; background: #1a1a2e; color: #eee; display: flex; flex-direction: column; align-items: center; padding-top: 40px; }
  #status { font-size: 1.2rem; margin-bottom: 16px; min-height: 1.5em; }
  #board { display: grid; grid-template-columns: repeat(3, 90px); gap: 6px; }
  .cell { height: 90px; background: #16213e; border: 2px solid #0f3460; border-radius: 8px; font-size: 3rem; color: #eee; cursor: pointer; display: flex; align-items: center; justify-content: center; transition: background .15s; }
  .cell:hover { background: #0f3460; }
  .cell.win { background: #e94560; border-color: #e94560; }
  #restart { margin-top: 20px; padding: 8px 24px; font-size: 1rem; background: #0f3460; color: #eee; border: none; border-radius: 6px; cursor: pointer; }
  #restart:hover { filter: brightness(1.3); }
</style>
</head>
<body>
<div id="status">X's turn</div>
<div id="board"></div>
<button id="restart">Restart</button>
<script>
const board = document.getElementById('board');
const status = document.getElementById('status');
const LINES = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
let cells = [], grid, turn, over;

function reset() {
  grid = Array(9).fill(''); turn = 'X'; over = false;
  board.innerHTML = ''; cells = [];
  for (let i = 0; i < 9; i++) {
    const c = document.createElement('button');
    c.className = 'cell';
    c.addEventListener('click', () => play(i));
    board.appendChild(c); cells.push(c);
  }
  status.textContent = "X's turn";
}

function play(i) {
  if (over || grid[i]) return;
  grid[i] = turn; cells[i].textContent = turn;
  const win = LINES.find(l => l.every(j => grid[j] === turn));
  if (win) {
    win.forEach(j => cells[j].classList.add('win'));
    status.textContent = turn + ' wins!'; over = true;
  } else if (grid.every(v => v)) {
    status.textContent = "It's a draw"; over = true;
  } else {
    turn = turn === 'X' ? 'O' : 'X';
    status.textContent = turn + "'s turn";
  }
}

document.getElementById('restart').addEventListener('click', reset);
reset();
</script>
</body>
</html>`),
  },
  {
    id: "rock-paper-scissors",
    prompt: "Code a rock-paper-scissors game against the computer as a single self-contained HTML file. Three buttons with ids \"rock\", \"paper\", \"scissors\"; after each round show both choices and the outcome in an element with id \"result\", and keep running totals in elements with ids \"player-score\" and \"cpu-score\". Reply with one complete HTML file in a ```html code block.",
    probes: "probe('buttons exist',!!$('#rock')&&!!$('#paper')&&!!$('#scissors'));probe('scores exist',!!$('#player-score')&&!!$('#cpu-score')&&/\\d/.test($('#player-score').textContent));\nconst r0=$('#result')?.textContent||'';let changed=false,scored=false;\nfor(let i=0;i<6;i++){clickEl($('#rock'));await sleep(80);if(($('#result')?.textContent||'')!==r0)changed=true;const p=parseInt($('#player-score').textContent.match(/\\d+/)?.[0]||'0'),c=parseInt($('#cpu-score').textContent.match(/\\d+/)?.[0]||'0');if(p+c>0)scored=true;}\nprobe('result updates',changed);probe('scores accumulate',scored);",
    exemplar: H(`
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Rock Paper Scissors</title>
<style>
  body { font-family: system-ui, sans-serif; background: #222831; color: #eee; text-align: center; padding-top: 50px; }
  .choices button { font-size: 2.5rem; background: #393e46; border: 2px solid #00adb5; border-radius: 12px; padding: 14px 20px; margin: 0 8px; cursor: pointer; transition: transform .1s; }
  .choices button:hover { transform: scale(1.1); }
  #result { font-size: 1.1rem; margin: 24px 0; min-height: 2.5em; white-space: pre-line; }
  #scoreboard { font-size: 1.3rem; color: #00adb5; }
</style>
</head>
<body>
<h1>Rock · Paper · Scissors</h1>
<div class="choices">
  <button id="rock" title="rock">🪨</button>
  <button id="paper" title="paper">📄</button>
  <button id="scissors" title="scissors">✂️</button>
</div>
<div id="result">Make your move…</div>
<div id="scoreboard">You <span id="player-score">0</span> : <span id="cpu-score">0</span> CPU</div>
<script>
const MOVES = ['rock', 'paper', 'scissors'];
const EMOJI = { rock: '🪨', paper: '📄', scissors: '✂️' };
const BEATS = { rock: 'scissors', paper: 'rock', scissors: 'paper' };
let player = 0, cpu = 0;

function play(mine) {
  const theirs = MOVES[Math.floor(Math.random() * 3)];
  let outcome;
  if (mine === theirs) outcome = 'Tie!';
  else if (BEATS[mine] === theirs) { player++; outcome = 'You win the round!'; }
  else { cpu++; outcome = 'CPU wins the round.'; }
  document.getElementById('result').textContent =
    'You ' + EMOJI[mine] + '  vs  ' + EMOJI[theirs] + ' CPU\\n' + outcome;
  document.getElementById('player-score').textContent = player;
  document.getElementById('cpu-score').textContent = cpu;
}

for (const m of MOVES) document.getElementById(m).addEventListener('click', () => play(m));
</script>
</body>
</html>`),
  },
  {
    id: "hangman",
    prompt: "Code a hangman word-guessing game as a single self-contained HTML file. A hidden word from a built-in list shown as blanks in an element with id \"word\", an on-screen A-Z letter keyboard inside a container with id \"letters\" (used letters get disabled), remaining lives in an element with id \"lives\" (start with 6), and a new-game button with id \"new-game\". Show a win/lose message in an element with id \"message\". Reply with one complete HTML file in a ```html code block.",
    probes: "probe('word blanks',!!$('#word')&&/_/.test($('#word').textContent));probe('26 letters',!!$('#letters')&&$('#letters').querySelectorAll('button').length===26);probe('lives 6',!!$('#lives')&&$('#lives').textContent.includes('6'));probe('new-game exists',!!$('#new-game'));\nconst btns=Array.from($('#letters')?.querySelectorAll('button')||[]);\nif(btns.length){const b=btns[4];clickEl(b);await sleep(100);probe('letter disables',b.disabled||b.classList.length>0&&b.outerHTML.includes('disabled')||b.disabled===true);}else probe('letter disables',false);",
    exemplar: H(`
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Hangman</title>
<style>
  body { font-family: system-ui, sans-serif; background: #2d2d44; color: #f0f0f0; text-align: center; padding-top: 36px; }
  #word { font-size: 2.2rem; letter-spacing: 12px; margin: 20px 0; font-family: monospace; }
  #letters { max-width: 480px; margin: 0 auto; display: flex; flex-wrap: wrap; gap: 6px; justify-content: center; }
  #letters button { width: 40px; height: 40px; font-size: 1rem; background: #44446a; color: #fff; border: none; border-radius: 6px; cursor: pointer; }
  #letters button:disabled { opacity: .3; cursor: default; }
  #lives { font-size: 1.2rem; margin: 16px; }
  #message { font-size: 1.4rem; min-height: 1.6em; color: #ffd369; }
  #new-game { margin-top: 12px; padding: 8px 22px; background: #ffd369; border: none; border-radius: 6px; font-size: 1rem; cursor: pointer; }
</style>
</head>
<body>
<h1>Hangman</h1>
<div id="lives">Lives: 6</div>
<div id="word"></div>
<div id="letters"></div>
<div id="message"></div>
<button id="new-game">New game</button>
<script>
const WORDS = ['galaxy', 'puzzle', 'wizard', 'jungle', 'rocket', 'meadow', 'python', 'copper', 'island', 'shadow'];
const wordEl = document.getElementById('word');
const livesEl = document.getElementById('lives');
const msgEl = document.getElementById('message');
const lettersEl = document.getElementById('letters');
let word, guessed, lives, over;

function render() {
  wordEl.textContent = [...word].map(ch => guessed.has(ch) ? ch.toUpperCase() : '_').join('');
  livesEl.textContent = 'Lives: ' + lives;
}

function guess(ch, btn) {
  if (over) return;
  btn.disabled = true;
  if (word.includes(ch)) {
    guessed.add(ch);
    if ([...word].every(c => guessed.has(c))) { msgEl.textContent = '🎉 You got it: ' + word.toUpperCase(); over = true; }
  } else {
    lives--;
    if (lives <= 0) { msgEl.textContent = '💀 Out of lives — it was ' + word.toUpperCase(); over = true; }
  }
  render();
}

function newGame() {
  word = WORDS[Math.floor(Math.random() * WORDS.length)];
  guessed = new Set(); lives = 6; over = false;
  msgEl.textContent = '';
  lettersEl.innerHTML = '';
  for (let i = 0; i < 26; i++) {
    const ch = String.fromCharCode(97 + i);
    const b = document.createElement('button');
    b.textContent = ch.toUpperCase();
    b.addEventListener('click', () => guess(ch, b));
    lettersEl.appendChild(b);
  }
  render();
}

document.getElementById('new-game').addEventListener('click', newGame);
newGame();
</script>
</body>
</html>`),
  },
  {
    id: "quiz",
    prompt: "Code a multiple-choice quiz app as a single self-contained HTML file with at least 4 built-in questions. Show one question at a time in an element with id \"question\", its answer choices as buttons inside a container with id \"choices\", progress like \"2 / 4\" in an element with id \"progress\", and after the last question show the final score in an element with id \"score\" plus a restart button with id \"restart\". Picking an answer should briefly show right/wrong before advancing. Reply with one complete HTML file in a ```html code block.",
    probes: "probe('question shown',!!$('#question')&&$('#question').textContent.trim().length>5);probe('choices exist',!!$('#choices')&&$('#choices').querySelectorAll('button').length>=2);probe('progress format',!!$('#progress')&&/1\\s*\\/\\s*\\d/.test($('#progress').textContent));\nconst q0=$('#question').textContent;const btn=$('#choices').querySelector('button');clickEl(btn);await sleep(1300);\nprobe('advances after answer',$('#question')?.textContent!==q0||!!$('#score'));\nfor(let i=0;i<8;i++){const b=$('#choices')?.querySelector('button');if(!b)break;clickEl(b);await sleep(1300);}\nprobe('score at end',!!$('#score')&&/\\d/.test($('#score').textContent));probe('restart at end',!!$('#restart'));",
    exemplar: H(`
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Quick Quiz</title>
<style>
  body { font-family: system-ui, sans-serif; background: #10162f; color: #eee; display: flex; justify-content: center; padding-top: 60px; }
  #app { width: min(560px, 92vw); background: #1b2447; border-radius: 14px; padding: 28px; }
  #progress { color: #7c9cff; font-size: .9rem; margin-bottom: 10px; }
  #question { font-size: 1.25rem; margin-bottom: 20px; min-height: 3em; }
  #choices button { display: block; width: 100%; text-align: left; margin: 8px 0; padding: 12px 16px; font-size: 1rem; background: #26305c; color: #eee; border: 2px solid transparent; border-radius: 8px; cursor: pointer; }
  #choices button.right { border-color: #34d399; background: #14532d; }
  #choices button.wrong { border-color: #f87171; background: #7f1d1d; }
  #score { font-size: 1.5rem; text-align: center; margin: 20px 0; }
  #restart { display: block; margin: 0 auto; padding: 10px 28px; background: #7c9cff; border: none; border-radius: 8px; font-size: 1rem; cursor: pointer; }
</style>
</head>
<body>
<div id="app">
  <div id="progress"></div>
  <div id="question"></div>
  <div id="choices"></div>
</div>
<script>
const QUESTIONS = [
  { q: 'Which planet is known as the Red Planet?', c: ['Venus', 'Mars', 'Jupiter', 'Mercury'], a: 1 },
  { q: 'What is the largest ocean on Earth?', c: ['Atlantic', 'Indian', 'Pacific', 'Arctic'], a: 2 },
  { q: 'How many sides does a hexagon have?', c: ['5', '6', '7', '8'], a: 1 },
  { q: 'Which gas do plants absorb from the air?', c: ['Oxygen', 'Nitrogen', 'Hydrogen', 'Carbon dioxide'], a: 3 },
  { q: 'What is the capital of Japan?', c: ['Kyoto', 'Osaka', 'Tokyo', 'Nagoya'], a: 2 },
];
const app = document.getElementById('app');
const qEl = document.getElementById('question');
const cEl = document.getElementById('choices');
const pEl = document.getElementById('progress');
let idx = 0, score = 0, locked = false;

function show() {
  const item = QUESTIONS[idx];
  pEl.textContent = (idx + 1) + ' / ' + QUESTIONS.length;
  qEl.textContent = item.q;
  cEl.innerHTML = ''; locked = false;
  item.c.forEach((choice, i) => {
    const b = document.createElement('button');
    b.textContent = choice;
    b.addEventListener('click', () => pick(i, b));
    cEl.appendChild(b);
  });
}

function pick(i, btn) {
  if (locked) return;
  locked = true;
  const item = QUESTIONS[idx];
  if (i === item.a) { score++; btn.classList.add('right'); }
  else { btn.classList.add('wrong'); cEl.children[item.a].classList.add('right'); }
  setTimeout(() => {
    idx++;
    if (idx < QUESTIONS.length) show();
    else finish();
  }, 1000);
}

function finish() {
  app.innerHTML = '<div id="score">You scored ' + score + ' / ' + QUESTIONS.length + '</div>' +
                  '<button id="restart">Play again</button>';
  document.getElementById('restart').addEventListener('click', () => { location.reload(); });
}

show();
</script>
</body>
</html>`),
  },
  {
    id: "stopwatch",
    prompt: "Code a stopwatch as a single self-contained HTML file. Elapsed time shown as MM:SS.cc (centiseconds) in an element with id \"display\", buttons with ids \"start\", \"stop\", \"lap\" and \"reset\", and recorded laps appended to a list with id \"laps\". Start must be idempotent (clicking twice doesn't double the speed). Reply with one complete HTML file in a ```html code block.",
    probes: "probe('display format',!!$('#display')&&/\\d{2}:\\d{2}\\.\\d{2}/.test($('#display').textContent));probe('buttons exist',!!$('#start')&&!!$('#stop')&&!!$('#lap')&&!!$('#reset'));\nclickEl($('#start'));await sleep(700);const t1=$('#display').textContent;probe('runs',t1!=='00:00.00');\nclickEl($('#start'));const a=$('#display').textContent;await sleep(500);const b=$('#display').textContent;\nclickEl($('#lap'));await sleep(80);probe('lap recorded',($('#laps')?.children.length||0)>=1);\nclickEl($('#stop'));await sleep(120);const s1=$('#display').textContent;await sleep(400);probe('stop freezes',$('#display').textContent===s1);\nclickEl($('#reset'));await sleep(80);probe('reset zeroes',/00:00\\.?0?0?/.test($('#display').textContent)&&($('#laps')?.children.length||0)===0);",
    exemplar: H(`
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Stopwatch</title>
<style>
  body { font-family: system-ui, sans-serif; background: #0d1117; color: #e6edf3; text-align: center; padding-top: 60px; }
  #display { font-family: ui-monospace, monospace; font-size: 4rem; margin-bottom: 24px; }
  button { font-size: 1rem; padding: 10px 22px; margin: 0 6px; border: none; border-radius: 8px; cursor: pointer; color: #0d1117; }
  #start { background: #3fb950; } #stop { background: #f85149; } #lap { background: #d29922; } #reset { background: #8b949e; }
  #laps { list-style: none; padding: 0; margin-top: 24px; font-family: ui-monospace, monospace; }
  #laps li { padding: 4px; color: #8b949e; }
</style>
</head>
<body>
<div id="display">00:00.00</div>
<div>
  <button id="start">Start</button>
  <button id="stop">Stop</button>
  <button id="lap">Lap</button>
  <button id="reset">Reset</button>
</div>
<ol id="laps"></ol>
<script>
const display = document.getElementById('display');
const laps = document.getElementById('laps');
let startAt = 0, acc = 0, raf = null;

function fmt(ms) {
  const m = Math.floor(ms / 60000), s = Math.floor(ms / 1000) % 60, c = Math.floor(ms / 10) % 100;
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return p(m) + ':' + p(s) + '.' + p(c);
}
function now() { return acc + (raf ? performance.now() - startAt : 0); }
function tick() { display.textContent = fmt(now()); raf = requestAnimationFrame(tick); }

document.getElementById('start').addEventListener('click', () => {
  if (raf) return;                       // idempotent: already running
  startAt = performance.now();
  raf = requestAnimationFrame(tick);
});
document.getElementById('stop').addEventListener('click', () => {
  if (!raf) return;
  acc += performance.now() - startAt;
  cancelAnimationFrame(raf); raf = null;
  display.textContent = fmt(acc);
});
document.getElementById('lap').addEventListener('click', () => {
  const li = document.createElement('li');
  li.textContent = 'Lap ' + (laps.children.length + 1) + ' — ' + fmt(now());
  laps.appendChild(li);
});
document.getElementById('reset').addEventListener('click', () => {
  if (raf) { cancelAnimationFrame(raf); raf = null; }
  acc = 0; display.textContent = '00:00.00'; laps.innerHTML = '';
});
</script>
</body>
</html>`),
  },
  {
    id: "dice-roller",
    prompt: "Code a dice roller as a single self-contained HTML file. A number input with id \"count\" (1-6 dice, default 2), a roll button with id \"roll\", the dice rendered as large unicode/emoji faces inside a container with id \"dice\", and the sum shown in an element with id \"total\". Each roll should re-randomize all dice. Reply with one complete HTML file in a ```html code block.",
    probes: "probe('controls exist',!!$('#count')&&!!$('#roll')&&!!$('#dice')&&!!$('#total'));\nclickEl($('#roll'));await sleep(150);const d1=$('#dice').textContent;probe('dice rendered',d1.trim().length>0);probe('total numeric',/\\d/.test($('#total').textContent));\n$('#count').value='6';$('#count').dispatchEvent(new Event('input',{bubbles:true}));$('#count').dispatchEvent(new Event('change',{bubbles:true}));clickEl($('#roll'));await sleep(150);\nprobe('count respected',($('#dice').children.length||$('#dice').textContent.trim().split(/\\s+/).length)>=5);\nconst t=parseInt($('#total').textContent.match(/\\d+/)?.[0]||'0');probe('total plausible',t>=6&&t<=36);",
    exemplar: H(`
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Dice Roller</title>
<style>
  body { font-family: system-ui, sans-serif; background: #1e293b; color: #f1f5f9; text-align: center; padding-top: 50px; }
  #controls { margin-bottom: 28px; }
  #count { width: 60px; font-size: 1.1rem; padding: 6px; border-radius: 6px; border: none; text-align: center; }
  #roll { font-size: 1.1rem; padding: 8px 26px; margin-left: 10px; background: #38bdf8; border: none; border-radius: 8px; cursor: pointer; }
  #dice { font-size: 4rem; min-height: 1.4em; letter-spacing: 10px; }
  #total { font-size: 1.6rem; margin-top: 18px; color: #38bdf8; }
</style>
</head>
<body>
<h1>🎲 Dice Roller</h1>
<div id="controls">
  <label>Dice: <input id="count" type="number" min="1" max="6" value="2"></label>
  <button id="roll">Roll</button>
</div>
<div id="dice"></div>
<div id="total"></div>
<script>
const FACES = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];
const diceEl = document.getElementById('dice');
const totalEl = document.getElementById('total');
const countEl = document.getElementById('count');

function roll() {
  const n = Math.min(6, Math.max(1, parseInt(countEl.value) || 2));
  countEl.value = n;
  let sum = 0;
  diceEl.innerHTML = '';
  for (let i = 0; i < n; i++) {
    const v = 1 + Math.floor(Math.random() * 6);
    sum += v;
    const span = document.createElement('span');
    span.textContent = FACES[v - 1];
    diceEl.appendChild(span);
  }
  totalEl.textContent = 'Total: ' + sum;
}

document.getElementById('roll').addEventListener('click', roll);
roll();
</script>
</body>
</html>`),
  },
  {
    id: "reaction-time",
    prompt: "Code a reaction-time tester as a single self-contained HTML file. A large clickable panel with id \"panel\" that starts gray with the text \"Click to start\"; after a click it turns red saying \"Wait for green…\" for a random 1-4s delay, then turns green saying \"CLICK!\". Clicking on green shows the reaction time in ms in an element with id \"result\" and the best time so far in an element with id \"best\". Clicking too early on red shows \"Too soon!\" and resets. Reply with one complete HTML file in a ```html code block.",
    probes: "const p=$('#panel');probe('panel exists',!!p);probe('start text',/click to start/i.test(p?.textContent||''));\nclickEl(p);await sleep(300);probe('waiting state',/wait/i.test(p.textContent));\nclickEl(p);await sleep(150);probe('too-soon handled',/too soon/i.test(p.textContent+$('#result')?.textContent)||/click to start|wait/i.test(p.textContent));\nclickEl(p);await sleep(4300);\nif(/click/i.test(p.textContent)&&!/wait|start/i.test(p.textContent)){clickEl(p);await sleep(120);probe('reaction ms shown',/\\d+\\s*ms/.test($('#result')?.textContent||''));probe('best tracked',/\\d+\\s*ms/.test($('#best')?.textContent||''));}else{probe('reaction ms shown',false);probe('best tracked',false);}",
    exemplar: H(`
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Reaction Time</title>
<style>
  body { font-family: system-ui, sans-serif; background: #111; color: #eee; text-align: center; padding-top: 40px; }
  #panel { width: min(520px, 90vw); height: 300px; margin: 24px auto; border-radius: 16px; display: flex; align-items: center; justify-content: center; font-size: 1.6rem; cursor: pointer; user-select: none; background: #555; transition: background .1s; }
  #panel.waiting { background: #c0392b; }
  #panel.go { background: #27ae60; }
  #result, #best { font-size: 1.2rem; min-height: 1.5em; }
  #best { color: #f1c40f; }
</style>
</head>
<body>
<h1>Reaction Time</h1>
<div id="panel">Click to start</div>
<div id="result"></div>
<div id="best"></div>
<script>
const panel = document.getElementById('panel');
const result = document.getElementById('result');
const bestEl = document.getElementById('best');
let state = 'idle', timer = null, goAt = 0, best = Infinity;

panel.addEventListener('click', () => {
  if (state === 'idle') {
    state = 'waiting';
    panel.className = 'waiting';
    panel.textContent = 'Wait for green…';
    timer = setTimeout(() => {
      state = 'go';
      panel.className = 'go';
      panel.textContent = 'CLICK!';
      goAt = performance.now();
    }, 1000 + Math.random() * 3000);
  } else if (state === 'waiting') {
    clearTimeout(timer);
    state = 'idle';
    panel.className = '';
    panel.textContent = 'Click to start';
    result.textContent = 'Too soon! Wait for green.';
  } else if (state === 'go') {
    const ms = Math.round(performance.now() - goAt);
    state = 'idle';
    panel.className = '';
    panel.textContent = 'Click to start';
    result.textContent = 'Your time: ' + ms + ' ms';
    if (ms < best) { best = ms; bestEl.textContent = 'Best: ' + best + ' ms'; }
  }
});
</script>
</body>
</html>`),
  },
  {
    id: "color-guesser",
    prompt: "Code an RGB color-guessing game as a single self-contained HTML file. Show a target color as text like \"rgb(120, 45, 200)\" in an element with id \"target\", six colored swatch buttons inside a container with id \"swatches\" (one matches the target), a streak counter in an element with id \"streak\", and feedback in an element with id \"feedback\". A correct pick starts a new round and increments the streak; a wrong pick just removes that swatch and resets the streak. Reply with one complete HTML file in a ```html code block.",
    probes: "probe('target rgb text',!!$('#target')&&/rgb\\(\\s*\\d+,\\s*\\d+,\\s*\\d+\\s*\\)/i.test($('#target').textContent));\nconst sw=$('#swatches');probe('6 swatches',!!sw&&sw.querySelectorAll('button').length===6);probe('streak exists',!!$('#streak')&&/\\d/.test($('#streak').textContent));\nconst tgt=($('#target').textContent.match(/rgb\\([^)]*\\)/i)||[''])[0].replace(/\\s/g,'');\nlet correctBtn=null;for(const b of sw.querySelectorAll('button')){const c=getComputedStyle(b).backgroundColor.replace(/\\s/g,'');if(c===tgt)correctBtn=b;}\nprobe('one swatch matches',!!correctBtn);\nif(correctBtn){clickEl(correctBtn);await sleep(150);probe('correct advances',parseInt($('#streak').textContent.match(/\\d+/)?.[0]||'0')>=1);}else probe('correct advances',false);",
    exemplar: H(`
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Color Guesser</title>
<style>
  body { font-family: system-ui, sans-serif; background: #232136; color: #e0def4; text-align: center; padding-top: 40px; }
  #target { font-family: ui-monospace, monospace; font-size: 1.8rem; margin: 14px 0; }
  #swatches { display: grid; grid-template-columns: repeat(3, 110px); gap: 14px; justify-content: center; margin: 26px auto; }
  #swatches button { height: 80px; border: none; border-radius: 10px; cursor: pointer; transition: transform .1s; }
  #swatches button:hover { transform: scale(1.06); }
  #feedback { min-height: 1.5em; font-size: 1.1rem; }
  #streak { color: #f6c177; font-size: 1.2rem; }
</style>
</head>
<body>
<h1>Guess the Color</h1>
<div id="target"></div>
<div id="swatches"></div>
<div id="feedback"></div>
<div id="streak">Streak: 0</div>
<script>
const targetEl = document.getElementById('target');
const swatchesEl = document.getElementById('swatches');
const feedbackEl = document.getElementById('feedback');
const streakEl = document.getElementById('streak');
let streak = 0;

const rnd = () => Math.floor(Math.random() * 256);
const rgb = () => 'rgb(' + rnd() + ', ' + rnd() + ', ' + rnd() + ')';

function newRound() {
  const colors = Array.from({ length: 6 }, rgb);
  const answer = colors[Math.floor(Math.random() * 6)];
  targetEl.textContent = answer;
  swatchesEl.innerHTML = '';
  for (const c of colors) {
    const b = document.createElement('button');
    b.style.backgroundColor = c;
    b.addEventListener('click', () => {
      if (c === answer) {
        streak++; feedbackEl.textContent = '✔ Correct!';
        streakEl.textContent = 'Streak: ' + streak;
        newRound();
      } else {
        streak = 0; b.remove();
        feedbackEl.textContent = '✘ Not that one…';
        streakEl.textContent = 'Streak: 0';
      }
    });
    swatchesEl.appendChild(b);
  }
}
newRound();
</script>
</body>
</html>`),
  },
  {
    id: "analog-clock",
    prompt: "Code a live analog clock as a single self-contained HTML file. A canvas with id \"clock\" drawing a round face with 12 hour ticks, hour/minute/second hands updating smoothly in real time, and the digital time as HH:MM:SS in an element with id \"digital\". Reply with one complete HTML file in a ```html code block.",
    probes: "probe('canvas clock',!!$('#clock'));probe('digital format',!!$('#digital')&&/\\d{2}:\\d{2}:\\d{2}/.test($('#digital').textContent));\nconst f1=canvasData('#clock');await sleep(1200);const f2=canvasData('#clock');probe('hands move',!!f1&&!!f2&&f1!==f2);\nconst d1=$('#digital').textContent;await sleep(1100);probe('digital ticks',$('#digital').textContent!==d1);",
    exemplar: H(`
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Analog Clock</title>
<style>
  body { font-family: system-ui, sans-serif; background: #101418; color: #dbe2ea; display: flex; flex-direction: column; align-items: center; padding-top: 40px; }
  #digital { font-family: ui-monospace, monospace; font-size: 1.6rem; margin-top: 18px; }
</style>
</head>
<body>
<canvas id="clock" width="320" height="320"></canvas>
<div id="digital"></div>
<script>
const cv = document.getElementById('clock');
const cx = cv.getContext('2d');
const digital = document.getElementById('digital');
const R = 150, C = 160;

function hand(angle, len, width, color) {
  cx.beginPath();
  cx.lineWidth = width; cx.lineCap = 'round'; cx.strokeStyle = color;
  cx.moveTo(C, C);
  cx.lineTo(C + len * Math.sin(angle), C - len * Math.cos(angle));
  cx.stroke();
}

function draw() {
  const now = new Date();
  cx.clearRect(0, 0, 320, 320);
  // face
  cx.beginPath(); cx.arc(C, C, R, 0, Math.PI * 2);
  cx.fillStyle = '#1b232c'; cx.fill();
  cx.lineWidth = 4; cx.strokeStyle = '#39434e'; cx.stroke();
  // ticks
  for (let i = 0; i < 12; i++) {
    const a = i * Math.PI / 6;
    cx.beginPath(); cx.lineWidth = i % 3 === 0 ? 4 : 2; cx.strokeStyle = '#5c6975';
    cx.moveTo(C + (R - 18) * Math.sin(a), C - (R - 18) * Math.cos(a));
    cx.lineTo(C + (R - 6) * Math.sin(a), C - (R - 6) * Math.cos(a));
    cx.stroke();
  }
  const ms = now.getMilliseconds(), s = now.getSeconds() + ms / 1000,
        m = now.getMinutes() + s / 60, h = (now.getHours() % 12) + m / 60;
  hand(h * Math.PI / 6, R * 0.5, 6, '#dbe2ea');
  hand(m * Math.PI / 30, R * 0.72, 4, '#9fb3c8');
  hand(s * Math.PI / 30, R * 0.82, 2, '#e94560');
  cx.beginPath(); cx.arc(C, C, 5, 0, Math.PI * 2); cx.fillStyle = '#e94560'; cx.fill();
  const p = (n) => String(n).padStart(2, '0');
  digital.textContent = p(now.getHours()) + ':' + p(now.getMinutes()) + ':' + p(now.getSeconds());
  requestAnimationFrame(draw);
}
draw();
</script>
</body>
</html>`),
  },
  {
    id: "game-of-life",
    prompt: "Code Conway's Game of Life as a single self-contained HTML file. A canvas with id \"grid\" showing a 40x30 cell world, buttons with ids \"play\" (toggles run/pause), \"step\", \"random\" and \"clear\", and the generation count in an element with id \"gen\". Clicking a cell on the canvas toggles it while paused. Wrap edges (toroidal). Reply with one complete HTML file in a ```html code block.",
    probes: "probe('canvas exists',!!$('#grid'));probe('buttons exist',!!$('#play')&&!!$('#step')&&!!$('#random')&&!!$('#clear'));probe('gen counter',!!$('#gen')&&/\\d/.test($('#gen').textContent));\nclickEl($('#random'));await sleep(150);const f1=canvasData('#grid');\nclickEl($('#step'));await sleep(150);const f2=canvasData('#grid');probe('step evolves',!!f1&&!!f2&&f1!==f2);\nconst g1=parseInt($('#gen').textContent.match(/\\d+/)?.[0]||'0');clickEl($('#play'));await sleep(900);clickEl($('#play'));\nconst g2=parseInt($('#gen').textContent.match(/\\d+/)?.[0]||'0');probe('play advances gens',g2>g1);\nclickEl($('#clear'));await sleep(150);const g3=parseInt($('#gen').textContent.match(/\\d+/)?.[0]||'0');probe('clear resets gen',g3===0);",
    exemplar: H(`
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Game of Life</title>
<style>
  body { font-family: system-ui, sans-serif; background: #0b0f14; color: #cfd8e3; text-align: center; padding-top: 24px; }
  #grid { border: 1px solid #2a3542; image-rendering: pixelated; cursor: crosshair; }
  #controls { margin: 14px; }
  button { padding: 8px 18px; margin: 0 5px; background: #223041; color: #cfd8e3; border: none; border-radius: 6px; cursor: pointer; }
  #gen { color: #64d2ff; }
</style>
</head>
<body>
<canvas id="grid" width="480" height="360"></canvas>
<div id="controls">
  <button id="play">Play</button>
  <button id="step">Step</button>
  <button id="random">Random</button>
  <button id="clear">Clear</button>
  <span id="gen">Gen: 0</span>
</div>
<script>
const W = 40, Hh = 30, CELL = 12;
const cv = document.getElementById('grid');
const cx = cv.getContext('2d');
const genEl = document.getElementById('gen');
let world = new Uint8Array(W * Hh), gen = 0, running = false, timer = null;

function draw() {
  cx.fillStyle = '#0b0f14'; cx.fillRect(0, 0, cv.width, cv.height);
  cx.fillStyle = '#64d2ff';
  for (let y = 0; y < Hh; y++)
    for (let x = 0; x < W; x++)
      if (world[y * W + x]) cx.fillRect(x * CELL, y * CELL, CELL - 1, CELL - 1);
  genEl.textContent = 'Gen: ' + gen;
}

function step() {
  const next = new Uint8Array(W * Hh);
  for (let y = 0; y < Hh; y++)
    for (let x = 0; x < W; x++) {
      let n = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          n += world[((y + dy + Hh) % Hh) * W + ((x + dx + W) % W)];
        }
      const alive = world[y * W + x];
      next[y * W + x] = alive ? (n === 2 || n === 3 ? 1 : 0) : (n === 3 ? 1 : 0);
    }
  world = next; gen++; draw();
}

function setRunning(on) {
  running = on;
  document.getElementById('play').textContent = on ? 'Pause' : 'Play';
  if (on) timer = setInterval(step, 120);
  else clearInterval(timer);
}

document.getElementById('play').addEventListener('click', () => setRunning(!running));
document.getElementById('step').addEventListener('click', () => { if (!running) step(); });
document.getElementById('random').addEventListener('click', () => {
  for (let i = 0; i < world.length; i++) world[i] = Math.random() < 0.28 ? 1 : 0;
  gen = 0; draw();
});
document.getElementById('clear').addEventListener('click', () => {
  world.fill(0); gen = 0; setRunning(false); draw();
});
cv.addEventListener('click', (e) => {
  if (running) return;
  const r = cv.getBoundingClientRect();
  const x = Math.floor((e.clientX - r.left) / CELL), y = Math.floor((e.clientY - r.top) / CELL);
  if (x >= 0 && x < W && y >= 0 && y < Hh) { world[y * W + x] ^= 1; draw(); }
});
draw();
</script>
</body>
</html>`),
  },
  {
    id: "starfield",
    prompt: "Code a starfield fly-through animation as a single self-contained HTML file. A full-window black canvas with hundreds of stars streaming outward from the center (classic warp effect, stars accelerate as they approach the edge and respawn in the middle), plus a speed slider input with id \"speed\". Reply with one complete HTML file in a ```html code block.",
    probes: "probe('canvas exists',!!$('canvas'));probe('speed slider',!!$('#speed')&&$('#speed').type==='range');\nconst f1=canvasData();await sleep(400);const f2=canvasData();probe('stars animate',!!f1&&!!f2&&f1!==f2);\n$('#speed').value=$('#speed').max;$('#speed').dispatchEvent(new Event('input',{bubbles:true}));await sleep(300);const f3=canvasData();probe('still animating at max speed',!!f3&&f3!==f2);",
    exemplar: H(`
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Starfield</title>
<style>
  body { margin: 0; overflow: hidden; background: #000; }
  canvas { display: block; }
  #hud { position: fixed; bottom: 16px; left: 16px; color: #9ad; font-family: system-ui, sans-serif; font-size: 13px; }
</style>
</head>
<body>
<canvas id="sky"></canvas>
<div id="hud">speed <input id="speed" type="range" min="1" max="20" value="6"></div>
<script>
const cv = document.getElementById('sky');
const cx = cv.getContext('2d');
const speedEl = document.getElementById('speed');
let W, Hh, cxr, cyr;
const N = 400;
const stars = [];

function resize() {
  W = cv.width = window.innerWidth; Hh = cv.height = window.innerHeight;
  cxr = W / 2; cyr = Hh / 2;
}
window.addEventListener('resize', resize);
resize();

function spawn(s) { s.x = (Math.random() - 0.5) * W; s.y = (Math.random() - 0.5) * Hh; s.z = Math.random() * W; }
for (let i = 0; i < N; i++) { const s = {}; spawn(s); stars.push(s); }

function frame() {
  const v = +speedEl.value;
  cx.fillStyle = 'rgba(0,0,0,0.45)';
  cx.fillRect(0, 0, W, Hh);
  cx.fillStyle = '#fff';
  for (const s of stars) {
    s.z -= v * 4;
    if (s.z <= 1) spawn(s), s.z = W;
    const k = 128 / s.z;
    const px = s.x * k + cxr, py = s.y * k + cyr;
    if (px < 0 || px >= W || py < 0 || py >= Hh) { spawn(s); s.z = W; continue; }
    const size = Math.max(0.4, (1 - s.z / W) * 3);
    cx.globalAlpha = Math.min(1, 1.2 - s.z / W);
    cx.fillRect(px, py, size, size);
  }
  cx.globalAlpha = 1;
  requestAnimationFrame(frame);
}
frame();
</script>
</body>
</html>`),
  },
  {
    id: "fireworks",
    prompt: "Code a fireworks display as a single self-contained HTML file. A full-window night-sky canvas; clicking anywhere launches a rocket from the bottom that ascends to the click height and explodes into dozens of colorful sparks that fall with gravity and fade. Several random fireworks should also launch by themselves every couple of seconds. Reply with one complete HTML file in a ```html code block.",
    probes: "const cv=$('canvas');probe('canvas exists',!!cv);\nawait sleep(2600);const f1=canvasData();await sleep(400);const f2=canvasData();probe('auto fireworks animate',!!f1&&!!f2&&f1!==f2);\nif(cv){const r=cv.getBoundingClientRect();cv.dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:r.x+r.width/2,clientY:r.y+r.height/3}));}\nawait sleep(700);const f3=canvasData();probe('click spawns more',!!f3&&f3!==f2);",
    exemplar: H(`
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Fireworks</title>
<style>
  body { margin: 0; overflow: hidden; background: #050510; }
  canvas { display: block; cursor: pointer; }
</style>
</head>
<body>
<canvas id="sky"></canvas>
<script>
const cv = document.getElementById('sky');
const cx = cv.getContext('2d');
let W, Hh;
function resize() { W = cv.width = window.innerWidth; Hh = cv.height = window.innerHeight; }
window.addEventListener('resize', resize);
resize();

const rockets = [], sparks = [];
const hue = () => Math.floor(Math.random() * 360);

function launch(tx, ty) {
  rockets.push({ x: tx, y: Hh, ty, vy: -(6 + Math.random() * 3), h: hue() });
}
function explode(r) {
  const n = 40 + Math.floor(Math.random() * 30);
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2, v = 1 + Math.random() * 4;
    sparks.push({ x: r.x, y: r.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 1, h: r.h });
  }
}

cv.addEventListener('click', (e) => launch(e.clientX, e.clientY));
setInterval(() => launch(60 + Math.random() * (W - 120), 80 + Math.random() * Hh * 0.4), 1800);

function frame() {
  cx.fillStyle = 'rgba(5,5,16,0.25)';
  cx.fillRect(0, 0, W, Hh);
  for (let i = rockets.length - 1; i >= 0; i--) {
    const r = rockets[i];
    r.y += r.vy;
    cx.fillStyle = 'hsl(' + r.h + ',100%,75%)';
    cx.fillRect(r.x - 1.5, r.y, 3, 8);
    if (r.y <= r.ty) { explode(r); rockets.splice(i, 1); }
  }
  for (let i = sparks.length - 1; i >= 0; i--) {
    const s = sparks[i];
    s.x += s.vx; s.y += s.vy; s.vy += 0.05; s.life -= 0.012;
    if (s.life <= 0) { sparks.splice(i, 1); continue; }
    cx.globalAlpha = s.life;
    cx.fillStyle = 'hsl(' + s.h + ',100%,' + (50 + s.life * 30) + '%)';
    cx.fillRect(s.x - 1.5, s.y - 1.5, 3, 3);
  }
  cx.globalAlpha = 1;
  requestAnimationFrame(frame);
}
frame();
</script>
</body>
</html>`),
  },
  {
    id: "expense-tracker",
    prompt: "Code an expense tracker as a single self-contained HTML file. A description input with id \"desc\", an amount number input with id \"amount\", an add button with id \"add\", entries listed inside an element with id \"entries\" each with its own delete button, and the running total formatted to two decimals in an element with id \"total\". Persist entries in localStorage. Adding with an empty description or non-positive amount must be rejected. Reply with one complete HTML file in a ```html code block.",
    probes: "probe('inputs exist',!!$('#desc')&&!!$('#amount')&&!!$('#add')&&!!$('#entries')&&!!$('#total'));\nconst set=(el,v)=>{el.value=v;el.dispatchEvent(new Event('input',{bubbles:true}));};\nconst n0=$('#entries').children.length;\nset($('#desc'),'');set($('#amount'),'12');clickEl($('#add'));await sleep(120);probe('rejects empty desc',$('#entries').children.length===n0);\nset($('#desc'),'coffee');set($('#amount'),'3.50');clickEl($('#add'));await sleep(150);\nprobe('adds entry',$('#entries').children.length===n0+1&&/coffee/i.test($('#entries').textContent));\nprobe('total 3.50',/3\\.50/.test($('#total').textContent));\nprobe('persists',JSON.stringify(Object.values(localStorage)).includes('coffee'));\nconst del=$('#entries').querySelector('button');if(del){clickEl(del);await sleep(120);probe('delete works',$('#entries').children.length===n0);}else probe('delete works',false);",
    exemplar: H(`
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Expense Tracker</title>
<style>
  body { font-family: system-ui, sans-serif; background: #f4f1ea; color: #333; display: flex; justify-content: center; padding-top: 50px; }
  #app { width: min(460px, 92vw); background: #fff; border-radius: 12px; box-shadow: 0 4px 18px rgba(0,0,0,.12); padding: 24px; }
  h1 { margin-top: 0; font-size: 1.3rem; }
  form { display: flex; gap: 8px; }
  #desc { flex: 1; } #amount { width: 90px; }
  input { padding: 8px; border: 1px solid #ccc; border-radius: 6px; font-size: .95rem; }
  #add { padding: 8px 16px; background: #2e7d32; color: #fff; border: none; border-radius: 6px; cursor: pointer; }
  #entries { list-style: none; padding: 0; margin: 18px 0 0; }
  #entries li { display: flex; justify-content: space-between; align-items: center; padding: 8px 4px; border-bottom: 1px solid #eee; }
  #entries button { background: none; border: none; color: #c62828; cursor: pointer; font-size: 1rem; }
  #total-row { margin-top: 14px; font-weight: 600; text-align: right; }
</style>
</head>
<body>
<div id="app">
  <h1>Expenses</h1>
  <form id="form">
    <input id="desc" placeholder="Description">
    <input id="amount" type="number" step="0.01" min="0" placeholder="0.00">
    <button id="add" type="submit">Add</button>
  </form>
  <ul id="entries"></ul>
  <div id="total-row">Total: <span id="total">0.00</span></div>
</div>
<script>
const descEl = document.getElementById('desc');
const amountEl = document.getElementById('amount');
const entriesEl = document.getElementById('entries');
const totalEl = document.getElementById('total');
let items = JSON.parse(localStorage.getItem('expenses') || '[]');

function save() { localStorage.setItem('expenses', JSON.stringify(items)); }

function render() {
  entriesEl.innerHTML = '';
  let total = 0;
  items.forEach((it, i) => {
    total += it.amount;
    const li = document.createElement('li');
    const label = document.createElement('span');
    label.textContent = it.desc + ' — ' + it.amount.toFixed(2);
    const del = document.createElement('button');
    del.textContent = '✕';
    del.setAttribute('aria-label', 'delete');
    del.addEventListener('click', () => { items.splice(i, 1); save(); render(); });
    li.append(label, del);
    entriesEl.appendChild(li);
  });
  totalEl.textContent = total.toFixed(2);
}

document.getElementById('form').addEventListener('submit', (e) => {
  e.preventDefault();
  const desc = descEl.value.trim();
  const amount = parseFloat(amountEl.value);
  if (!desc || !(amount > 0)) return;      // reject empty/invalid
  items.push({ desc, amount });
  descEl.value = ''; amountEl.value = '';
  save(); render();
});
render();
</script>
</body>
</html>`),
  },
  {
    id: "notes-app",
    prompt: "Code a sticky-notes board as a single self-contained HTML file. A new-note button with id \"new-note\" adds an editable note card to a board container with id \"board\"; each note is a textarea with a delete button, gets a random pastel background, and all note texts persist in localStorage (restored on reload, saved as you type). Show the note count in an element with id \"count\". Reply with one complete HTML file in a ```html code block.",
    probes: "probe('elements exist',!!$('#new-note')&&!!$('#board')&&!!$('#count'));\nconst n0=$('#board').children.length;clickEl($('#new-note'));await sleep(150);\nprobe('adds note',$('#board').children.length===n0+1);\nprobe('count updates',parseInt($('#count').textContent.match(/\\d+/)?.[0]||'-1')===n0+1);\nconst ta=$('#board').querySelector('textarea');\nif(ta){ta.value='remember milk';ta.dispatchEvent(new Event('input',{bubbles:true}));await sleep(250);probe('persists text',JSON.stringify(Object.values(localStorage)).includes('remember milk'));}else probe('persists text',false);\nconst del=$('#board').querySelector('button');if(del){clickEl(del);await sleep(150);probe('delete removes',$('#board').children.length===n0);}else probe('delete removes',false);",
    exemplar: H(`
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Sticky Notes</title>
<style>
  body { font-family: system-ui, sans-serif; background: #2f3640; color: #eee; padding: 30px; }
  header { display: flex; align-items: center; gap: 16px; margin-bottom: 22px; }
  #new-note { padding: 10px 20px; font-size: 1rem; background: #fbc531; border: none; border-radius: 8px; cursor: pointer; }
  #board { display: flex; flex-wrap: wrap; gap: 16px; }
  .note { width: 200px; border-radius: 10px; padding: 10px; box-shadow: 0 4px 10px rgba(0,0,0,.3); position: relative; }
  .note textarea { width: 100%; height: 130px; background: transparent; border: none; resize: none; font: inherit; color: #222; outline: none; }
  .note button { position: absolute; top: 6px; right: 8px; background: none; border: none; cursor: pointer; font-size: .9rem; color: #444; }
</style>
</head>
<body>
<header>
  <button id="new-note">+ New note</button>
  <span id="count">0 notes</span>
</header>
<div id="board"></div>
<script>
const PASTELS = ['#fff9b1', '#ffd6a5', '#caffbf', '#9bf6ff', '#bdb2ff', '#ffc6ff'];
const board = document.getElementById('board');
const countEl = document.getElementById('count');
let notes = JSON.parse(localStorage.getItem('notes') || '[]');

function save() { localStorage.setItem('notes', JSON.stringify(notes)); }
function updateCount() { countEl.textContent = notes.length + ' note' + (notes.length === 1 ? '' : 's'); }

function render() {
  board.innerHTML = '';
  notes.forEach((n, i) => {
    const card = document.createElement('div');
    card.className = 'note';
    card.style.background = n.color;
    const ta = document.createElement('textarea');
    ta.value = n.text;
    ta.addEventListener('input', () => { n.text = ta.value; save(); });
    const del = document.createElement('button');
    del.textContent = '✕';
    del.addEventListener('click', () => { notes.splice(i, 1); save(); render(); });
    card.append(del, ta);
    board.appendChild(card);
  });
  updateCount();
}

document.getElementById('new-note').addEventListener('click', () => {
  notes.push({ text: '', color: PASTELS[Math.floor(Math.random() * PASTELS.length)] });
  save(); render();
  board.lastChild.querySelector('textarea').focus();
});
render();
</script>
</body>
</html>`),
  },
  {
    id: "unit-converter",
    prompt: "Code a length unit converter as a single self-contained HTML file. A number input with id \"value\", two selects with ids \"from\" and \"to\" offering at least meters, kilometers, miles, feet and inches, and the live-updating result to four significant digits in an element with id \"result\". Add a swap button with id \"swap\" that exchanges the two units. Conversions must go through a common base so every pair works. Reply with one complete HTML file in a ```html code block.",
    probes: "probe('controls exist',!!$('#value')&&!!$('#from')&&!!$('#to')&&!!$('#result')&&!!$('#swap'));\nprobe('5 units',($('#from')?.options.length||0)>=5);\nconst set=(el,v)=>{el.value=v;el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));};\nset($('#value'),'1');set($('#from'),Array.from($('#from').options).find(o=>/^km|kilo/i.test(o.value+o.text)).value);set($('#to'),Array.from($('#to').options).find(o=>/^m$|meter/i.test(o.value+o.text)&&!/kilo|mile/i.test(o.value+o.text)).value);\nawait sleep(150);probe('1 km = 1000 m',/1000/.test($('#result').textContent));\nclickEl($('#swap'));await sleep(150);probe('swap inverts',/0\\.001/.test($('#result').textContent));",
    exemplar: H(`
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Length Converter</title>
<style>
  body { font-family: system-ui, sans-serif; background: #eef2f7; color: #223; display: flex; justify-content: center; padding-top: 70px; }
  #app { background: #fff; padding: 28px; border-radius: 14px; box-shadow: 0 6px 24px rgba(30,50,90,.15); width: min(420px, 92vw); }
  .row { display: flex; gap: 10px; align-items: center; margin-bottom: 14px; }
  input, select { padding: 9px; font-size: 1rem; border: 1px solid #c7d0dd; border-radius: 8px; }
  #value { flex: 1; min-width: 0; }
  #swap { padding: 8px 12px; background: #3b6ef6; color: #fff; border: none; border-radius: 8px; cursor: pointer; }
  #result { font-size: 1.3rem; font-weight: 600; color: #3b6ef6; min-height: 1.5em; }
</style>
</head>
<body>
<div id="app">
  <h1 style="margin-top:0;font-size:1.2rem">Length Converter</h1>
  <div class="row"><input id="value" type="number" value="1" step="any"></div>
  <div class="row">
    <select id="from"></select>
    <button id="swap" title="swap units">⇄</button>
    <select id="to"></select>
  </div>
  <div id="result"></div>
</div>
<script>
const UNITS = { m: 1, km: 1000, mi: 1609.344, ft: 0.3048, in: 0.0254 };
const NAMES = { m: 'meters', km: 'kilometers', mi: 'miles', ft: 'feet', in: 'inches' };
const valueEl = document.getElementById('value');
const fromEl = document.getElementById('from');
const toEl = document.getElementById('to');
const resultEl = document.getElementById('result');

for (const sel of [fromEl, toEl])
  for (const u of Object.keys(UNITS)) {
    const o = document.createElement('option');
    o.value = u; o.textContent = NAMES[u];
    sel.appendChild(o);
  }
fromEl.value = 'km'; toEl.value = 'm';

function convert() {
  const v = parseFloat(valueEl.value);
  if (!isFinite(v)) { resultEl.textContent = '—'; return; }
  const meters = v * UNITS[fromEl.value];          // common base: meters
  const out = meters / UNITS[toEl.value];
  resultEl.textContent = v + ' ' + NAMES[fromEl.value] + ' = ' +
    Number(out.toPrecision(4)) + ' ' + NAMES[toEl.value];
}

document.getElementById('swap').addEventListener('click', () => {
  const f = fromEl.value; fromEl.value = toEl.value; toEl.value = f;
  convert();
});
for (const el of [valueEl, fromEl, toEl]) {
  el.addEventListener('input', convert);
  el.addEventListener('change', convert);
}
convert();
</script>
</body>
</html>`),
  },
  {
    id: "simon-says",
    prompt: "Code a Simon-says memory game as a single self-contained HTML file. Four large colored pads (green, red, yellow, blue) inside a container with id \"pads\", a start button with id \"start\", and the current level in an element with id \"level\". Each round the game flashes a growing random sequence; the player must click it back in order. A wrong click shows \"Game over\" in an element with id \"message\" and re-enables start. Pads must flash visibly when played back. Reply with one complete HTML file in a ```html code block.",
    probes: "probe('4 pads',!!$('#pads')&&$('#pads').children.length===4);probe('start exists',!!$('#start'));probe('level exists',!!$('#level'));\nclickEl($('#start'));await sleep(300);\nconst pad=$('#pads').children[0];const s0=pad.className+pad.style.cssText;let flashed=false;\nfor(let i=0;i<12;i++){await sleep(120);const s=Array.from($('#pads').children).map(p=>p.className+p.style.cssText+getComputedStyle(p).filter+getComputedStyle(p).opacity).join('|');if(s.includes('active')||s.includes('lit')||s.includes('flash')||/opacity: 0\\.|brightness/.test(s)){flashed=true;break;}}\nprobe('sequence flashes',flashed);\nawait sleep(1500);\nfor(let t=0;t<3;t++){clickEl($('#pads').children[t%4]);await sleep(150);}\nawait sleep(600);probe('feedback appears',/game over|level/i.test(($('#message')?.textContent||'')+($('#level')?.textContent||'')));",
    exemplar: H(`
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Simon Says</title>
<style>
  body { font-family: system-ui, sans-serif; background: #191927; color: #eee; text-align: center; padding-top: 34px; }
  #pads { display: grid; grid-template-columns: repeat(2, 130px); gap: 12px; justify-content: center; margin: 26px auto; }
  .pad { height: 130px; border-radius: 14px; cursor: pointer; opacity: .45; transition: opacity .12s, transform .12s; border: none; }
  .pad.lit { opacity: 1; transform: scale(1.05); }
  #g { background: #2ecc71; } #r { background: #e74c3c; } #y { background: #f1c40f; } #b { background: #3498db; }
  #start { padding: 10px 26px; font-size: 1rem; background: #6c5ce7; color: #fff; border: none; border-radius: 8px; cursor: pointer; }
  #start:disabled { opacity: .4; }
  #level { font-size: 1.2rem; margin: 12px; }
  #message { min-height: 1.5em; color: #ff7675; font-size: 1.1rem; }
</style>
</head>
<body>
<h1>Simon Says</h1>
<div id="level">Level 0</div>
<div id="pads">
  <button class="pad" id="g"></button>
  <button class="pad" id="r"></button>
  <button class="pad" id="y"></button>
  <button class="pad" id="b"></button>
</div>
<button id="start">Start</button>
<div id="message"></div>
<script>
const PADS = ['g', 'r', 'y', 'b'].map(id => document.getElementById(id));
const levelEl = document.getElementById('level');
const msgEl = document.getElementById('message');
const startBtn = document.getElementById('start');
let seq = [], pos = 0, accepting = false, playing = false;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function flash(pad, ms = 350) {
  pad.classList.add('lit');
  await sleep(ms);
  pad.classList.remove('lit');
  await sleep(120);
}

async function playSeq() {
  accepting = false;
  await sleep(500);
  for (const i of seq) await flash(PADS[i]);
  accepting = true; pos = 0;
}

async function nextRound() {
  seq.push(Math.floor(Math.random() * 4));
  levelEl.textContent = 'Level ' + seq.length;
  await playSeq();
}

PADS.forEach((pad, i) => pad.addEventListener('click', async () => {
  if (!accepting || !playing) return;
  await flash(pad, 160);
  if (i !== seq[pos]) {
    msgEl.textContent = 'Game over — you reached level ' + seq.length;
    playing = false; accepting = false;
    startBtn.disabled = false;
    return;
  }
  pos++;
  if (pos === seq.length) nextRound();
}));

startBtn.addEventListener('click', () => {
  seq = []; playing = true; msgEl.textContent = '';
  startBtn.disabled = true;
  nextRound();
});
</script>
</body>
</html>`),
  },
  {
    id: "flappy-bird-style",
    prompt: "Code a one-button flying game (flappy-bird style, original art) as a single self-contained HTML file. A canvas where a small square 'bird' falls with gravity and jumps on click or Space; vertical pipe pairs with a gap scroll from the right; passing a pipe increments the score in an element with id \"score\"; hitting a pipe or the ground shows game-over and a click restarts. Start paused with a \"click to start\" hint drawn on the canvas. Reply with one complete HTML file in a ```html code block.",
    probes: "const cv=$('canvas');probe('canvas exists',!!cv);probe('score exists',!!$('#score')&&/\\d/.test($('#score').textContent));\nclickEl(cv);await sleep(300);const f1=canvasData();await sleep(400);const f2=canvasData();probe('game animates after start',!!f1&&!!f2&&f1!==f2);\npress(' ');await sleep(200);const f3=canvasData();probe('input handled',!!f3&&f3!==f2);",
    exemplar: H(`
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Flappy Square</title>
<style>
  body { margin: 0; background: #0f1c2e; display: flex; flex-direction: column; align-items: center; font-family: system-ui, sans-serif; color: #cfe3ff; padding-top: 20px; }
  #score { font-size: 1.6rem; margin-bottom: 8px; }
  canvas { border-radius: 10px; cursor: pointer; }
</style>
</head>
<body>
<div id="score">0</div>
<canvas id="game" width="420" height="560"></canvas>
<script>
const cv = document.getElementById('game');
const cx = cv.getContext('2d');
const scoreEl = document.getElementById('score');
const W = cv.width, Hh = cv.height;
let bird, pipes, score, state; // state: 'ready' | 'playing' | 'dead'

function reset() {
  bird = { x: 90, y: Hh / 2, vy: 0, s: 22 };
  pipes = []; score = 0; state = 'ready';
  scoreEl.textContent = '0';
}

function flap() {
  if (state === 'ready') { state = 'playing'; spawn(); }
  if (state === 'playing') bird.vy = -6.2;
  else if (state === 'dead') reset();
}
cv.addEventListener('click', flap);
document.addEventListener('keydown', (e) => { if (e.key === ' ' || e.code === 'Space') { e.preventDefault(); flap(); } });

function spawn() {
  const gap = 150, cy = 90 + Math.random() * (Hh - 260);
  pipes.push({ x: W + 30, cy, gap, w: 58, passed: false });
}

function step() {
  cx.fillStyle = '#0f1c2e';
  cx.fillRect(0, 0, W, Hh);

  if (state === 'playing') {
    bird.vy += 0.32; bird.y += bird.vy;
    if (pipes.length === 0 || pipes[pipes.length - 1].x < W - 210) spawn();
    for (const p of pipes) p.x -= 2.6;
    while (pipes.length && pipes[0].x + pipes[0].w < 0) pipes.shift();
    for (const p of pipes) {
      if (!p.passed && p.x + p.w < bird.x) { p.passed = true; score++; scoreEl.textContent = score; }
      const inX = bird.x + bird.s / 2 > p.x && bird.x - bird.s / 2 < p.x + p.w;
      const inGap = bird.y - bird.s / 2 > p.cy - p.gap / 2 && bird.y + bird.s / 2 < p.cy + p.gap / 2;
      if (inX && !inGap) state = 'dead';
    }
    if (bird.y + bird.s / 2 >= Hh || bird.y < 0) state = 'dead';
  }

  cx.fillStyle = '#2e7d32';
  for (const p of pipes) {
    cx.fillRect(p.x, 0, p.w, p.cy - p.gap / 2);
    cx.fillRect(p.x, p.cy + p.gap / 2, p.w, Hh - p.cy - p.gap / 2);
  }
  cx.fillStyle = '#ffd54f';
  cx.fillRect(bird.x - bird.s / 2, bird.y - bird.s / 2, bird.s, bird.s);

  cx.fillStyle = '#cfe3ff';
  cx.font = '20px system-ui';
  cx.textAlign = 'center';
  if (state === 'ready') cx.fillText('Click or press Space to start', W / 2, Hh / 2 - 60);
  if (state === 'dead') { cx.fillText('Game over — ' + score + ' points', W / 2, Hh / 2 - 60); cx.fillText('Click to restart', W / 2, Hh / 2 - 32); }

  requestAnimationFrame(step);
}
reset();
step();
</script>
</body>
</html>`),
  },
  {
    id: "2048-lite",
    prompt: "Code a 2048-style sliding tile game as a single self-contained HTML file. A 4x4 grid inside a container with id \"board\" (16 cells always rendered), arrow keys slide and merge equal tiles (standard 2048 rules: each tile merges at most once per move), a new tile (2 or 4) appears after every effective move, the score accumulates merged values in an element with id \"score\", and a new-game button with id \"new-game\". Color tiles by value. Reply with one complete HTML file in a ```html code block.",
    probes: "const b=$('#board');probe('16 cells',!!b&&b.children.length===16);probe('score exists',!!$('#score')&&/\\d/.test($('#score').textContent));probe('new-game exists',!!$('#new-game'));\nconst txt=()=>b.textContent.replace(/\\s/g,'');const t0=txt();\nlet moved=false;for(const k of ['ArrowLeft','ArrowUp','ArrowRight','ArrowDown']){press(k);await sleep(180);if(txt()!==t0){moved=true;break;}}\nprobe('arrows move tiles',moved);\nclickEl($('#new-game'));await sleep(150);const tiles=txt().match(/\\d+/g)||[];probe('new game resets',tiles.length>=1&&tiles.length<=3&&parseInt($('#score').textContent.match(/\\d+/)?.[0]||'9')===0);",
    exemplar: H(`
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>2048 Lite</title>
<style>
  body { font-family: system-ui, sans-serif; background: #faf8ef; color: #776e65; display: flex; flex-direction: column; align-items: center; padding-top: 30px; }
  header { display: flex; gap: 18px; align-items: center; margin-bottom: 16px; }
  #score-box { background: #bbada0; color: #fff; padding: 8px 18px; border-radius: 8px; font-weight: 600; }
  #new-game { padding: 10px 18px; background: #8f7a66; color: #fff; border: none; border-radius: 8px; font-size: 1rem; cursor: pointer; }
  #board { display: grid; grid-template-columns: repeat(4, 86px); gap: 10px; background: #bbada0; padding: 10px; border-radius: 10px; }
  .cell { height: 86px; border-radius: 6px; background: #cdc1b4; display: flex; align-items: center; justify-content: center; font-size: 1.9rem; font-weight: 700; }
</style>
</head>
<body>
<header>
  <div id="score-box">Score: <span id="score">0</span></div>
  <button id="new-game">New game</button>
</header>
<div id="board"></div>
<script>
const COLORS = { 2:'#eee4da',4:'#ede0c8',8:'#f2b179',16:'#f59563',32:'#f67c5f',64:'#f65e3b',128:'#edcf72',256:'#edcc61',512:'#edc850',1024:'#edc53f',2048:'#edc22e' };
const board = document.getElementById('board');
const scoreEl = document.getElementById('score');
let grid, score;
const cells = [];
for (let i = 0; i < 16; i++) { const d = document.createElement('div'); d.className = 'cell'; board.appendChild(d); cells.push(d); }

function addTile() {
  const empty = [];
  grid.forEach((v, i) => { if (!v) empty.push(i); });
  if (empty.length) grid[empty[Math.floor(Math.random() * empty.length)]] = Math.random() < 0.9 ? 2 : 4;
}

function render() {
  grid.forEach((v, i) => {
    cells[i].textContent = v || '';
    cells[i].style.background = v ? (COLORS[v] || '#3c3a32') : '#cdc1b4';
    cells[i].style.color = v > 4 ? '#f9f6f2' : '#776e65';
  });
  scoreEl.textContent = score;
}

// slide+merge one row toward index 0; returns [newRow, gained, changed]
function slide(row) {
  const vals = row.filter(Boolean);
  let gained = 0;
  for (let i = 0; i < vals.length - 1; i++)
    if (vals[i] === vals[i + 1]) { vals[i] *= 2; gained += vals[i]; vals.splice(i + 1, 1); }
  while (vals.length < 4) vals.push(0);
  return [vals, gained, vals.some((v, i) => v !== row[i])];
}

function move(dir) {  // 0:left 1:up 2:right 3:down
  let changed = false;
  for (let r = 0; r < 4; r++) {
    const idx = [];
    for (let c = 0; c < 4; c++) {
      if (dir === 0) idx.push(r * 4 + c);
      if (dir === 2) idx.push(r * 4 + 3 - c);
      if (dir === 1) idx.push(c * 4 + r);
      if (dir === 3) idx.push((3 - c) * 4 + r);
    }
    const [next, gained, rowChanged] = slide(idx.map((i) => grid[i]));
    if (rowChanged) { changed = true; idx.forEach((gi, i) => grid[gi] = next[i]); score += gained ? 0 : 0; }
    score += gained;
  }
  if (changed) { addTile(); render(); }
}

document.addEventListener('keydown', (e) => {
  const dir = { ArrowLeft: 0, ArrowUp: 1, ArrowRight: 2, ArrowDown: 3 }[e.key];
  if (dir !== undefined) { e.preventDefault(); move(dir); }
});

function newGame() {
  grid = Array(16).fill(0); score = 0;
  addTile(); addTile(); render();
}
document.getElementById('new-game').addEventListener('click', newGame);
newGame();
</script>
</body>
</html>`),
  },
  {
    id: "typing-test",
    prompt: "Code a typing speed test as a single self-contained HTML file. Show a sample sentence in an element with id \"sample\" with per-character highlighting (correct letters green, mistakes red) as the user types into a textarea with id \"input\". Timing starts at the first keystroke; when the sentence is complete show words-per-minute in an element with id \"wpm\" and accuracy percentage in an element with id \"accuracy\", plus a next-sentence button with id \"next\". Reply with one complete HTML file in a ```html code block.",
    probes: "probe('elements exist',!!$('#sample')&&!!$('#input')&&!!$('#next'));\nconst target=$('#sample').textContent;probe('sample present',target.trim().length>10);\nconst inp=$('#input');inp.focus();\nconst type=(s)=>{inp.value=s;inp.dispatchEvent(new Event('input',{bubbles:true}));};\ntype(target.slice(0,5));await sleep(150);\nprobe('highlighting appears',$('#sample').querySelectorAll('span').length>3);\ntype(target);await sleep(300);\nprobe('wpm shown',/\\d/.test($('#wpm')?.textContent||''));\nprobe('accuracy shown',/\\d+\\s*%/.test($('#accuracy')?.textContent||''));\nconst s0=$('#sample').textContent;clickEl($('#next'));await sleep(150);probe('next loads sentence',$('#sample').textContent!==s0||$('#input').value==='');",
    exemplar: H(`
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Typing Test</title>
<style>
  body { font-family: system-ui, sans-serif; background: #1c1e26; color: #d5d8e2; display: flex; justify-content: center; padding-top: 60px; }
  #app { width: min(640px, 92vw); }
  #sample { font-size: 1.3rem; line-height: 1.8; background: #262933; padding: 18px; border-radius: 10px; margin-bottom: 14px; font-family: ui-monospace, monospace; }
  #sample span.ok { color: #7dd87d; }
  #sample span.bad { color: #ff6b6b; text-decoration: underline; }
  #input { width: 100%; box-sizing: border-box; font: 1.1rem ui-monospace, monospace; padding: 12px; border-radius: 10px; border: 1px solid #3a3f4e; background: #14161d; color: #d5d8e2; resize: none; }
  #stats { display: flex; gap: 26px; margin-top: 14px; font-size: 1.15rem; align-items: center; }
  #wpm, #accuracy { color: #78b4ff; font-weight: 600; }
  #next { margin-left: auto; padding: 8px 20px; background: #78b4ff; color: #14161d; border: none; border-radius: 8px; cursor: pointer; font-size: .95rem; }
</style>
</head>
<body>
<div id="app">
  <div id="sample"></div>
  <textarea id="input" rows="3" placeholder="Start typing here…"></textarea>
  <div id="stats">
    <span>WPM: <span id="wpm">–</span></span>
    <span>Accuracy: <span id="accuracy">–</span></span>
    <button id="next">Next sentence</button>
  </div>
</div>
<script>
const SENTENCES = [
  'The quick brown fox jumps over the lazy dog near the riverbank.',
  'Typing smoothly is a matter of rhythm rather than raw speed.',
  'A small daily practice beats a heroic effort once a month.',
  'Careful hands and a calm mind make surprisingly few mistakes.',
];
const sampleEl = document.getElementById('sample');
const inputEl = document.getElementById('input');
const wpmEl = document.getElementById('wpm');
const accEl = document.getElementById('accuracy');
let target = '', startAt = 0, mistakes = 0, done = false, lastLen = 0, si = 0;

function load(i) {
  target = SENTENCES[i % SENTENCES.length];
  inputEl.value = ''; startAt = 0; mistakes = 0; done = false; lastLen = 0;
  wpmEl.textContent = '–'; accEl.textContent = '–';
  render('');
  inputEl.focus();
}

function render(typed) {
  sampleEl.innerHTML = '';
  [...target].forEach((ch, i) => {
    const s = document.createElement('span');
    s.textContent = ch;
    if (i < typed.length) s.className = typed[i] === ch ? 'ok' : 'bad';
    sampleEl.appendChild(s);
  });
}

inputEl.addEventListener('input', () => {
  if (done) return;
  const typed = inputEl.value;
  if (!startAt && typed.length) startAt = performance.now();
  // count fresh mistakes only on newly added characters
  if (typed.length > lastLen && typed[typed.length - 1] !== target[typed.length - 1]) mistakes++;
  lastLen = typed.length;
  render(typed);
  if (typed === target) {
    done = true;
    const minutes = (performance.now() - startAt) / 60000;
    const words = target.split(' ').length;
    wpmEl.textContent = Math.round(words / minutes);
    const acc = Math.max(0, Math.round(100 * (target.length - mistakes) / target.length));
    accEl.textContent = acc + ' %';
  }
});

document.getElementById('next').addEventListener('click', () => load(++si));
load(0);
</script>
</body>
</html>`),
  },
  {
    id: "pomodoro",
    prompt: "Code a pomodoro timer as a single self-contained HTML file. A 25-minute work phase and 5-minute break phase alternate automatically; show remaining MM:SS in an element with id \"time\", the current phase name in an element with id \"phase\" (with clearly different styling per phase), completed pomodoro count in an element with id \"count\", and buttons with ids \"start-pause\" (toggles, label changes) and \"reset\". A visual progress bar with id \"bar\" should fill as the phase advances. Reply with one complete HTML file in a ```html code block.",
    probes: "probe('elements exist',!!$('#time')&&!!$('#phase')&&!!$('#count')&&!!$('#start-pause')&&!!$('#reset')&&!!$('#bar'));\nprobe('starts 25:00',/25:00/.test($('#time').textContent));probe('phase named',/work|focus/i.test($('#phase').textContent));\nclickEl($('#start-pause'));await sleep(2300);probe('counts down',!/25:00/.test($('#time').textContent));\nconst label=$('#start-pause').textContent;probe('button toggles label',/pause|stop/i.test(label));\nclickEl($('#start-pause'));const t0=$('#time').textContent;await sleep(1400);probe('pause freezes',$('#time').textContent===t0);\nclickEl($('#reset'));await sleep(150);probe('reset restores',/25:00/.test($('#time').textContent));",
    exemplar: H(`
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Pomodoro</title>
<style>
  body { font-family: system-ui, sans-serif; background: #191724; color: #e0def4; display: flex; flex-direction: column; align-items: center; padding-top: 60px; transition: background .4s; }
  body.break { background: #143028; }
  #phase { font-size: 1.1rem; letter-spacing: 3px; text-transform: uppercase; color: #eb6f92; }
  body.break #phase { color: #3ddc97; }
  #time { font-size: 5rem; font-family: ui-monospace, monospace; margin: 8px 0 18px; }
  #bar-wrap { width: 320px; height: 10px; background: #2a273f; border-radius: 6px; overflow: hidden; margin-bottom: 22px; }
  #bar { height: 100%; width: 0%; background: #eb6f92; transition: width .5s linear; }
  body.break #bar { background: #3ddc97; }
  button { font-size: 1rem; padding: 10px 26px; margin: 0 8px; border: none; border-radius: 8px; cursor: pointer; background: #524f67; color: #e0def4; }
  #start-pause { background: #eb6f92; color: #191724; font-weight: 600; }
  #count { margin-top: 20px; color: #908caa; }
</style>
</head>
<body>
<div id="phase">Work</div>
<div id="time">25:00</div>
<div id="bar-wrap"><div id="bar"></div></div>
<div>
  <button id="start-pause">Start</button>
  <button id="reset">Reset</button>
</div>
<div id="count">Pomodoros completed: 0</div>
<script>
const WORK = 25 * 60, BREAK = 5 * 60;
const timeEl = document.getElementById('time');
const phaseEl = document.getElementById('phase');
const barEl = document.getElementById('bar');
const countEl = document.getElementById('count');
const btn = document.getElementById('start-pause');
let phase = 'work', left = WORK, running = false, timer = null, done = 0;

const fmt = (s) => String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');

function render() {
  timeEl.textContent = fmt(left);
  phaseEl.textContent = phase === 'work' ? 'Work' : 'Break';
  document.body.classList.toggle('break', phase === 'break');
  const total = phase === 'work' ? WORK : BREAK;
  barEl.style.width = (100 * (total - left) / total) + '%';
  countEl.textContent = 'Pomodoros completed: ' + done;
}

function tick() {
  left--;
  if (left <= 0) {
    if (phase === 'work') { done++; phase = 'break'; left = BREAK; }
    else { phase = 'work'; left = WORK; }
  }
  render();
}

btn.addEventListener('click', () => {
  running = !running;
  btn.textContent = running ? 'Pause' : 'Start';
  if (running) timer = setInterval(tick, 1000);
  else clearInterval(timer);
});
document.getElementById('reset').addEventListener('click', () => {
  clearInterval(timer); running = false; btn.textContent = 'Start';
  phase = 'work'; left = WORK; render();
});
render();
</script>
</body>
</html>`),
  },
  {
    id: "kanban",
    prompt: "Code a mini kanban board as a single self-contained HTML file. Three columns titled \"To do\", \"Doing\" and \"Done\" with ids \"col-todo\", \"col-doing\", \"col-done\"; a text input with id \"new-task\" plus an add button with id \"add\" that creates a card in To do. Each card has ◀/▶ buttons to move between adjacent columns (hidden or disabled at the ends) and a delete button. Persist the whole board in localStorage. Reply with one complete HTML file in a ```html code block.",
    probes: "probe('columns exist',!!$('#col-todo')&&!!$('#col-doing')&&!!$('#col-done'));probe('input exists',!!$('#new-task')&&!!$('#add'));\nconst set=(v)=>{$('#new-task').value=v;$('#new-task').dispatchEvent(new Event('input',{bubbles:true}));};\nset('ship the fix');clickEl($('#add'));await sleep(150);\nprobe('card added to todo',/ship the fix/.test($('#col-todo').textContent));\nprobe('persisted',JSON.stringify(Object.values(localStorage)).includes('ship the fix'));\nconst card=Array.from($('#col-todo').querySelectorAll('*')).find(el=>/ship the fix/.test(el.textContent)&&el.querySelector('button'));\nconst right=Array.from(card?.querySelectorAll('button')||[]).find(b=>/▶|→|>/.test(b.textContent));\nif(right){clickEl(right);await sleep(150);probe('moves to doing',/ship the fix/.test($('#col-doing').textContent)&&!/ship the fix/.test($('#col-todo').textContent));}else probe('moves to doing',false);",
    exemplar: H(`
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Mini Kanban</title>
<style>
  body { font-family: system-ui, sans-serif; background: #20232a; color: #e6e6e6; padding: 26px; }
  #toolbar { display: flex; gap: 10px; margin-bottom: 20px; }
  #new-task { flex: 0 0 280px; padding: 9px; border-radius: 8px; border: 1px solid #3d4148; background: #16181d; color: #e6e6e6; }
  #add { padding: 9px 20px; background: #61dafb; border: none; border-radius: 8px; cursor: pointer; font-weight: 600; }
  #board { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; max-width: 960px; }
  .col { background: #282c34; border-radius: 12px; padding: 14px; min-height: 220px; }
  .col h2 { margin: 0 0 12px; font-size: 1rem; text-transform: uppercase; letter-spacing: 2px; color: #9aa4b2; }
  .card { background: #333842; border-radius: 8px; padding: 10px; margin-bottom: 10px; display: flex; align-items: center; gap: 6px; }
  .card span { flex: 1; }
  .card button { background: none; border: none; color: #9aa4b2; cursor: pointer; font-size: .95rem; }
  .card button:disabled { opacity: .25; cursor: default; }
  .card button.del { color: #ff7a7a; }
</style>
</head>
<body>
<div id="toolbar">
  <input id="new-task" placeholder="New task…">
  <button id="add">Add</button>
</div>
<div id="board">
  <div class="col" id="col-todo"><h2>To do</h2></div>
  <div class="col" id="col-doing"><h2>Doing</h2></div>
  <div class="col" id="col-done"><h2>Done</h2></div>
</div>
<script>
const COLS = ['todo', 'doing', 'done'];
let tasks = JSON.parse(localStorage.getItem('kanban') || '[]');  // {text, col}
const save = () => localStorage.setItem('kanban', JSON.stringify(tasks));

function render() {
  for (const c of COLS) {
    const el = document.getElementById('col-' + c);
    el.querySelectorAll('.card').forEach((n) => n.remove());
  }
  tasks.forEach((t, i) => {
    const card = document.createElement('div');
    card.className = 'card';
    const ci = COLS.indexOf(t.col);
    const left = document.createElement('button');
    left.textContent = '◀'; left.disabled = ci === 0;
    left.addEventListener('click', () => { t.col = COLS[ci - 1]; save(); render(); });
    const label = document.createElement('span');
    label.textContent = t.text;
    const right = document.createElement('button');
    right.textContent = '▶'; right.disabled = ci === COLS.length - 1;
    right.addEventListener('click', () => { t.col = COLS[ci + 1]; save(); render(); });
    const del = document.createElement('button');
    del.textContent = '✕'; del.className = 'del';
    del.addEventListener('click', () => { tasks.splice(i, 1); save(); render(); });
    card.append(left, label, right, del);
    document.getElementById('col-' + t.col).appendChild(card);
  });
}

document.getElementById('add').addEventListener('click', () => {
  const inp = document.getElementById('new-task');
  const text = inp.value.trim();
  if (!text) return;
  tasks.push({ text, col: 'todo' });
  inp.value = ''; save(); render();
});
render();
</script>
</body>
</html>`),
  },
  {
    id: "password-generator",
    prompt: "Code a password generator as a single self-contained HTML file. A length slider with id \"length\" (8-64, live value shown in an element with id \"length-value\"), checkboxes with ids \"upper\", \"digits\", \"symbols\" (lowercase always on), a generate button with id \"generate\", the password in an element with id \"password\", and a copy button with id \"copy\" that confirms with a brief \"Copied!\" message. Guarantee at least one character from every enabled class. Reply with one complete HTML file in a ```html code block.",
    probes: "probe('controls exist',!!$('#length')&&!!$('#length-value')&&!!$('#upper')&&!!$('#digits')&&!!$('#symbols')&&!!$('#generate')&&!!$('#password')&&!!$('#copy'));\n$('#length').value='20';$('#length').dispatchEvent(new Event('input',{bubbles:true}));await sleep(100);\nprobe('length label live',/20/.test($('#length-value').textContent));\n$('#upper').checked=true;$('#digits').checked=true;$('#upper').dispatchEvent(new Event('change',{bubbles:true}));$('#digits').dispatchEvent(new Event('change',{bubbles:true}));\nclickEl($('#generate'));await sleep(120);\nconst pw=$('#password').textContent.trim()||$('#password').value||'';\nprobe('length respected',pw.length===20);\nprobe('has upper+digit+lower',/[A-Z]/.test(pw)&&/\\d/.test(pw)&&/[a-z]/.test(pw));\nclickEl($('#generate'));await sleep(120);const pw2=$('#password').textContent.trim()||$('#password').value||'';probe('regenerates differently',pw2!==pw&&pw2.length===20);",
    exemplar: H(`
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Password Generator</title>
<style>
  body { font-family: system-ui, sans-serif; background: #10151f; color: #dfe7f3; display: flex; justify-content: center; padding-top: 70px; }
  #app { width: min(440px, 92vw); background: #1a2230; border-radius: 14px; padding: 26px; }
  h1 { font-size: 1.2rem; margin-top: 0; }
  .row { display: flex; align-items: center; gap: 10px; margin: 12px 0; }
  #length { flex: 1; }
  #password { font-family: ui-monospace, monospace; font-size: 1.05rem; background: #0c1119; border-radius: 8px; padding: 14px; word-break: break-all; min-height: 1.4em; margin: 16px 0; }
  button { padding: 10px 18px; border: none; border-radius: 8px; cursor: pointer; font-size: .95rem; }
  #generate { background: #4f9cf9; color: #0c1119; font-weight: 600; }
  #copy { background: #2a3547; color: #dfe7f3; }
  #copied { color: #58d68d; font-size: .85rem; margin-left: 8px; opacity: 0; transition: opacity .2s; }
  #copied.show { opacity: 1; }
</style>
</head>
<body>
<div id="app">
  <h1>Password Generator</h1>
  <div class="row">
    <label>Length</label>
    <input id="length" type="range" min="8" max="64" value="16">
    <span id="length-value">16</span>
  </div>
  <div class="row"><label><input id="upper" type="checkbox" checked> Uppercase</label></div>
  <div class="row"><label><input id="digits" type="checkbox" checked> Digits</label></div>
  <div class="row"><label><input id="symbols" type="checkbox"> Symbols</label></div>
  <div id="password">—</div>
  <div class="row">
    <button id="generate">Generate</button>
    <button id="copy">Copy</button>
    <span id="copied">Copied!</span>
  </div>
</div>
<script>
const SETS = {
  lower: 'abcdefghijkmnopqrstuvwxyz',
  upper: 'ABCDEFGHJKLMNPQRSTUVWXYZ',
  digits: '23456789',
  symbols: '!@#$%^&*-_=+?',
};
const lengthEl = document.getElementById('length');
const lengthValue = document.getElementById('length-value');
const passwordEl = document.getElementById('password');

lengthEl.addEventListener('input', () => { lengthValue.textContent = lengthEl.value; });

const pick = (s) => s[Math.floor(Math.random() * s.length)];

function generate() {
  const n = +lengthEl.value;
  const classes = ['lower'];
  if (document.getElementById('upper').checked) classes.push('upper');
  if (document.getElementById('digits').checked) classes.push('digits');
  if (document.getElementById('symbols').checked) classes.push('symbols');
  // one guaranteed char per enabled class, rest from the combined pool
  const chars = classes.map((c) => pick(SETS[c]));
  const pool = classes.map((c) => SETS[c]).join('');
  while (chars.length < n) chars.push(pick(pool));
  // shuffle so the guaranteed chars aren't clustered at the front
  for (let i = chars.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  passwordEl.textContent = chars.join('');
}

document.getElementById('generate').addEventListener('click', generate);
document.getElementById('copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(passwordEl.textContent); } catch { /* file:// may block */ }
  const c = document.getElementById('copied');
  c.classList.add('show');
  setTimeout(() => c.classList.remove('show'), 1200);
});
generate();
</script>
</body>
</html>`),
  },
  {
    id: "weather-dashboard",
    prompt: "Code a weather dashboard as a single self-contained HTML file using built-in demo data (no network requests). A city select with id \"city\" offering at least 5 cities; show the selected city's current temperature in an element with id \"temp\", condition text in an element with id \"condition\", a matching weather emoji in an element with id \"icon\", and a 5-day forecast as cards inside a container with id \"forecast\" (day name, emoji, high/low). A toggle button with id \"unit\" switches every temperature between °C and °F. Reply with one complete HTML file in a ```html code block.",
    probes: "probe('controls exist',!!$('#city')&&!!$('#temp')&&!!$('#condition')&&!!$('#icon')&&!!$('#forecast')&&!!$('#unit'));\nprobe('5 cities',($('#city')?.options.length||0)>=5);probe('5 forecast cards',($('#forecast')?.children.length||0)>=5);\nconst t0=$('#temp').textContent;probe('temp shown',/-?\\d+/.test(t0));\nclickEl($('#unit'));await sleep(120);const t1=$('#temp').textContent;probe('unit toggles',t1!==t0&&/-?\\d+/.test(t1));\nconst sel=$('#city');sel.selectedIndex=(sel.selectedIndex+1)%sel.options.length;sel.dispatchEvent(new Event('change',{bubbles:true}));await sleep(120);\nprobe('city switch updates',$('#temp').textContent!==t1||$('#condition').textContent.length>0);",
    exemplar: H(`
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Weather</title>
<style>
  body { font-family: system-ui, sans-serif; background: linear-gradient(160deg, #1e3c72, #2a5298); color: #f2f6fb; display: flex; justify-content: center; padding-top: 50px; min-height: 100vh; margin: 0; }
  #app { width: min(560px, 92vw); }
  header { display: flex; gap: 12px; align-items: center; margin-bottom: 26px; }
  #city { padding: 9px 12px; border-radius: 8px; border: none; font-size: 1rem; }
  #unit { margin-left: auto; padding: 9px 16px; border-radius: 8px; border: none; background: rgba(255,255,255,.2); color: #fff; cursor: pointer; }
  #now { text-align: center; margin-bottom: 30px; }
  #icon { font-size: 4rem; }
  #temp { font-size: 3.2rem; font-weight: 700; }
  #condition { color: #cfe0f4; }
  #forecast { display: grid; grid-template-columns: repeat(5, 1fr); gap: 10px; }
  .day { background: rgba(255,255,255,.12); border-radius: 10px; padding: 12px 6px; text-align: center; font-size: .85rem; }
  .day .e { font-size: 1.6rem; margin: 6px 0; }
</style>
</head>
<body>
<div id="app">
  <header>
    <select id="city"></select>
    <button id="unit">°C / °F</button>
  </header>
  <div id="now">
    <div id="icon"></div>
    <div id="temp"></div>
    <div id="condition"></div>
  </div>
  <div id="forecast"></div>
</div>
<script>
const EMOJI = { sunny: '☀️', cloudy: '☁️', rain: '🌧️', storm: '⛈️', snow: '❄️', fog: '🌫️' };
const DATA = {
  'Lisbon':   { t: 24, c: 'sunny',  f: [[26,18,'sunny'],[27,19,'sunny'],[24,17,'cloudy'],[22,16,'rain'],[25,18,'sunny']] },
  'London':   { t: 14, c: 'rain',   f: [[15,9,'rain'],[13,8,'cloudy'],[16,10,'cloudy'],[14,9,'rain'],[12,7,'storm']] },
  'Tokyo':    { t: 21, c: 'cloudy', f: [[22,15,'cloudy'],[24,16,'sunny'],[23,17,'rain'],[20,14,'rain'],[22,15,'cloudy']] },
  'Denver':   { t: 8,  c: 'snow',   f: [[6,-2,'snow'],[9,0,'cloudy'],[12,2,'sunny'],[7,-1,'snow'],[10,1,'sunny']] },
  'Singapore':{ t: 31, c: 'storm',  f: [[32,26,'storm'],[31,26,'rain'],[33,27,'cloudy'],[32,26,'storm'],[31,25,'rain']] },
  'Reykjavik':{ t: 4,  c: 'fog',    f: [[5,0,'fog'],[6,1,'cloudy'],[4,-1,'snow'],[7,2,'cloudy'],[5,0,'fog']] },
};
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const citySel = document.getElementById('city');
let celsius = true;

for (const name of Object.keys(DATA)) {
  const o = document.createElement('option');
  o.value = name; o.textContent = name;
  citySel.appendChild(o);
}

const conv = (c) => celsius ? Math.round(c) + '°C' : Math.round(c * 9 / 5 + 32) + '°F';

function render() {
  const d = DATA[citySel.value];
  document.getElementById('icon').textContent = EMOJI[d.c];
  document.getElementById('temp').textContent = conv(d.t);
  document.getElementById('condition').textContent = d.c[0].toUpperCase() + d.c.slice(1);
  const fc = document.getElementById('forecast');
  fc.innerHTML = '';
  const today = new Date().getDay();       // 0=Sun
  d.f.forEach(([hi, lo, cond], i) => {
    const day = document.createElement('div');
    day.className = 'day';
    day.innerHTML = '<div>' + DAYS[(today + i) % 7] + '</div><div class="e">' + EMOJI[cond] + '</div>' +
                    '<div>' + conv(hi) + ' / ' + conv(lo) + '</div>';
    fc.appendChild(day);
  });
}

citySel.addEventListener('change', render);
document.getElementById('unit').addEventListener('click', () => { celsius = !celsius; render(); });
render();
</script>
</body>
</html>`),
  },
  {
    id: "maze",
    prompt: "Code a maze generator and solver as a single self-contained HTML file. A canvas with id \"maze\" showing a perfect maze at least 15x15 cells (generated with a random algorithm like recursive backtracking, entrance top-left, exit bottom-right), a regenerate button with id \"generate\", and a solve button with id \"solve\" that draws the solution path in a contrasting color. Reply with one complete HTML file in a ```html code block.",
    probes: "probe('canvas exists',!!$('#maze'));probe('buttons exist',!!$('#generate')&&!!$('#solve'));\nconst f1=canvasData('#maze');clickEl($('#generate'));await sleep(300);const f2=canvasData('#maze');probe('regenerate changes maze',!!f1&&!!f2&&f1!==f2);\nclickEl($('#solve'));await sleep(400);const f3=canvasData('#maze');probe('solve draws path',!!f3&&f3!==f2);",
    exemplar: H(`
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Maze</title>
<style>
  body { font-family: system-ui, sans-serif; background: #14141b; color: #d8d8e6; display: flex; flex-direction: column; align-items: center; padding-top: 30px; }
  canvas { background: #1e1e29; border-radius: 8px; }
  #controls { margin-top: 16px; }
  button { padding: 9px 22px; margin: 0 6px; background: #3c3c55; color: #d8d8e6; border: none; border-radius: 8px; cursor: pointer; font-size: .95rem; }
</style>
</head>
<body>
<canvas id="maze" width="450" height="450"></canvas>
<div id="controls">
  <button id="generate">Regenerate</button>
  <button id="solve">Solve</button>
</div>
<script>
const N = 15, CELL = 30;
const cv = document.getElementById('maze');
const cx = cv.getContext('2d');
let walls;   // walls[y][x] = {t,r,b,l}

function generate() {
  walls = Array.from({ length: N }, () => Array.from({ length: N }, () => ({ t: 1, r: 1, b: 1, l: 1 })));
  const visited = Array.from({ length: N }, () => Array(N).fill(false));
  const stack = [[0, 0]];
  visited[0][0] = true;
  while (stack.length) {
    const [x, y] = stack[stack.length - 1];
    const nbrs = [[x, y - 1, 't', 'b'], [x + 1, y, 'r', 'l'], [x, y + 1, 'b', 't'], [x - 1, y, 'l', 'r']]
      .filter(([nx, ny]) => nx >= 0 && nx < N && ny >= 0 && ny < N && !visited[ny][nx]);
    if (!nbrs.length) { stack.pop(); continue; }
    const [nx, ny, mine, theirs] = nbrs[Math.floor(Math.random() * nbrs.length)];
    walls[y][x][mine] = 0;
    walls[ny][nx][theirs] = 0;
    visited[ny][nx] = true;
    stack.push([nx, ny]);
  }
  draw();
}

function draw(path) {
  cx.fillStyle = '#1e1e29';
  cx.fillRect(0, 0, cv.width, cv.height);
  if (path) {
    cx.strokeStyle = '#ff5d8f'; cx.lineWidth = CELL / 3; cx.lineCap = 'round'; cx.lineJoin = 'round';
    cx.beginPath();
    path.forEach(([x, y], i) => {
      const px = x * CELL + CELL / 2, py = y * CELL + CELL / 2;
      i ? cx.lineTo(px, py) : cx.moveTo(px, py);
    });
    cx.stroke();
  }
  cx.strokeStyle = '#8f8fb0'; cx.lineWidth = 2; cx.lineCap = 'square';
  cx.beginPath();
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const w = walls[y][x], px = x * CELL, py = y * CELL;
      if (w.t) { cx.moveTo(px, py); cx.lineTo(px + CELL, py); }
      if (w.l) { cx.moveTo(px, py); cx.lineTo(px, py + CELL); }
      if (y === N - 1 && w.b) { cx.moveTo(px, py + CELL); cx.lineTo(px + CELL, py + CELL); }
      if (x === N - 1 && w.r) { cx.moveTo(px + CELL, py); cx.lineTo(px + CELL, py + CELL); }
    }
  cx.stroke();
  // entrance / exit markers
  cx.fillStyle = '#3ddc97'; cx.fillRect(4, 4, CELL - 8, CELL - 8);
  cx.fillStyle = '#ffd166'; cx.fillRect((N - 1) * CELL + 4, (N - 1) * CELL + 4, CELL - 8, CELL - 8);
}

function solve() {
  // BFS from (0,0) to (N-1,N-1)
  const prev = Array.from({ length: N }, () => Array(N).fill(null));
  const q = [[0, 0]];
  const seen = Array.from({ length: N }, () => Array(N).fill(false));
  seen[0][0] = true;
  while (q.length) {
    const [x, y] = q.shift();
    if (x === N - 1 && y === N - 1) break;
    const w = walls[y][x];
    for (const [nx, ny, blocked] of [[x, y - 1, w.t], [x + 1, y, w.r], [x, y + 1, w.b], [x - 1, y, w.l]]) {
      if (blocked || nx < 0 || nx >= N || ny < 0 || ny >= N || seen[ny][nx]) continue;
      seen[ny][nx] = true;
      prev[ny][nx] = [x, y];
      q.push([nx, ny]);
    }
  }
  const path = [];
  let cur = [N - 1, N - 1];
  while (cur) { path.unshift(cur); cur = prev[cur[1]][cur[0]]; }
  draw(path);
}

document.getElementById('generate').addEventListener('click', generate);
document.getElementById('solve').addEventListener('click', solve);
generate();
</script>
</body>
</html>`),
  },
  {
    id: "metronome",
    prompt: "Code a visual metronome as a single self-contained HTML file (no audio needed). A BPM slider with id \"bpm\" (40-220) whose current value shows live in an element with id \"bpm-value\", a start/stop button with id \"toggle\" whose label switches, a large circle with id \"beat\" that pulses visibly on every beat, and a beat counter cycling 1-4 in an element with id \"count\" with beat 1 visually accented. Changing BPM while running must take effect immediately. Reply with one complete HTML file in a ```html code block.",
    probes: "probe('controls exist',!!$('#bpm')&&!!$('#bpm-value')&&!!$('#toggle')&&!!$('#beat')&&!!$('#count'));\n$('#bpm').value='200';$('#bpm').dispatchEvent(new Event('input',{bubbles:true}));await sleep(100);probe('bpm label live',/200/.test($('#bpm-value').textContent));\nclickEl($('#toggle'));await sleep(150);probe('label switches',/stop|pause/i.test($('#toggle').textContent));\nconst c0=$('#count').textContent;let pulsed=false,counted=false;\nfor(let i=0;i<14;i++){await sleep(120);const cls=$('#beat').className+$('#beat').style.cssText;if(/pulse|active|on|scale/.test(cls))pulsed=true;if($('#count').textContent!==c0)counted=true;}\nprobe('beat pulses',pulsed);probe('counter advances',counted);\nclickEl($('#toggle'));await sleep(200);const c1=$('#count').textContent;await sleep(600);probe('stop freezes',$('#count').textContent===c1);",
    exemplar: H(`
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Metronome</title>
<style>
  body { font-family: system-ui, sans-serif; background: #171123; color: #efe9ff; display: flex; flex-direction: column; align-items: center; padding-top: 50px; }
  #beat { width: 140px; height: 140px; border-radius: 50%; background: #2d2447; margin: 30px 0; transition: transform 60ms ease-out, background 60ms; }
  #beat.pulse { transform: scale(1.18); background: #8b5cf6; }
  #beat.pulse.accent { background: #f472b6; }
  #count { font-size: 2.2rem; font-weight: 700; min-height: 1.3em; }
  #count.accent { color: #f472b6; }
  .row { display: flex; align-items: center; gap: 12px; margin-top: 24px; }
  #bpm { width: 240px; }
  #toggle { padding: 10px 28px; font-size: 1rem; background: #8b5cf6; color: #171123; font-weight: 600; border: none; border-radius: 8px; cursor: pointer; margin-top: 18px; }
</style>
</head>
<body>
<h1>Metronome</h1>
<div id="beat"></div>
<div id="count">–</div>
<div class="row">
  <input id="bpm" type="range" min="40" max="220" value="100">
  <span id="bpm-value">100 BPM</span>
</div>
<button id="toggle">Start</button>
<script>
const bpmEl = document.getElementById('bpm');
const bpmValue = document.getElementById('bpm-value');
const beatEl = document.getElementById('beat');
const countEl = document.getElementById('count');
const toggleBtn = document.getElementById('toggle');
let running = false, beat = 0, nextAt = 0, raf = null;

bpmEl.addEventListener('input', () => { bpmValue.textContent = bpmEl.value + ' BPM'; });

function loop(t) {
  if (t >= nextAt) {
    beat = beat % 4 + 1;
    const accent = beat === 1;
    countEl.textContent = beat;
    countEl.classList.toggle('accent', accent);
    beatEl.className = 'pulse' + (accent ? ' accent' : '');
    setTimeout(() => beatEl.classList.remove('pulse', 'accent'), 90);
    // schedule from the ideal time, reading the CURRENT bpm so slider changes apply live
    nextAt = Math.max(t, nextAt) + 60000 / (+bpmEl.value);
  }
  raf = requestAnimationFrame(loop);
}

toggleBtn.addEventListener('click', () => {
  running = !running;
  toggleBtn.textContent = running ? 'Stop' : 'Start';
  if (running) { beat = 0; nextAt = performance.now(); raf = requestAnimationFrame(loop); }
  else { cancelAnimationFrame(raf); }
});
</script>
</body>
</html>`),
  },
  {
    id: "fifteen-puzzle",
    prompt: "Code a 15-puzzle (sliding number puzzle) as a single self-contained HTML file. A 4x4 grid inside a container with id \"board\" holding tiles numbered 1-15 plus one empty slot; clicking a tile adjacent to the empty slot slides it there; count moves in an element with id \"moves\"; a shuffle button with id \"shuffle\" scrambles with a series of random valid moves (always solvable); when tiles return to order show a win message in an element with id \"message\". Reply with one complete HTML file in a ```html code block.",
    probes: "const b=$('#board');probe('16 slots',!!b&&b.children.length===16);probe('moves exists',!!$('#moves')&&/\\d/.test($('#moves').textContent));probe('shuffle exists',!!$('#shuffle'));\nclickEl($('#shuffle'));await sleep(250);\nconst nums=Array.from(b.children).map(c=>c.textContent.trim()).filter(Boolean);\nprobe('15 numbered tiles',nums.length===15&&new Set(nums).size===15);\nconst layout0=b.textContent.replace(/\\s/g,'');const m0=parseInt($('#moves').textContent.match(/\\d+/)?.[0]||'0');\nlet slid=false;for(const c of Array.from(b.children)){clickEl(c);await sleep(60);if(b.textContent.replace(/\\s/g,'')!==layout0){slid=true;break;}}\nprobe('tile slides on click',slid);\nprobe('move counted',parseInt($('#moves').textContent.match(/\\d+/)?.[0]||'0')>m0);",
    exemplar: H(`
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>15 Puzzle</title>
<style>
  body { font-family: system-ui, sans-serif; background: #232946; color: #fffffe; display: flex; flex-direction: column; align-items: center; padding-top: 36px; }
  #hud { display: flex; gap: 20px; align-items: center; margin-bottom: 16px; }
  #shuffle { padding: 9px 22px; background: #eebbc3; color: #232946; font-weight: 600; border: none; border-radius: 8px; cursor: pointer; }
  #board { display: grid; grid-template-columns: repeat(4, 78px); gap: 8px; background: #121629; padding: 10px; border-radius: 12px; }
  .tile { height: 78px; border-radius: 8px; background: #b8c1ec; color: #232946; font-size: 1.6rem; font-weight: 700; border: none; cursor: pointer; }
  .tile.empty { background: transparent; cursor: default; }
  #message { min-height: 1.6em; margin-top: 16px; font-size: 1.2rem; color: #eebbc3; }
</style>
</head>
<body>
<div id="hud">
  <span>Moves: <span id="moves">0</span></span>
  <button id="shuffle">Shuffle</button>
</div>
<div id="board"></div>
<div id="message"></div>
<script>
const board = document.getElementById('board');
const movesEl = document.getElementById('moves');
const msgEl = document.getElementById('message');
let tiles = [...Array(15).keys()].map(n => n + 1).concat(0);  // 0 = empty
let moves = 0;

function idxOf(v) { return tiles.indexOf(v); }

function neighbors(i) {
  const x = i % 4, y = Math.floor(i / 4), out = [];
  if (x > 0) out.push(i - 1);
  if (x < 3) out.push(i + 1);
  if (y > 0) out.push(i - 4);
  if (y < 3) out.push(i + 4);
  return out;
}

function render() {
  board.innerHTML = '';
  tiles.forEach((v, i) => {
    const t = document.createElement('button');
    t.className = 'tile' + (v ? '' : ' empty');
    t.textContent = v || '';
    if (v) t.addEventListener('click', () => slide(i, true));
    board.appendChild(t);
  });
  movesEl.textContent = moves;
}

function slide(i, count) {
  const e = idxOf(0);
  if (!neighbors(i).includes(e)) return false;
  [tiles[i], tiles[e]] = [tiles[e], tiles[i]];
  if (count) {
    moves++;
    if (tiles.slice(0, 15).every((v, k) => v === k + 1)) msgEl.textContent = '🎉 Solved in ' + moves + ' moves!';
  }
  render();
  return true;
}

function shuffle() {
  // scramble with valid random moves only — guaranteed solvable
  for (let n = 0; n < 250; n++) {
    const e = idxOf(0);
    const opts = neighbors(e);
    slide(opts[Math.floor(Math.random() * opts.length)], false);
  }
  moves = 0; msgEl.textContent = '';
  render();
}

document.getElementById('shuffle').addEventListener('click', shuffle);
shuffle();
</script>
</body>
</html>`),
  },
  {
    id: "markdown-preview",
    prompt: "Code a live markdown previewer as a single self-contained HTML file (no external libraries — implement a small subset yourself). A textarea with id \"input\" on the left and the rendered preview in an element with id \"preview\" on the right, updating as you type. Support # / ## / ### headings, **bold**, *italic*, `inline code`, - bullet lists and [links](url). Preload the textarea with a short demo document showing all features. Reply with one complete HTML file in a ```html code block.",
    probes: "probe('panes exist',!!$('#input')&&!!$('#preview'));\nprobe('demo preloaded',($('#input')?.value||'').length>30);\nprobe('heading rendered',!!$('#preview').querySelector('h1,h2,h3'));\nprobe('bold rendered',!!$('#preview').querySelector('strong,b'));\nprobe('list rendered',!!$('#preview').querySelector('li'));\n$('#input').value='## Probe\\n\\n**strong** and *soft* with `code` here';$('#input').dispatchEvent(new Event('input',{bubbles:true}));await sleep(250);\nprobe('live update',/Probe/.test($('#preview').textContent)&&!!$('#preview').querySelector('h2')&&!!$('#preview').querySelector('code'));",
    exemplar: H(`
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Markdown Preview</title>
<style>
  body { margin: 0; font-family: system-ui, sans-serif; background: #14181d; color: #dce3ea; height: 100vh; display: flex; flex-direction: column; }
  h1.title { font-size: 1rem; margin: 0; padding: 12px 18px; background: #1c232b; }
  main { flex: 1; display: flex; min-height: 0; }
  #input { width: 50%; border: none; outline: none; resize: none; padding: 18px; background: #10141a; color: #dce3ea; font: 14px/1.6 ui-monospace, monospace; }
  #preview { width: 50%; overflow: auto; padding: 18px 26px; border-left: 1px solid #2a333d; }
  #preview code { background: #232c36; padding: 2px 6px; border-radius: 4px; font-family: ui-monospace, monospace; }
  #preview a { color: #58a6ff; }
</style>
</head>
<body>
<h1 class="title">Markdown Preview</h1>
<main>
  <textarea id="input" spellcheck="false"></textarea>
  <div id="preview"></div>
</main>
<script>
const input = document.getElementById('input');
const preview = document.getElementById('preview');

const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function inline(s) {
  return s
    .replace(/\\\`([^\\\`]+)\\\`/g, '<code>$1</code>')
    .replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>')
    .replace(/\\*([^*]+)\\*/g, '<em>$1</em>')
    .replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
}

function render(md) {
  const out = [];
  let list = false;
  for (const raw of md.split('\\n')) {
    const line = escapeHtml(raw);
    const bullet = line.match(/^\\s*- (.*)/);
    if (bullet) {
      if (!list) { out.push('<ul>'); list = true; }
      out.push('<li>' + inline(bullet[1]) + '</li>');
      continue;
    }
    if (list) { out.push('</ul>'); list = false; }
    const h = line.match(/^(#{1,3}) (.*)/);
    if (h) out.push('<h' + h[1].length + '>' + inline(h[2]) + '</h' + h[1].length + '>');
    else if (line.trim()) out.push('<p>' + inline(line) + '</p>');
  }
  if (list) out.push('</ul>');
  return out.join('\\n');
}

input.value = [
  '# Markdown Preview',
  '',
  'Type on the left, see it rendered on the right.',
  '',
  '## Features',
  '- **bold** and *italic*',
  '- \\\`inline code\\\`',
  '- [links](https://example.com)',
].join('\\n');

const update = () => { preview.innerHTML = render(input.value); };
input.addEventListener('input', update);
update();
</script>
</body>
</html>`),
  },
  {
    id: "connect-four",
    prompt: "Code a two-player Connect Four game as a single self-contained HTML file. A 7-column by 6-row board inside a container with id \"board\" (42 cells, clicking anywhere in a column drops a disc into the lowest empty row of that column), a status line with id \"status\" showing whose turn it is (Red starts) and announcing the winner or a draw, and a restart button with id \"restart\". Detect 4-in-a-row horizontally, vertically and diagonally. Reply with one complete HTML file in a ```html code block.",
    probes: "const b=$('#board');probe('board 42 cells',!!b&&b.children.length===42);probe('status exists',!!$('#status'));probe('restart exists',!!$('#restart'));\nconst lit=()=>Array.from(b.children).filter(c=>c.classList.contains('r')||c.classList.contains('y')).length;\nif(b){const bottomOfCol0=Array.from(b.children).filter(c=>+c.dataset.col===0).pop();clickEl(bottomOfCol0);await sleep(120);probe('click drops disc',lit()===1);const t0=$('#status').textContent;const bottomOfCol1=Array.from(b.children).filter(c=>+c.dataset.col===1).pop();clickEl(bottomOfCol1);await sleep(120);probe('turn changes',$('#status').textContent!==t0);clickEl($('#restart'));await sleep(120);probe('restart clears',lit()===0);}else{probe('click drops disc',false);probe('turn changes',false);probe('restart clears',false);}",
    exemplar: H(`
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Connect Four</title>
<style>
  body { font-family: system-ui, sans-serif; background: #0b3d91; color: #fff; display: flex; flex-direction: column; align-items: center; padding-top: 30px; }
  #status { font-size: 1.3rem; margin-bottom: 16px; min-height: 1.5em; }
  #board { display: grid; grid-template-columns: repeat(7, 56px); grid-template-rows: repeat(6, 56px); gap: 6px; background: #072a66; padding: 10px; border-radius: 12px; }
  .cell { width: 56px; height: 56px; border-radius: 50%; background: #0b3d91; cursor: pointer; box-shadow: inset 0 2px 4px rgba(0,0,0,.4); }
  .cell.r { background: #e63946; }
  .cell.y { background: #ffd166; }
  #restart { margin-top: 22px; padding: 9px 26px; font-size: 1rem; background: #ffd166; color: #072a66; border: none; border-radius: 8px; cursor: pointer; font-weight: 600; }
</style>
</head>
<body>
<h1>Connect Four</h1>
<div id="status">Red's turn</div>
<div id="board"></div>
<button id="restart">Restart</button>
<script>
const ROWS = 6, COLS = 7;
const board = document.getElementById('board');
const status = document.getElementById('status');
let grid, turn, over, cells;

function build() {
  board.innerHTML = ''; cells = [];
  for (let r = 0; r < ROWS; r++) {
    cells.push([]);
    for (let c = 0; c < COLS; c++) {
      const d = document.createElement('div');
      d.className = 'cell';
      d.dataset.col = c; d.dataset.row = r;
      d.addEventListener('click', () => drop(c));
      board.appendChild(d);
      cells[r].push(d);
    }
  }
}

function reset() {
  grid = Array.from({ length: ROWS }, () => Array(COLS).fill(null));
  turn = 'r'; over = false;
  for (const row of cells) for (const cell of row) cell.className = 'cell';
  status.textContent = "Red's turn";
}

function lowestEmptyRow(c) {
  for (let r = ROWS - 1; r >= 0; r--) if (!grid[r][c]) return r;
  return -1;
}

function checkWin(r, c) {
  const dirs = [[0,1],[1,0],[1,1],[1,-1]];
  for (const [dr, dc] of dirs) {
    let count = 1;
    for (const sign of [1, -1]) {
      let rr = r + dr * sign, cc = c + dc * sign;
      while (rr >= 0 && rr < ROWS && cc >= 0 && cc < COLS && grid[rr][cc] === grid[r][c]) {
        count++; rr += dr * sign; cc += dc * sign;
      }
    }
    if (count >= 4) return true;
  }
  return false;
}

function drop(c) {
  if (over) return;
  const r = lowestEmptyRow(c);
  if (r < 0) return;
  grid[r][c] = turn;
  cells[r][c].classList.add(turn);
  if (checkWin(r, c)) {
    status.textContent = (turn === 'r' ? 'Red' : 'Yellow') + ' wins!';
    over = true;
  } else if (grid.every(row => row.every(v => v))) {
    status.textContent = "It's a draw";
    over = true;
  } else {
    turn = turn === 'r' ? 'y' : 'r';
    status.textContent = (turn === 'r' ? "Red's" : "Yellow's") + ' turn';
  }
}

document.getElementById('restart').addEventListener('click', reset);
build();
reset();
</script>
</body>
</html>`),
  },
  {
    id: "lights-out",
    prompt: "Code a Lights Out puzzle as a single self-contained HTML file. A 5x5 grid inside a container with id \"grid\" (25 cells); clicking a cell toggles it AND its up/down/left/right neighbors between lit and unlit; a shuffle button with id \"shuffle\" scrambles the board using a random sequence of valid toggles (so it is always guaranteed solvable); a moves counter in an element with id \"moves\"; when every cell is unlit, show a win message in an element with id \"message\". Reply with one complete HTML file in a ```html code block.",
    probes: "const g=$('#grid');probe('25 cells',!!g&&g.children.length===25);probe('shuffle exists',!!$('#shuffle'));probe('moves exists',!!$('#moves'));probe('message exists',!!$('#message'));\nconst lit=()=>Array.from(g.children).filter(c=>c.classList.contains('on')).length;\nclickEl($('#shuffle'));await sleep(150);\nconst cell=g.children[12];const before=cell.classList.contains('on');\nclickEl(cell);await sleep(100);\nprobe('click toggles clicked cell',cell.classList.contains('on')!==before);\nprobe('moves counted',parseInt($('#moves').textContent.match(/\\d+/)?.[0]||'0')>=1);",
    exemplar: H(`
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Lights Out</title>
<style>
  body { font-family: system-ui, sans-serif; background: #1a1a2e; color: #eee; display: flex; flex-direction: column; align-items: center; padding-top: 34px; }
  #hud { display: flex; gap: 20px; align-items: center; margin-bottom: 16px; }
  #shuffle { padding: 9px 22px; background: #ffd60a; color: #1a1a2e; font-weight: 600; border: none; border-radius: 8px; cursor: pointer; }
  #grid { display: grid; grid-template-columns: repeat(5, 64px); gap: 6px; background: #0f0f1e; padding: 10px; border-radius: 10px; }
  .cell { width: 64px; height: 64px; border-radius: 8px; background: #2b2b45; cursor: pointer; border: 2px solid #3d3d5c; transition: background .12s; }
  .cell.on { background: #ffd60a; box-shadow: 0 0 16px #ffd60a80; }
  #message { min-height: 1.6em; margin-top: 18px; font-size: 1.2rem; color: #7dd87d; }
</style>
</head>
<body>
<h1>Lights Out</h1>
<div id="hud">
  <span>Moves: <span id="moves">0</span></span>
  <button id="shuffle">Shuffle</button>
</div>
<div id="grid"></div>
<div id="message"></div>
<script>
const N = 5;
const grid = document.getElementById('grid');
const movesEl = document.getElementById('moves');
const msgEl = document.getElementById('message');
let cells = [], moves = 0;

function build() {
  for (let i = 0; i < N * N; i++) {
    const d = document.createElement('div');
    d.className = 'cell';
    d.addEventListener('click', () => { toggleAt(i); moves++; movesEl.textContent = moves; checkWin(); });
    grid.appendChild(d);
    cells.push(d);
  }
}

function neighborsOf(i) {
  const r = Math.floor(i / N), c = i % N, out = [i];
  if (r > 0) out.push(i - N);
  if (r < N - 1) out.push(i + N);
  if (c > 0) out.push(i - 1);
  if (c < N - 1) out.push(i + 1);
  return out;
}

function toggleAt(i) {
  for (const j of neighborsOf(i)) cells[j].classList.toggle('on');
}

function checkWin() {
  const allOff = cells.every(c => !c.classList.contains('on'));
  msgEl.textContent = allOff ? '🎉 Lights out — you solved it!' : '';
}

document.getElementById('shuffle').addEventListener('click', () => {
  cells.forEach(c => c.classList.remove('on'));
  const applied = new Set();
  const scrambleCount = 6 + Math.floor(Math.random() * 6);
  while (applied.size < scrambleCount) applied.add(Math.floor(Math.random() * N * N));
  for (const i of applied) toggleAt(i);   // toggling the same set again always solves it
  moves = 0; movesEl.textContent = '0'; msgEl.textContent = '';
});

build();
</script>
</body>
</html>`),
  },
  {
    id: "age-calculator",
    prompt: "Code an exact age calculator as a single self-contained HTML file. A date input with id \"birthdate\" and a calculate button with id \"calculate\"; on click, show the calendar-exact age broken into years in an element with id \"years\", months in an element with id \"months\", and days in an element with id \"days\" (as of today), plus the number of days until the next birthday in an element with id \"next-birthday\". Reply with one complete HTML file in a ```html code block.",
    probes: "probe('inputs exist',!!$('#birthdate')&&!!$('#calculate')&&!!$('#years')&&!!$('#months')&&!!$('#days')&&!!$('#next-birthday'));\nconst set=(el,v)=>{el.value=v;el.dispatchEvent(new Event('input',{bubbles:true}));};\nset($('#birthdate'),'2000-01-01');clickEl($('#calculate'));await sleep(150);\nconst y=parseInt($('#years').textContent.match(/\\d+/)?.[0]||'-1');probe('years plausible',y>=20&&y<=30);\nprobe('months shown',/\\d/.test($('#months').textContent));\nprobe('days shown',/\\d/.test($('#days').textContent));\nconst nb=parseInt($('#next-birthday').textContent.match(/\\d+/)?.[0]||'-1');probe('next birthday plausible',nb>=0&&nb<=366);",
    exemplar: H(`
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Age Calculator</title>
<style>
  body { font-family: system-ui, sans-serif; background: #f6f7fb; color: #222; display: flex; justify-content: center; padding-top: 70px; }
  #app { width: min(420px, 92vw); background: #fff; border-radius: 14px; box-shadow: 0 6px 24px rgba(30,50,90,.12); padding: 28px; }
  h1 { margin-top: 0; font-size: 1.25rem; }
  .row { display: flex; gap: 10px; margin-bottom: 18px; }
  input { flex: 1; padding: 9px; border: 1px solid #ccd3de; border-radius: 8px; font-size: 1rem; }
  #calculate { padding: 9px 20px; background: #3b6ef6; color: #fff; border: none; border-radius: 8px; cursor: pointer; font-weight: 600; }
  #result { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; text-align: center; margin-bottom: 16px; }
  .stat { background: #eef2fb; border-radius: 10px; padding: 12px 4px; }
  .stat .n { font-size: 1.6rem; font-weight: 700; color: #3b6ef6; }
  .stat .l { font-size: .8rem; color: #667; }
  #next-birthday-row { text-align: center; color: #445; }
</style>
</head>
<body>
<div id="app">
  <h1>Age Calculator</h1>
  <div class="row">
    <input id="birthdate" type="date">
    <button id="calculate">Calculate</button>
  </div>
  <div id="result">
    <div class="stat"><div class="n" id="years">–</div><div class="l">years</div></div>
    <div class="stat"><div class="n" id="months">–</div><div class="l">months</div></div>
    <div class="stat"><div class="n" id="days">–</div><div class="l">days</div></div>
  </div>
  <div id="next-birthday-row">Next birthday in <span id="next-birthday">–</span> days</div>
</div>
<script>
function calc() {
  const raw = document.getElementById('birthdate').value;
  if (!raw) return;
  const bd = new Date(raw + 'T00:00:00');
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  let years = today.getFullYear() - bd.getFullYear();
  let months = today.getMonth() - bd.getMonth();
  let days = today.getDate() - bd.getDate();
  if (days < 0) {
    months--;
    const prevMonth = new Date(today.getFullYear(), today.getMonth(), 0);
    days += prevMonth.getDate();
  }
  if (months < 0) { years--; months += 12; }

  document.getElementById('years').textContent = years;
  document.getElementById('months').textContent = months;
  document.getElementById('days').textContent = days;

  let next = new Date(today.getFullYear(), bd.getMonth(), bd.getDate());
  if (next < today) next = new Date(today.getFullYear() + 1, bd.getMonth(), bd.getDate());
  const untilNext = Math.round((next - today) / 86400000);
  document.getElementById('next-birthday').textContent = untilNext;
}

document.getElementById('calculate').addEventListener('click', calc);
</script>
</body>
</html>`),
  },
  {
    id: "number-base-converter",
    prompt: "Code a number base converter as a single self-contained HTML file. A text input with id \"value\", two selects with ids \"from-base\" and \"to-base\" offering at least binary (2), octal (8), decimal (10) and hexadecimal (16), and the live result in an element with id \"result\". If the input contains digits invalid for the chosen source base, show an error message in \"result\" instead of crashing (and never show a stale numeric result). Reply with one complete HTML file in a ```html code block.",
    probes: "probe('controls exist',!!$('#value')&&!!$('#from-base')&&!!$('#to-base')&&!!$('#result'));\nconst set=(el,v)=>{el.value=v;el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));};\nset($('#from-base'),'16');set($('#to-base'),'10');set($('#value'),'ff');await sleep(150);\nprobe('hex ff to dec 255',/255/.test($('#result').textContent));\nset($('#value'),'zz');await sleep(150);\nprobe('invalid input errors without stale result',/invalid|error/i.test($('#result').textContent)&&!/255/.test($('#result').textContent));",
    exemplar: H(`
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Base Converter</title>
<style>
  body { font-family: system-ui, sans-serif; background: #10151f; color: #dfe7f3; display: flex; justify-content: center; padding-top: 70px; }
  #app { width: min(440px, 92vw); background: #1a2230; border-radius: 14px; padding: 26px; }
  h1 { margin-top: 0; font-size: 1.2rem; }
  .row { display: flex; gap: 10px; align-items: center; margin: 12px 0; }
  input, select { padding: 9px; font-size: 1rem; border-radius: 8px; border: 1px solid #33405a; background: #0f1520; color: #dfe7f3; }
  #value { flex: 1; font-family: ui-monospace, monospace; }
  #result { font-family: ui-monospace, monospace; font-size: 1.3rem; margin-top: 16px; min-height: 1.5em; color: #4f9cf9; }
  #result.err { color: #ff6b6b; font-family: system-ui, sans-serif; font-size: 1rem; }
</style>
</head>
<body>
<div id="app">
  <h1>Number Base Converter</h1>
  <div class="row"><input id="value" value="ff" placeholder="value"></div>
  <div class="row">
    <select id="from-base"></select>
    <span>→</span>
    <select id="to-base"></select>
  </div>
  <div id="result"></div>
</div>
<script>
const BASES = [[2,'Binary'], [8,'Octal'], [10,'Decimal'], [16,'Hexadecimal']];
const fromEl = document.getElementById('from-base');
const toEl = document.getElementById('to-base');
const valueEl = document.getElementById('value');
const resultEl = document.getElementById('result');

for (const sel of [fromEl, toEl])
  for (const [b, name] of BASES) {
    const o = document.createElement('option');
    o.value = b; o.textContent = name + ' (' + b + ')';
    sel.appendChild(o);
  }
fromEl.value = 16; toEl.value = 10;

function digitsValidFor(str, base) {
  const allowed = '0123456789abcdefghijklmnopqrstuvwxyz'.slice(0, base);
  return [...str.toLowerCase()].every(ch => allowed.includes(ch));
}

function convert() {
  const raw = valueEl.value.trim();
  const from = +fromEl.value, to = +toEl.value;
  resultEl.classList.remove('err');
  if (!raw || !digitsValidFor(raw, from)) {
    resultEl.textContent = 'Invalid digit for base ' + from;
    resultEl.classList.add('err');
    return;
  }
  const n = parseInt(raw, from);
  resultEl.textContent = raw + ' (base ' + from + ') = ' + n.toString(to).toUpperCase() + ' (base ' + to + ')';
}

for (const el of [valueEl, fromEl, toEl]) {
  el.addEventListener('input', convert);
  el.addEventListener('change', convert);
}
convert();
</script>
</body>
</html>`),
  },
  {
    id: "word-scramble",
    prompt: "Code a word-scramble puzzle as a single self-contained HTML file with a built-in word list. Show the scrambled letters of the current word in an element with id \"scrambled\" (never showing the letters in their original order), a text input with id \"guess\", a submit button with id \"submit\", the running score in an element with id \"score\", a hint button with id \"hint\" that reveals one more letter of the answer in an element with id \"hint-text\" (max 2 hints per word), and feedback text in an element with id \"message\". A correct guess advances to a new scrambled word. For automated testing, also set a data-answer attribute on the #scrambled element holding the current answer in lowercase. Reply with one complete HTML file in a ```html code block.",
    probes: "probe('elements exist',!!$('#scrambled')&&!!$('#guess')&&!!$('#submit')&&!!$('#score')&&!!$('#hint')&&!!$('#hint-text'));\nconst ans=($('#scrambled').dataset.answer||'').toLowerCase();probe('answer exposed',ans.length>=4);\nprobe('scrambled not original order',$('#scrambled').textContent.replace(/[^a-z]/gi,'').toLowerCase()!==ans);\nconst set=(v)=>{$('#guess').value=v;$('#guess').dispatchEvent(new Event('input',{bubbles:true}));};\nset('zzzzzzz');clickEl($('#submit'));await sleep(150);\nprobe('wrong guess feedback',/wrong|try again|incorrect|nope/i.test($('#message')?.textContent||''));\nconst s0=parseInt($('#score').textContent.match(/\\d+/)?.[0]||'0');\nset(ans);clickEl($('#submit'));await sleep(200);\nconst s1=parseInt($('#score').textContent.match(/\\d+/)?.[0]||'0');\nprobe('correct guess scores',s1>s0);\nclickEl($('#hint'));await sleep(120);\nprobe('hint reveals letter',($('#hint-text')?.textContent||'').replace(/[^a-z]/gi,'').length>=1);",
    exemplar: H(`
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Word Scramble</title>
<style>
  body { font-family: system-ui, sans-serif; background: #202634; color: #e8ecf3; display: flex; justify-content: center; padding-top: 70px; }
  #app { width: min(420px, 92vw); background: #262e40; border-radius: 14px; padding: 28px; text-align: center; }
  #scrambled { font-size: 2.2rem; letter-spacing: 8px; font-family: ui-monospace, monospace; margin-bottom: 20px; color: #ffd166; }
  #guess { width: 60%; padding: 10px; font-size: 1.05rem; border-radius: 8px; border: 1px solid #3a4358; background: #1b2130; color: #e8ecf3; text-align: center; }
  button { padding: 10px 18px; border: none; border-radius: 8px; cursor: pointer; font-size: .95rem; margin: 4px; }
  #submit { background: #3ddc97; font-weight: 600; }
  #hint { background: #3a4358; color: #e8ecf3; }
  #message { min-height: 1.6em; margin-top: 14px; }
  #hint-text { font-family: ui-monospace, monospace; letter-spacing: 4px; color: #9aa4b8; margin-top: 8px; min-height: 1.4em; }
  #score { color: #ffd166; font-weight: 600; }
</style>
</head>
<body>
<div id="app">
  <h1 style="margin-top:0;font-size:1.1rem">Word Scramble</h1>
  <div id="score">Score: 0</div>
  <div id="scrambled"></div>
  <div>
    <input id="guess" placeholder="your guess">
    <button id="submit">Submit</button>
  </div>
  <div id="message"></div>
  <button id="hint">Hint</button>
  <div id="hint-text"></div>
</div>
<script>
const WORDS = ['planet', 'guitar', 'bridge', 'forest', 'candle', 'window', 'garden', 'puzzle', 'jacket', 'copper'];
const scrambledEl = document.getElementById('scrambled');
const guessEl = document.getElementById('guess');
const messageEl = document.getElementById('message');
const hintTextEl = document.getElementById('hint-text');
const scoreEl = document.getElementById('score');
let answer = '', score = 0, hintsUsed = 0, used = [];

function scramble(word) {
  let letters;
  do {
    letters = [...word].sort(() => Math.random() - 0.5);
  } while (letters.join('') === word);
  return letters.join('');
}

function pickWord() {
  if (used.length === WORDS.length) used = [];
  let w;
  do { w = WORDS[Math.floor(Math.random() * WORDS.length)]; } while (used.includes(w));
  used.push(w);
  return w;
}

function newWord() {
  answer = pickWord();
  hintsUsed = 0;
  scrambledEl.textContent = scramble(answer).toUpperCase();
  scrambledEl.dataset.answer = answer;
  guessEl.value = '';
  messageEl.textContent = '';
  hintTextEl.textContent = '';
}

document.getElementById('submit').addEventListener('click', () => {
  const guess = guessEl.value.trim().toLowerCase();
  if (!guess) return;
  if (guess === answer) {
    score++; scoreEl.textContent = 'Score: ' + score;
    messageEl.textContent = '✔ Correct! It was "' + answer + '"';
    setTimeout(newWord, 900);
  } else {
    messageEl.textContent = '✘ Wrong, try again';
  }
});

document.getElementById('hint').addEventListener('click', () => {
  if (hintsUsed >= 2) { hintTextEl.textContent = 'No more hints'; return; }
  hintsUsed++;
  hintTextEl.textContent = answer.slice(0, hintsUsed).toUpperCase() + '_'.repeat(answer.length - hintsUsed);
});

guessEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') document.getElementById('submit').click(); });
newWord();
</script>
</body>
</html>`),
  },
  {
    id: "word-guess",
    prompt: "Code a Wordle-style 5-letter word guessing game as a single self-contained HTML file with a built-in word list. A grid of guess rows inside a container with id \"board\" (6 rows x 5 tile letters), an on-screen keyboard inside a container with id \"keyboard\" where each key button has a data-key attribute (letters plus \"enter\" and \"back\"), and a message area with id \"message\" for win/lose feedback. Typing (physical keys or on-screen clicks) fills the current row; Enter submits a complete guess and colors each tile green (correct spot), yellow (in word, wrong spot) or gray (absent), matching standard Wordle rules including duplicate letters; matched keyboard keys should also recolor. For automated testing, set a data-answer attribute on #board holding the answer word in lowercase. Reply with one complete HTML file in a ```html code block.",
    probes: "const board=$('#board'),kb=$('#keyboard');probe('elements exist',!!board&&!!kb&&!!$('#message'));\nconst ans=(board.dataset.answer||'').toLowerCase();probe('answer 5 letters',ans.length===5);\nconst pressKey=(k)=>{const b=kb.querySelector('[data-key='+k+']');if(b){clickEl(b);return true;}return false;};\nlet ok=true;for(const ch of ans) ok=pressKey(ch)&&ok;\nok=pressKey('enter')&&ok;\nawait sleep(250);\nprobe('all keys found and pressed',ok);\nprobe('win message shown',/win|correct|congrat|solved/i.test($('#message').textContent));\nconst tiles=Array.from(board.querySelectorAll('.tile')).slice(0,5);\nprobe('first row all correct',tiles.length===5&&tiles.every(t=>t.classList.contains('correct')));",
    exemplar: H(`
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Word Guess</title>
<style>
  body { font-family: system-ui, sans-serif; background: #121213; color: #fff; display: flex; flex-direction: column; align-items: center; padding-top: 24px; }
  #board { display: grid; grid-template-rows: repeat(6, 56px); gap: 6px; margin-bottom: 24px; }
  .row { display: grid; grid-template-columns: repeat(5, 56px); gap: 6px; }
  .tile { border: 2px solid #3a3a3c; display: flex; align-items: center; justify-content: center; font-size: 1.8rem; font-weight: 700; text-transform: uppercase; }
  .tile.correct { background: #538d4e; border-color: #538d4e; }
  .tile.present { background: #b59f3b; border-color: #b59f3b; }
  .tile.absent { background: #3a3a3c; border-color: #3a3a3c; }
  #message { min-height: 1.6em; margin-bottom: 14px; font-size: 1.1rem; }
  #keyboard { display: flex; flex-direction: column; gap: 6px; }
  .krow { display: flex; gap: 4px; justify-content: center; }
  #keyboard button { padding: 12px 10px; min-width: 32px; background: #818384; color: #fff; border: none; border-radius: 4px; cursor: pointer; text-transform: uppercase; font-size: .8rem; font-weight: 600; }
  #keyboard button.correct { background: #538d4e; }
  #keyboard button.present { background: #b59f3b; }
  #keyboard button.absent { background: #3a3a3c; }
  #keyboard button.wide { min-width: 54px; font-size: .65rem; }
</style>
</head>
<body>
<h1 style="font-size:1.3rem">Word Guess</h1>
<div id="message"></div>
<div id="board"></div>
<div id="keyboard"></div>
<script>
const WORDS = ['plant', 'crane', 'store', 'light', 'brave', 'quiet', 'money', 'stone', 'grape', 'chess'];
const board = document.getElementById('board');
const messageEl = document.getElementById('message');
const kb = document.getElementById('keyboard');
const ROWS = 6, LEN = 5;
let answer, row, col, tiles, over;

function newGame() {
  answer = WORDS[Math.floor(Math.random() * WORDS.length)];
  board.dataset.answer = answer;
  board.innerHTML = ''; tiles = [];
  row = 0; col = 0; over = false; messageEl.textContent = '';
  for (let r = 0; r < ROWS; r++) {
    const rowEl = document.createElement('div');
    rowEl.className = 'row';
    const rowTiles = [];
    for (let c = 0; c < LEN; c++) {
      const t = document.createElement('div');
      t.className = 'tile';
      rowEl.appendChild(t);
      rowTiles.push(t);
    }
    board.appendChild(rowEl);
    tiles.push(rowTiles);
  }
  kb.querySelectorAll('button').forEach(b => b.classList.remove('correct', 'present', 'absent'));
}

function buildKeyboard() {
  const rows = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'];
  rows.forEach((letters, i) => {
    const krow = document.createElement('div');
    krow.className = 'krow';
    if (i === 2) krow.appendChild(makeKey('enter', 'Enter', true));
    for (const ch of letters) krow.appendChild(makeKey(ch, ch));
    if (i === 2) krow.appendChild(makeKey('back', '⌫', true));
    kb.appendChild(krow);
  });
}
function makeKey(key, label, wide) {
  const b = document.createElement('button');
  b.dataset.key = key; b.textContent = label;
  if (wide) b.classList.add('wide');
  b.addEventListener('click', () => handleKey(key));
  return b;
}

function handleKey(key) {
  if (over) return;
  if (key === 'back') { if (col > 0) { col--; tiles[row][col].textContent = ''; } return; }
  if (key === 'enter') { submitRow(); return; }
  if (col < LEN) { tiles[row][col].textContent = key; col++; }
}
document.addEventListener('keydown', (e) => {
  if (/^[a-z]$/i.test(e.key)) handleKey(e.key.toLowerCase());
  else if (e.key === 'Enter') handleKey('enter');
  else if (e.key === 'Backspace') handleKey('back');
});

function submitRow() {
  if (col < LEN) { messageEl.textContent = 'Not enough letters'; return; }
  const guess = tiles[row].map(t => t.textContent.toLowerCase());
  const result = Array(LEN).fill('absent');
  const pool = answer.split('');
  for (let i = 0; i < LEN; i++) if (guess[i] === answer[i]) { result[i] = 'correct'; pool[i] = null; }
  for (let i = 0; i < LEN; i++) {
    if (result[i] === 'correct') continue;
    const idx = pool.indexOf(guess[i]);
    if (idx !== -1) { result[i] = 'present'; pool[idx] = null; }
  }
  const rank = { correct: 3, present: 2, absent: 1 };
  for (let i = 0; i < LEN; i++) {
    tiles[row][i].classList.add(result[i]);
    const key = kb.querySelector('[data-key=' + guess[i] + ']');
    if (key) {
      const cur = ['correct','present','absent'].find(c => key.classList.contains(c));
      if (!cur || rank[result[i]] > rank[cur]) {
        key.classList.remove('correct', 'present', 'absent');
        key.classList.add(result[i]);
      }
    }
  }
  if (guess.join('') === answer) {
    messageEl.textContent = '🎉 Correct! You solved it.';
    over = true;
    return;
  }
  row++; col = 0;
  if (row === ROWS) { messageEl.textContent = 'Out of guesses — it was "' + answer.toUpperCase() + '"'; over = true; }
}

buildKeyboard();
newGame();
</script>
</body>
</html>`),
  },
  {
    id: "rhythm-tap",
    prompt: "Code a rhythm timing game as a single self-contained HTML file. A horizontal track with id \"track\" containing a fixed target zone with id \"target-zone\" in the middle and a marker with id \"marker\" that continuously sweeps back and forth across the track once started; a start button with id \"start\"; a tap button with id \"tap\" (also bindable to Space) that the player presses when the marker overlaps the target zone; each tap shows \"Perfect\"/\"Good\"/\"Miss\" in an element with id \"feedback\" based on how close the marker was to the zone's center, and a running score in an element with id \"score\" (Perfect worth more than Good). Reply with one complete HTML file in a ```html code block.",
    probes: "probe('elements exist',!!$('#track')&&!!$('#marker')&&!!$('#target-zone')&&!!$('#tap')&&!!$('#score')&&!!$('#feedback')&&!!$('#start'));\nclickEl($('#start'));await sleep(250);\nconst p1=$('#marker').style.left;await sleep(250);const p2=$('#marker').style.left;\nprobe('marker sweeps',p1!==p2);\nclickEl($('#tap'));await sleep(120);\nprobe('feedback shown',/perfect|good|miss/i.test($('#feedback').textContent));\nprobe('score numeric',/\\d/.test($('#score').textContent));",
    exemplar: H(`
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Rhythm Tap</title>
<style>
  body { font-family: system-ui, sans-serif; background: #1b1033; color: #f0e9ff; display: flex; flex-direction: column; align-items: center; padding-top: 60px; }
  #track { position: relative; width: 420px; height: 60px; background: #2a1b4d; border-radius: 12px; margin-bottom: 20px; overflow: hidden; }
  #target-zone { position: absolute; top: 0; bottom: 0; left: 44%; width: 12%; background: rgba(125,216,125,.35); border-left: 2px solid #7dd87d; border-right: 2px solid #7dd87d; }
  #marker { position: absolute; top: 4px; bottom: 4px; width: 8px; background: #ff6ac1; border-radius: 4px; left: 0; }
  #feedback { font-size: 1.3rem; min-height: 1.6em; margin-bottom: 10px; }
  #score { font-size: 1.1rem; color: #ffd166; margin-bottom: 18px; }
  button { padding: 10px 26px; margin: 0 8px; border: none; border-radius: 8px; cursor: pointer; font-size: 1rem; }
  #start { background: #7c5cff; color: #fff; }
  #tap { background: #ff6ac1; color: #1b1033; font-weight: 700; }
</style>
</head>
<body>
<h1>Rhythm Tap</h1>
<div id="track">
  <div id="target-zone"></div>
  <div id="marker"></div>
</div>
<div id="feedback">Press Start</div>
<div id="score">Score: 0</div>
<div>
  <button id="start">Start</button>
  <button id="tap">Tap</button>
</div>
<script>
const track = document.getElementById('track');
const marker = document.getElementById('marker');
const feedbackEl = document.getElementById('feedback');
const scoreEl = document.getElementById('score');
let running = false, raf = null, score = 0, t0 = 0;
const TRACK_W = 420, MARKER_W = 8, PERIOD = 1400; // ms for a full there-and-back sweep
const CENTER = 50; // percent

function positionPercent(now) {
  const phase = ((now - t0) % PERIOD) / PERIOD;      // 0..1
  const tri = phase < 0.5 ? phase * 2 : 2 - phase * 2; // 0..1..0 triangle wave
  return tri * 100;
}

function loop(now) {
  if (!running) return;
  const pct = positionPercent(now);
  const px = (pct / 100) * (TRACK_W - MARKER_W);
  marker.style.left = px.toFixed(1) + 'px';
  raf = requestAnimationFrame(loop);
}

document.getElementById('start').addEventListener('click', () => {
  running = true; t0 = performance.now();
  feedbackEl.textContent = 'Go!';
  raf = requestAnimationFrame(loop);
});

function tap() {
  if (!running) return;
  const now = performance.now();
  const pct = positionPercent(now);
  const dist = Math.abs(pct - CENTER);
  let gained = 0, label;
  if (dist <= 4) { label = 'Perfect'; gained = 100; }
  else if (dist <= 12) { label = 'Good'; gained = 50; }
  else { label = 'Miss'; gained = 0; }
  score += gained;
  feedbackEl.textContent = label;
  scoreEl.textContent = 'Score: ' + score;
}
document.getElementById('tap').addEventListener('click', tap);
document.addEventListener('keydown', (e) => { if (e.key === ' ') { e.preventDefault(); tap(); } });
</script>
</body>
</html>`),
  },
  {
    id: "spirograph",
    prompt: "Code a spirograph curve drawer as a single self-contained HTML file. A canvas with id \"canvas\", three range sliders with ids \"big-r\" (fixed ring radius), \"small-r\" (rolling circle radius) and \"pen-offset\" (pen distance from the rolling circle's center), a draw button with id \"draw\" that plots the resulting hypotrochoid curve, and a clear button with id \"clear\". Reply with one complete HTML file in a ```html code block.",
    probes: "const cv=$('#canvas');probe('canvas exists',!!cv);probe('sliders exist',!!$('#big-r')&&!!$('#small-r')&&!!$('#pen-offset'));probe('buttons exist',!!$('#draw')&&!!$('#clear'));\nconst blank=canvasData('#canvas');\nclickEl($('#draw'));await sleep(200);const drawn1=canvasData('#canvas');probe('draw renders curve',drawn1!==blank);\nconst sr=$('#small-r');sr.value=String(Math.min(+sr.max,+sr.value+7));sr.dispatchEvent(new Event('input',{bubbles:true}));\nclickEl($('#draw'));await sleep(200);const drawn2=canvasData('#canvas');probe('param change redraws differently',drawn2!==drawn1);\nclickEl($('#clear'));await sleep(150);const cleared=canvasData('#canvas');probe('clear resets canvas',cleared!==drawn2);",
    exemplar: H(`
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Spirograph</title>
<style>
  body { font-family: system-ui, sans-serif; background: #10121a; color: #e6e9f2; display: flex; flex-direction: column; align-items: center; padding-top: 26px; }
  canvas { background: #191c28; border-radius: 10px; }
  #controls { display: flex; gap: 22px; margin: 18px 0; flex-wrap: wrap; justify-content: center; }
  .ctrl { display: flex; flex-direction: column; align-items: center; font-size: .85rem; color: #9aa4c0; }
  button { padding: 9px 22px; margin: 0 6px; border: none; border-radius: 8px; cursor: pointer; font-size: .95rem; background: #6c5ce7; color: #fff; }
  #clear { background: #3a3f52; }
</style>
</head>
<body>
<h1 style="font-size:1.2rem">Spirograph</h1>
<canvas id="canvas" width="440" height="440"></canvas>
<div id="controls">
  <div class="ctrl">Big R<input id="big-r" type="range" min="80" max="200" value="150"></div>
  <div class="ctrl">Small r<input id="small-r" type="range" min="10" max="100" value="45"></div>
  <div class="ctrl">Pen offset<input id="pen-offset" type="range" min="5" max="120" value="70"></div>
</div>
<div>
  <button id="draw">Draw</button>
  <button id="clear">Clear</button>
</div>
<script>
const cv = document.getElementById('canvas');
const cx = cv.getContext('2d');
const C = 220;

function gcd(a, b) { return b === 0 ? a : gcd(b, a % b); }

function draw() {
  const R = +document.getElementById('big-r').value;
  const r = +document.getElementById('small-r').value;
  const d = +document.getElementById('pen-offset').value;
  const g = gcd(R, r) || 1;
  const steps = Math.round((2 * Math.PI * (r / g)) / 0.02);
  cx.clearRect(0, 0, cv.width, cv.height);
  cx.strokeStyle = '#ff6ac1';
  cx.lineWidth = 1.5;
  cx.beginPath();
  for (let i = 0; i <= steps; i++) {
    const t = i * 0.02;
    const x = (R - r) * Math.cos(t) + d * Math.cos((R - r) / r * t);
    const y = (R - r) * Math.sin(t) - d * Math.sin((R - r) / r * t);
    const px = C + x, py = C + y;
    i ? cx.lineTo(px, py) : cx.moveTo(px, py);
  }
  cx.stroke();
}

document.getElementById('draw').addEventListener('click', draw);
document.getElementById('clear').addEventListener('click', () => cx.clearRect(0, 0, cv.width, cv.height));
</script>
</body>
</html>`),
  },
  {
    id: "asteroids-lite",
    prompt: "Code a simplified Asteroids-style game as a single self-contained HTML file. A full canvas showing a triangular ship at the center that rotates with ArrowLeft/ArrowRight, thrusts forward with ArrowUp, and shoots bullets with Space; several asteroids (irregular polygons or circles) drift continuously across the screen, wrapping at the edges, and split into two smaller asteroids (or are destroyed if already small) when hit by a bullet; score in an element with id \"score\" increases per asteroid destroyed; lives in an element with id \"lives\" start at 3 and decrease (with brief invulnerability) when the ship collides with an asteroid; the ship also wraps at screen edges. Reply with one complete HTML file in a ```html code block.",
    probes: "const cv=$('canvas');probe('canvas exists',!!cv);probe('score exists',!!$('#score')&&/\\d/.test($('#score').textContent));probe('lives exists',!!$('#lives')&&/\\d/.test($('#lives').textContent));\nconst f1=canvasData();await sleep(500);const f2=canvasData();probe('asteroids drift automatically',!!f1&&!!f2&&f1!==f2);\npress('ArrowLeft');await sleep(150);const f3=canvasData();probe('rotation input handled',!!f3&&f3!==f2);\npress(' ');await sleep(200);const f4=canvasData();probe('shooting input handled',!!f4&&f4!==f3);",
    exemplar: H(`
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Asteroids Lite</title>
<style>
  body { margin: 0; background: #05060a; overflow: hidden; font-family: system-ui, sans-serif; color: #d8e0f0; }
  #hud { position: fixed; top: 14px; left: 18px; font-size: 1.1rem; display: flex; gap: 24px; }
  canvas { display: block; }
</style>
</head>
<body>
<div id="hud"><div>Score: <span id="score">0</span></div><div>Lives: <span id="lives">3</span></div></div>
<canvas id="game"></canvas>
<script>
const cv = document.getElementById('game');
const cx = cv.getContext('2d');
const scoreEl = document.getElementById('score');
const livesEl = document.getElementById('lives');
let W, Hh;
function resize() { W = cv.width = window.innerWidth; Hh = cv.height = window.innerHeight; }
window.addEventListener('resize', resize);
resize();

const keys = {};
window.addEventListener('keydown', (e) => { keys[e.key] = true; if (e.key === ' ') { e.preventDefault(); shoot(); } });
window.addEventListener('keyup', (e) => { keys[e.key] = false; });

let ship, bullets, asteroids, score, lives, invuln;

function wrap(o) {
  if (o.x < 0) o.x += W; if (o.x > W) o.x -= W;
  if (o.y < 0) o.y += Hh; if (o.y > Hh) o.y -= Hh;
}

function newAsteroid(x, y, size) {
  return {
    x: x ?? Math.random() * W, y: y ?? Math.random() * Hh,
    vx: (Math.random() - 0.5) * 1.6, vy: (Math.random() - 0.5) * 1.6,
    size: size || 34 + Math.random() * 20, angle: Math.random() * Math.PI * 2,
  };
}

function reset() {
  ship = { x: W / 2, y: Hh / 2, angle: -Math.PI / 2, vx: 0, vy: 0 };
  bullets = [];
  asteroids = Array.from({ length: 6 }, () => newAsteroid());
  score = 0; lives = 3; invuln = 0;
  scoreEl.textContent = score; livesEl.textContent = lives;
}

function shoot() {
  bullets.push({
    x: ship.x + Math.cos(ship.angle) * 16, y: ship.y + Math.sin(ship.angle) * 16,
    vx: Math.cos(ship.angle) * 7 + ship.vx, vy: Math.sin(ship.angle) * 7 + ship.vy, life: 60,
  });
}

function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

function step() {
  if (keys.ArrowLeft) ship.angle -= 0.06;
  if (keys.ArrowRight) ship.angle += 0.06;
  if (keys.ArrowUp) { ship.vx += Math.cos(ship.angle) * 0.12; ship.vy += Math.sin(ship.angle) * 0.12; }
  ship.vx *= 0.99; ship.vy *= 0.99;
  ship.x += ship.vx; ship.y += ship.vy;
  wrap(ship);
  if (invuln > 0) invuln--;

  for (const b of bullets) { b.x += b.vx; b.y += b.vy; b.life--; wrap(b); }
  bullets = bullets.filter(b => b.life > 0);

  for (const a of asteroids) { a.x += a.vx; a.y += a.vy; a.angle += 0.01; wrap(a); }

  for (let i = bullets.length - 1; i >= 0; i--) {
    for (let j = asteroids.length - 1; j >= 0; j--) {
      if (dist(bullets[i], asteroids[j]) < asteroids[j].size) {
        const a = asteroids[j];
        score += 10; scoreEl.textContent = score;
        asteroids.splice(j, 1);
        bullets.splice(i, 1);
        if (a.size > 20) {
          asteroids.push(newAsteroid(a.x, a.y, a.size / 2));
          asteroids.push(newAsteroid(a.x, a.y, a.size / 2));
        }
        if (asteroids.length === 0) asteroids = Array.from({ length: 6 }, () => newAsteroid());
        break;
      }
    }
  }

  if (invuln === 0) {
    for (const a of asteroids) {
      if (dist(ship, a) < a.size * 0.7) {
        lives--; livesEl.textContent = Math.max(0, lives); invuln = 90;
        ship.x = W / 2; ship.y = Hh / 2; ship.vx = 0; ship.vy = 0;
        if (lives <= 0) reset();
        break;
      }
    }
  }
}

function draw() {
  cx.fillStyle = '#05060a';
  cx.fillRect(0, 0, W, Hh);

  cx.strokeStyle = '#8fa3c8';
  cx.lineWidth = 1.5;
  for (const a of asteroids) {
    cx.beginPath();
    for (let i = 0; i <= 8; i++) {
      const ang = a.angle + (i / 8) * Math.PI * 2;
      const r = a.size * (0.85 + 0.15 * Math.sin(i * 2.1));
      const px = a.x + Math.cos(ang) * r, py = a.y + Math.sin(ang) * r;
      i ? cx.lineTo(px, py) : cx.moveTo(px, py);
    }
    cx.closePath(); cx.stroke();
  }

  cx.fillStyle = '#ffe066';
  for (const b of bullets) cx.fillRect(b.x - 1.5, b.y - 1.5, 3, 3);

  cx.save();
  cx.translate(ship.x, ship.y);
  cx.rotate(ship.angle);
  cx.strokeStyle = invuln > 0 && invuln % 10 < 5 ? '#555' : '#e8ecf7';
  cx.lineWidth = 2;
  cx.beginPath();
  cx.moveTo(14, 0); cx.lineTo(-10, 9); cx.lineTo(-6, 0); cx.lineTo(-10, -9);
  cx.closePath(); cx.stroke();
  cx.restore();
}

function frame() { step(); draw(); requestAnimationFrame(frame); }
reset();
frame();
</script>
</body>
</html>`),
  },
];
