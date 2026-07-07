# Webgen prompts for frontier models (ChatGPT / Gemini)

Paste each prompt into a fresh chat. Save the model's FULL reply (with the ```html fence)
as a file under `data/webgen_external/<task-id>/` — e.g. `data/webgen_external/kanban/gpt.md`.
One folder per task id, any number of reply files per folder (name them by model).
Then run:  cd web && npx tsx scripts/gen_webgen_data.ts external
Every reply is graded in headless Chrome; only passing ones become training rows.

---

## tic-tac-toe

Code a two-player tic-tac-toe game as a single self-contained HTML file. A 3x3 grid inside a container with id "board", a status line with id "status" saying whose turn it is (X starts) and announcing the winner or a draw, and a restart button with id "restart". Winning cells should be visually highlighted. Reply with one complete HTML file in a ```html code block.

---

## rock-paper-scissors

Code a rock-paper-scissors game against the computer as a single self-contained HTML file. Three buttons with ids "rock", "paper", "scissors"; after each round show both choices and the outcome in an element with id "result", and keep running totals in elements with ids "player-score" and "cpu-score". Reply with one complete HTML file in a ```html code block.

---

## hangman

Code a hangman word-guessing game as a single self-contained HTML file. A hidden word from a built-in list shown as blanks in an element with id "word", an on-screen A-Z letter keyboard inside a container with id "letters" (used letters get disabled), remaining lives in an element with id "lives" (start with 6), and a new-game button with id "new-game". Show a win/lose message in an element with id "message". Reply with one complete HTML file in a ```html code block.

---

## quiz

Code a multiple-choice quiz app as a single self-contained HTML file with at least 4 built-in questions. Show one question at a time in an element with id "question", its answer choices as buttons inside a container with id "choices", progress like "2 / 4" in an element with id "progress", and after the last question show the final score in an element with id "score" plus a restart button with id "restart". Picking an answer should briefly show right/wrong before advancing. Reply with one complete HTML file in a ```html code block.

---

## stopwatch

Code a stopwatch as a single self-contained HTML file. Elapsed time shown as MM:SS.cc (centiseconds) in an element with id "display", buttons with ids "start", "stop", "lap" and "reset", and recorded laps appended to a list with id "laps". Start must be idempotent (clicking twice doesn't double the speed). Reply with one complete HTML file in a ```html code block.

---

## dice-roller

Code a dice roller as a single self-contained HTML file. A number input with id "count" (1-6 dice, default 2), a roll button with id "roll", the dice rendered as large unicode/emoji faces inside a container with id "dice", and the sum shown in an element with id "total". Each roll should re-randomize all dice. Reply with one complete HTML file in a ```html code block.

---

## reaction-time

Code a reaction-time tester as a single self-contained HTML file. A large clickable panel with id "panel" that starts gray with the text "Click to start"; after a click it turns red saying "Wait for green…" for a random 1-4s delay, then turns green saying "CLICK!". Clicking on green shows the reaction time in ms in an element with id "result" and the best time so far in an element with id "best". Clicking too early on red shows "Too soon!" and resets. Reply with one complete HTML file in a ```html code block.

---

## color-guesser

Code an RGB color-guessing game as a single self-contained HTML file. Show a target color as text like "rgb(120, 45, 200)" in an element with id "target", six colored swatch buttons inside a container with id "swatches" (one matches the target), a streak counter in an element with id "streak", and feedback in an element with id "feedback". A correct pick starts a new round and increments the streak; a wrong pick just removes that swatch and resets the streak. Reply with one complete HTML file in a ```html code block.

---

## analog-clock

Code a live analog clock as a single self-contained HTML file. A canvas with id "clock" drawing a round face with 12 hour ticks, hour/minute/second hands updating smoothly in real time, and the digital time as HH:MM:SS in an element with id "digital". Reply with one complete HTML file in a ```html code block.

---

## game-of-life

Code Conway's Game of Life as a single self-contained HTML file. A canvas with id "grid" showing a 40x30 cell world, buttons with ids "play" (toggles run/pause), "step", "random" and "clear", and the generation count in an element with id "gen". Clicking a cell on the canvas toggles it while paused. Wrap edges (toroidal). Reply with one complete HTML file in a ```html code block.

---

## starfield

Code a starfield fly-through animation as a single self-contained HTML file. A full-window black canvas with hundreds of stars streaming outward from the center (classic warp effect, stars accelerate as they approach the edge and respawn in the middle), plus a speed slider input with id "speed". Reply with one complete HTML file in a ```html code block.

---

## fireworks

Code a fireworks display as a single self-contained HTML file. A full-window night-sky canvas; clicking anywhere launches a rocket from the bottom that ascends to the click height and explodes into dozens of colorful sparks that fall with gravity and fade. Several random fireworks should also launch by themselves every couple of seconds. Reply with one complete HTML file in a ```html code block.

---

## expense-tracker

Code an expense tracker as a single self-contained HTML file. A description input with id "desc", an amount number input with id "amount", an add button with id "add", entries listed inside an element with id "entries" each with its own delete button, and the running total formatted to two decimals in an element with id "total". Persist entries in localStorage. Adding with an empty description or non-positive amount must be rejected. Reply with one complete HTML file in a ```html code block.

---

## notes-app

Code a sticky-notes board as a single self-contained HTML file. A new-note button with id "new-note" adds an editable note card to a board container with id "board"; each note is a textarea with a delete button, gets a random pastel background, and all note texts persist in localStorage (restored on reload, saved as you type). Show the note count in an element with id "count". Reply with one complete HTML file in a ```html code block.

---

## unit-converter

Code a length unit converter as a single self-contained HTML file. A number input with id "value", two selects with ids "from" and "to" offering at least meters, kilometers, miles, feet and inches, and the live-updating result to four significant digits in an element with id "result". Add a swap button with id "swap" that exchanges the two units. Conversions must go through a common base so every pair works. Reply with one complete HTML file in a ```html code block.

---

## simon-says

Code a Simon-says memory game as a single self-contained HTML file. Four large colored pads (green, red, yellow, blue) inside a container with id "pads", a start button with id "start", and the current level in an element with id "level". Each round the game flashes a growing random sequence; the player must click it back in order. A wrong click shows "Game over" in an element with id "message" and re-enables start. Pads must flash visibly when played back. Reply with one complete HTML file in a ```html code block.

---

## flappy-bird-style

Code a one-button flying game (flappy-bird style, original art) as a single self-contained HTML file. A canvas where a small square 'bird' falls with gravity and jumps on click or Space; vertical pipe pairs with a gap scroll from the right; passing a pipe increments the score in an element with id "score"; hitting a pipe or the ground shows game-over and a click restarts. Start paused with a "click to start" hint drawn on the canvas. Reply with one complete HTML file in a ```html code block.

---

## 2048-lite

Code a 2048-style sliding tile game as a single self-contained HTML file. A 4x4 grid inside a container with id "board" (16 cells always rendered), arrow keys slide and merge equal tiles (standard 2048 rules: each tile merges at most once per move), a new tile (2 or 4) appears after every effective move, the score accumulates merged values in an element with id "score", and a new-game button with id "new-game". Color tiles by value. Reply with one complete HTML file in a ```html code block.

---

## typing-test

Code a typing speed test as a single self-contained HTML file. Show a sample sentence in an element with id "sample" with per-character highlighting (correct letters green, mistakes red) as the user types into a textarea with id "input". Timing starts at the first keystroke; when the sentence is complete show words-per-minute in an element with id "wpm" and accuracy percentage in an element with id "accuracy", plus a next-sentence button with id "next". Reply with one complete HTML file in a ```html code block.

---

## pomodoro

Code a pomodoro timer as a single self-contained HTML file. A 25-minute work phase and 5-minute break phase alternate automatically; show remaining MM:SS in an element with id "time", the current phase name in an element with id "phase" (with clearly different styling per phase), completed pomodoro count in an element with id "count", and buttons with ids "start-pause" (toggles, label changes) and "reset". A visual progress bar with id "bar" should fill as the phase advances. Reply with one complete HTML file in a ```html code block.

---

## kanban

Code a mini kanban board as a single self-contained HTML file. Three columns titled "To do", "Doing" and "Done" with ids "col-todo", "col-doing", "col-done"; a text input with id "new-task" plus an add button with id "add" that creates a card in To do. Each card has ◀/▶ buttons to move between adjacent columns (hidden or disabled at the ends) and a delete button. Persist the whole board in localStorage. Reply with one complete HTML file in a ```html code block.

---

## password-generator

Code a password generator as a single self-contained HTML file. A length slider with id "length" (8-64, live value shown in an element with id "length-value"), checkboxes with ids "upper", "digits", "symbols" (lowercase always on), a generate button with id "generate", the password in an element with id "password", and a copy button with id "copy" that confirms with a brief "Copied!" message. Guarantee at least one character from every enabled class. Reply with one complete HTML file in a ```html code block.

---

## weather-dashboard

Code a weather dashboard as a single self-contained HTML file using built-in demo data (no network requests). A city select with id "city" offering at least 5 cities; show the selected city's current temperature in an element with id "temp", condition text in an element with id "condition", a matching weather emoji in an element with id "icon", and a 5-day forecast as cards inside a container with id "forecast" (day name, emoji, high/low). A toggle button with id "unit" switches every temperature between °C and °F. Reply with one complete HTML file in a ```html code block.

---

## maze

Code a maze generator and solver as a single self-contained HTML file. A canvas with id "maze" showing a perfect maze at least 15x15 cells (generated with a random algorithm like recursive backtracking, entrance top-left, exit bottom-right), a regenerate button with id "generate", and a solve button with id "solve" that draws the solution path in a contrasting color. Reply with one complete HTML file in a ```html code block.

---

## metronome

Code a visual metronome as a single self-contained HTML file (no audio needed). A BPM slider with id "bpm" (40-220) whose current value shows live in an element with id "bpm-value", a start/stop button with id "toggle" whose label switches, a large circle with id "beat" that pulses visibly on every beat, and a beat counter cycling 1-4 in an element with id "count" with beat 1 visually accented. Changing BPM while running must take effect immediately. Reply with one complete HTML file in a ```html code block.

---

## fifteen-puzzle

Code a 15-puzzle (sliding number puzzle) as a single self-contained HTML file. A 4x4 grid inside a container with id "board" holding tiles numbered 1-15 plus one empty slot; clicking a tile adjacent to the empty slot slides it there; count moves in an element with id "moves"; a shuffle button with id "shuffle" scrambles with a series of random valid moves (always solvable); when tiles return to order show a win message in an element with id "message". Reply with one complete HTML file in a ```html code block.

---

## markdown-preview

Code a live markdown previewer as a single self-contained HTML file (no external libraries — implement a small subset yourself). A textarea with id "input" on the left and the rendered preview in an element with id "preview" on the right, updating as you type. Support # / ## / ### headings, **bold**, *italic*, `inline code`, - bullet lists and [links](url). Preload the textarea with a short demo document showing all features. Reply with one complete HTML file in a ```html code block.
