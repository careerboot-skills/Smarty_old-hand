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
  username: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  role: { type: String, enum: ['admin', 'player'], default: 'player' },
  balance: { type: Number, default: 1000 },
  totalWon: { type: Number, default: 0 },
  totalLost: { type: Number, default: 0 },
  totalBetPlaced: { type: Number, default: 0 }
});
const User = mongoose.model('User', userSchema);

const historySchema = new mongoose.Schema({
  game: String,
  multiplier: Number,
  timestamp: { type: Date, default: Date.now }
});
const GameHistory = mongoose.model('GameHistory', historySchema);

// ==========================================
// PROBABILITY ENGINES
// ==========================================
function getAviatorMultiplier() {
  const rand = Math.random() * 100;
  if (rand < 35) return +(1.00 + Math.random() * 0.04).toFixed(2);
  if (rand < 55) return +(1.05 + Math.random() * 0.40).toFixed(2);
  if (rand < 80) return +(1.46 + Math.random() * 0.99).toFixed(2);
  if (rand < 90) return +(2.46 + Math.random() * 1.99).toFixed(2);
  if (rand < 95) return +(4.46 + Math.random() * 17.57).toFixed(2);
  if (rand < 98) return +(22.04 + Math.random() * 19.11).toFixed(2);
  return +(41.16 + Math.random() * 73.97).toFixed(2);
}

function getGenericRewardMultiplier() {
  const rand = Math.random() * 100;
  if (rand < 30) return 1;
  if (rand < 55) return 2;
  if (rand < 65) return 3;
  if (rand < 80) return 4;
  if (rand < 85) return 5;
  if (rand < 89) return 6;
  if (rand < 92) return 7;
  if (rand < 97) return 8;
  if (rand < 99) return 9;
  return 10;
}

// ==========================================
// 24x7 AVIATOR ENGINE (WebSocket)
// ==========================================
let aviatorState = { status: 'WAITING', currentX: 1.00, crashX: 1.00, history: [] };

function broadcast(data) {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(data));
  });
}

async function startAviatorLoop() {
  try {
    const docs = await GameHistory.find({ game: 'aviator' }).sort({ timestamp: -1 }).limit(20);
    aviatorState.history = docs.map(d => d.multiplier);
  } catch (err) {}

  while (true) {
    aviatorState.status = 'WAITING';
    aviatorState.currentX = 1.00;
    aviatorState.crashX = getAviatorMultiplier();
    broadcast({ type: 'AVIATOR_STATE', ...aviatorState });

    await new Promise(r => setTimeout(r, 5000));

    aviatorState.status = 'FLYING';
    let startTime = Date.now();

    await new Promise(resolve => {
      const interval = setInterval(async () => {
        let elapsed = (Date.now() - startTime) / 1000;
        aviatorState.currentX = +(Math.pow(1.06, elapsed * 2.2)).toFixed(2);

        if (aviatorState.currentX >= aviatorState.crashX) {
          aviatorState.currentX = aviatorState.crashX;
          aviatorState.status = 'CRASHED';
          clearInterval(interval);

          try { await GameHistory.create({ game: 'aviator', multiplier: aviatorState.crashX }); } catch (e) {}

          aviatorState.history.unshift(aviatorState.crashX);
          if (aviatorState.history.length > 20) aviatorState.history.pop();

          broadcast({ type: 'AVIATOR_STATE', ...aviatorState });
          setTimeout(resolve, 2000);
        } else {
          broadcast({ type: 'AVIATOR_STATE', ...aviatorState });
        }
      }, 100);
    });
  }
}

// ==========================================
// HTTP APIs & AUTH
// ==========================================
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  const user = await User.findOne({ username });
  if (!user || !(await bcrypt.compare(password, user.password))) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  res.json({ username: user.username, role: user.role, balance: user.balance });
});

app.post('/api/change-password', async (req, res) => {
  const { username, oldPassword, newPassword } = req.body;
  const user = await User.findOne({ username });
  if (!user || !(await bcrypt.compare(oldPassword, user.password))) {
    return res.status(400).json({ error: 'Old Password Incorrect!' });
  }
  user.password = await bcrypt.hash(newPassword, 10);
  await user.save();
  res.json({ success: true, message: 'Password Updated Successfully!' });
});

app.post('/api/admin/create-user', async (req, res) => {
  const { username, password } = req.body;
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const user = await User.create({ username, password: hashedPassword });
    res.json(user);
  } catch (err) {
    res.status(400).json({ error: 'Username already exists' });
  }
});

app.get('/api/admin/users', async (req, res) => {
  const users = await User.find({ role: 'player' });
  res.json(users);
});

app.post('/api/admin/update-balance', async (req, res) => {
  const { username, amount } = req.body;
  const user = await User.findOneAndUpdate(
    { username },
    { $inc: { balance: amount } },
    { new: true }
  );
  if (user) return res.json({ success: true, newBalance: user.balance });
  res.status(404).json({ error: 'User not found' });
});

// Atomic Instant Bet Endpoint
app.post('/api/play-instant', async (req, res) => {
  const { username, game, betAmount, choice } = req.body;
  const numBet = parseFloat(betAmount);
  if (!numBet || numBet <= 0) return res.status(400).json({ error: 'Invalid Bet Amount' });

  const updatedUser = await User.findOneAndUpdate(
    { username, balance: { $gte: numBet } },
    { $inc: { balance: -numBet, totalBetPlaced: numBet } },
    { new: true }
  );

  if (!updatedUser) return res.status(400).json({ error: 'Insufficient Balance' });

  let won = false;
  let rewardMultiplier = 0;
  let resultMeta = {};

  if (game === 'dice') {
    const d1 = Math.floor(Math.random() * 6) + 1;
    const d2 = Math.floor(Math.random() * 6) + 1;
    const sum = d1 + d2;
    const isSmall = sum >= 1 && sum <= 6;
    if ((isSmall && choice === 'small') || (!isSmall && choice === 'big')) {
      won = true;
      rewardMultiplier = getGenericRewardMultiplier();
    }
    resultMeta = { dice1: d1, dice2: d2, sum };
  } else if (game === 'prediction') {
    const startVal = choice.startVal;
    const endVal = choice.endVal;
    const dir = choice.direction;
    won = (dir === 'up' && endVal > startVal) || (dir === 'down' && endVal < startVal);
    rewardMultiplier = won ? 2 : 0;
    resultMeta = { startVal, endVal };
  } else if (game === 'careerboot') {
    won = choice.won;
    rewardMultiplier = choice.multiplier || 0;
  }

  const winPayout = won ? (numBet * rewardMultiplier) : 0;

  if (winPayout > 0) {
    await User.updateOne({ username }, { $inc: { balance: winPayout, totalWon: winPayout } });
  } else {
    await User.updateOne({ username }, { $inc: { totalLost: numBet } });
  }

  const finalUser = await User.findOne({ username });
  res.json({ won, rewardMultiplier, newBalance: finalUser.balance, resultMeta });
});

// ==========================================
// EMBEDDED FRONTEND ENGINE
// ==========================================
app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="hi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>Kismat ka Khel 🤑</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    * { box-sizing: border-box; touch-action: manipulation; }
    body, html { height: 100%; width: 100%; margin: 0; padding: 0; overflow: hidden; background-color: #0d0202; font-family: ui-sans-serif, system-ui; }
    .gold-gradient { background: linear-gradient(135deg, #bf953f, #fcf6ba, #b38728, #fbf5b7); }
    .gold-text { background: linear-gradient(135deg, #bf953f, #fcf6ba, #b38728); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
    .tomato-card { background: linear-gradient(145deg, #800a0a, #360303); border: 2px solid #d4af37; box-shadow: 0 10px 25px rgba(0,0,0,0.8); }
    .no-scrollbar::-webkit-scrollbar { display: none; }
    .no-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }

    @keyframes popIn {
      0% { transform: scale(0.6); opacity: 0; }
      80% { transform: scale(1.05); opacity: 1; }
      100% { transform: scale(1); opacity: 1; }
    }
    .popup-anim { animation: popIn 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275) forwards; }

    @keyframes expandPage {
      0% { transform: scale(0.1) rotate(-15deg); opacity: 0; }
      100% { transform: scale(1) rotate(0deg); opacity: 1; }
    }
    .animate-expand { animation: expandPage 0.6s cubic-bezier(0.16, 1, 0.3, 1) forwards; }
  </style>
</head>
<body class="h-full w-full flex items-center justify-center p-0 md:p-4">

  <div id="app" class="w-full h-full max-w-md max-h-[920px] bg-[#120303] md:rounded-3xl border-0 md:border-2 border-[#d4af37]/40 shadow-2xl flex flex-col relative overflow-hidden"></div>

  <script>
    class SoundEngine {
      constructor() { this.ctx = null; }
      init() { if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)(); }
      stopAll() {
        if (this.ctx && this.ctx.state !== 'closed') {
          this.ctx.close();
          this.ctx = null;
        }
      }
      playFly() {
        if (state.currentView !== 'aviator') return;
        this.init();
        let osc = this.ctx.createOscillator(); let g = this.ctx.createGain();
        osc.frequency.setValueAtTime(140, this.ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(300, this.ctx.currentTime + 0.1);
        g.gain.setValueAtTime(0.02, this.ctx.currentTime);
        osc.connect(g); g.connect(this.ctx.destination);
        osc.start(); osc.stop(this.ctx.currentTime + 0.1);
      }
      playCoinFlip() {
        if (state.currentView !== 'guesscorrect') return;
        this.init();
        let osc = this.ctx.createOscillator(); let g = this.ctx.createGain();
        osc.frequency.setValueAtTime(800, this.ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(200, this.ctx.currentTime + 0.08);
        g.gain.setValueAtTime(0.04, this.ctx.currentTime);
        osc.connect(g); g.connect(this.ctx.destination);
        osc.start(); osc.stop(this.ctx.currentTime + 0.08);
      }
      playMarketBeep() {
        if (state.currentView !== 'prediction') return;
        this.init();
        let osc = this.ctx.createOscillator(); let g = this.ctx.createGain();
        osc.frequency.setValueAtTime(600, this.ctx.currentTime);
        g.gain.setValueAtTime(0.01, this.ctx.currentTime);
        osc.connect(g); g.connect(this.ctx.destination);
        osc.start(); osc.stop(this.ctx.currentTime + 0.05);
      }
      playWin() {
        if (['lobby', 'login', 'admin', 'pwchange'].includes(state.currentView)) return;
        this.init();
        let osc = this.ctx.createOscillator(); let g = this.ctx.createGain();
        osc.frequency.setValueAtTime(523.25, this.ctx.currentTime);
        osc.frequency.setValueAtTime(659.25, this.ctx.currentTime + 0.1);
        osc.frequency.setValueAtTime(783.99, this.ctx.currentTime + 0.2);
        g.gain.setValueAtTime(0.1, this.ctx.currentTime);
        osc.connect(g); g.connect(this.ctx.destination);
        osc.start(); osc.stop(this.ctx.currentTime + 0.35);
      }
      playLoss() {
        if (['lobby', 'login', 'admin', 'pwchange'].includes(state.currentView)) return;
        this.init();
        let osc = this.ctx.createOscillator(); osc.type = 'sawtooth'; let g = this.ctx.createGain();
        osc.frequency.setValueAtTime(180, this.ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(40, this.ctx.currentTime + 0.3);
        g.gain.setValueAtTime(0.1, this.ctx.currentTime);
        osc.connect(g); g.connect(this.ctx.destination);
        osc.start(); osc.stop(this.ctx.currentTime + 0.3);
      }
    }
    const sound = new SoundEngine();

    let state = {
      user: null,
      currentView: 'login',
      adminSubTab: 'users',
      aviator: { status: 'WAITING', currentX: 1.00, history: [] },
      userBet: 100,
      hasBetAviator: false,
      nextRoundBet: false,
      cashedOut: false,
      popup: null,
      adminUsers: [],
      diceRolling: false,
      diceResults: [1, 1],
      marketHistory: [120, 125, 122, 130, 128, 135, 140, 138, 145, 150],
      predictionMark1: null,
      predictionMark2: null,
      predictionTimer: 0,
      pulseRadius: 0,

      // CAREERBOOT STATE
      careerboot: {
        stage: 'WHEEL', // WHEEL, LESSON, MCQ
        selectedSlice: null,
        spinning: false,
        wheelAngle: 0,
        round: 1, // 1, 2, 3
        questionIndex: 0,
        activeQuestions: [],
        accumulatedMultiplier: 0
      }
    };

    const CAREERBOOT_DATA = {
      'Grammar': {
        color: '#dc2626',
        lesson: \`Grammar forms the structural foundation of professional communication. Master subject-verb agreement (e.g., "The list of items is ready"), appropriate tense consistency, and structural parallelisms. Avoid common errors like dangling modifiers ("Walking to the store, the rain started") and misusing possessive pronouns ("its" vs "it's"). Professional writing demands structural accuracy to convey authority and executive clarity in corporate reporting.\`,
        mcqs: [
          // Round 1
          { q: "Identify the correctly punctuated sentence.", opts: ["The manager, and supervisor agreed.", "The manager and supervisor agreed.", "The manager, and supervisor, agreed.", "The manager and supervisor, agreed."], a: 1 },
          { q: "Which word correctly completes: 'Neither of the applicants ___ qualified.'", opts: ["are", "is", "were", "have"], a: 1 },
          { q: "Choose the sentence with correct subject-verb agreement.", opts: ["Data shows great progress.", "The team are winning.", "A group of experts is presenting.", "Both is arriving today."], a: 2 },
          { q: "Which phrase contains a dangling modifier?", opts: ["Having finished the report, the computer crashed.", "After completing the audit, she left.", "To succeed, practice daily.", "While reviewing numbers, we saw mistakes."], a: 0 },
          { q: "Select the correct pronoun: 'Give the file to John and ___.'", opts: ["myself", "I", "me", "himself"], a: 2 },
          // Round 2
          { q: "Identify the correct usage of 'its' or 'it's'.", opts: ["Its time to start.", "The company updated it's policy.", "The bird lost its feather.", "It's tail was wagging."], a: 2 },
          { q: "Which sentence displays parallel structure?", opts: ["He likes hiking, swimming, and to ride bikes.", "She enjoys reading, writing, and editing.", "They learned planning, executing, and to review.", "We prefer speaking, listening, and write."], a: 1 },
          { q: "Identify the passive voice construction.", opts: ["The analyst compiled the dashboard.", "The report was finalized by the committee.", "We resolved the audit queries.", "She presented the revenue projection."], a: 1 },
          { q: "Which word is a conjunction?", opts: ["Quickly", "Although", "Efficiency", "Under"], a: 1 },
          { q: "Find the error: 'He is more smarter than his peer.'", opts: ["more smarter", "than", "his", "peer"], a: 0 },
          // Round 3
          { q: "Which clause is independent?", opts: ["Because revenue rose dramatically", "Although the audit failed", "The quarterly figures exceeded projections", "Since market conditions shifted"], a: 2 },
          { q: "Choose the correct subjunctive mood usage.", opts: ["If I was the CEO, I would expand.", "If I were the CEO, I would expand.", "If I am the CEO, I will expand.", "If I be the CEO, I expand."], a: 1 },
          { q: "Select the correct word: 'The policy will ___ all employees.'", opts: ["affect", "effect", "effective", "affection"], a: 0 },
          { q: "What is an adverb modifying in: 'The exceptionally clear report passed.'?", opts: ["report", "passed", "clear", "The"], a: 2 },
          { q: "Identify the correct relative pronoun: 'The client ___ account closed.'", opts: ["who", "whom", "whose", "which"], a: 2 }
        ]
      },
      'Vocabulary': {
        color: '#2563eb',
        lesson: \`Corporate vocabulary enhances your business influence and persuasiveness. Essential terms include "Synergy" (combined interaction producing greater combined impact), "Mitigate" (make less severe), "Pivot" (strategic change in direction), and "ROI" (Return on Investment). Precision in vocabulary eliminates ambiguity in stakeholder presentations, allowing technical insights to be translated seamlessly into commercial strategies.\`,
        mcqs: [
          // Round 1
          { q: "What does 'Mitigate' mean?", opts: ["Increase severity", "Lessen or reduce harm", "Duplicate records", "Delay execution"], a: 1 },
          { q: "Choose the synonym for 'Synergy'.", opts: ["Isolation", "Combined effectiveness", "Conflict", "Division"], a: 1 },
          { q: "What is the meaning of 'Pivot' in business?", opts: ["Close operations", "Maintain current strategy", "Strategic change in course", "File for bankruptcy"], a: 2 },
          { q: "Define 'Feasible'.", opts: ["Impossible to execute", "Possible and practical", "Expensive", "Theoretical only"], a: 1 },
          { q: "What does 'Paradigm' refer to?", opts: ["A standard pattern or model", "A financial loss", "A software bug", "A short break"], a: 0 },
          // Round 2
          { q: "Select the antonym of 'Transparent'.", opts: ["Clear", "Opaque", "Honest", "Lucid"], a: 1 },
          { q: "What is 'Benchmark'?", opts: ["A wooden chair", "A standard of excellence for comparison", "A temporary error", "A final invoice"], a: 1 },
          { q: "Choose the meaning of 'Consensus'.", opts: ["General agreement", "Disagreement", "Voting tie", "Individual verdict"], a: 0 },
          { q: "Define 'Disruptive' in corporate innovation.", opts: ["Annoying colleagues", "Radically altering an industry", "Failing audits", "Slowing down workflow"], a: 1 },
          { q: "What does 'Leverage' mean in strategy?", opts: ["Use to maximum advantage", "Give up control", "Borrow cash only", "Reduce workforce"], a: 0 },
          // Round 3
          { q: "What does 'Scalable' signify?", opts: ["Fixed capacity", "Capable of growing without structure collapse", "Shrinking market", "Manual processing"], a: 1 },
          { q: "Select the definition of 'Discrepancy'.", opts: ["Perfect match", "Inconsistency or difference", "Legal clause", "Financial gain"], a: 1 },
          { q: "What does 'Fiduciary' relate to?", opts: ["Trust and financial responsibility", "Marketing campaigns", "Software design", "Warehouse logistics"], a: 0 },
          { q: "Choose the synonym for 'Pragmatic'.", opts: ["Idealistic", "Practical", "Careless", "Theoretical"], a: 1 },
          { q: "Define 'Bottleneck'.", opts: ["Point of congestion or delay", "Packaging type", "Smooth pipeline", "Rapid acceleration"], a: 0 }
        ]
      },
      'MS Excel': {
        color: '#059669',
        lesson: \`MS Excel is the core engine for data operations and reporting in modern retail and corporate management. Key tools include VLOOKUP/XLOOKUP for cross-table referencing, Pivot Tables for rapid multi-dimensional aggregation, and conditional logic functions like SUMIFS, COUNTIFS, and INDEX/MATCH. Master absolute ($A$1) versus relative cell references to maintain data integrity across multi-tab financial dashboards.\`,
        mcqs: [
          // Round 1
          { q: "Which formula searches for a value in the leftmost column of a table?", opts: ["XLOOKUP", "VLOOKUP", "HLOOKUP", "INDEX"], a: 1 },
          { q: "What symbol freezes cell references in Excel (Absolute Reference)?", opts: ["#", "$", "%", "&"], a: 1 },
          { q: "Which feature rapidly summarizes large sets of operational data?", opts: ["Data Validation", "Pivot Table", "Conditional Formatting", "Goal Seek"], a: 1 },
          { q: "What does #N/A mean in Excel?", opts: ["Value not available", "Number overflow", "Column width small", "Division by zero"], a: 0 },
          { q: "Which function counts cells that meet specific criteria?", opts: ["COUNT", "COUNTA", "COUNTIF", "SUMIF"], a: 2 },
          // Round 2
          { q: "How do you combine text from multiple cells in Excel?", opts: ["MERGE()", "CONCATENATE() / TEXTJOIN()", "ADD()", "JOIN.TEXT()"], a: 1 },
          { q: "Which shortcut locks or cycles cell reference modes ($)?", opts: ["F2", "F4", "F9", "F11"], a: 1 },
          { q: "What is the result of =IF(5>3, 'Yes', 'No')?", opts: ["No", "Yes", "TRUE", "ERROR"], a: 1 },
          { q: "Which function replaces VLOOKUP with modern flexibility?", opts: ["LOOKUPNOW", "XLOOKUP", "SUPERLOOKUP", "MATCHV"], a: 1 },
          { q: "What does the INDEX & MATCH combination replace?", opts: ["SUMIFS", "VLOOKUP limitation of leftward lookup", "Pivot Tables", "Macros"], a: 1 },
          // Round 3
          { q: "Which Excel feature isolates specific rows based on criteria?", opts: ["Sort", "Filter", "Consolidate", "Group"], a: 1 },
          { q: "How do you strip extra trailing/leading spaces from text?", opts: ["CLEAN()", "TRIM()", "REMOVE()", "CROP()"], a: 1 },
          { q: "Which formula calculates average based on multiple criteria?", opts: ["AVERAGEIF", "AVERAGEIFS", "SUMIFS", "COUNTIFS"], a: 1 },
          { q: "What error indicates division by 0?", opts: ["#VALUE!", "#REF!", "#DIV/0!", "#NUM!"], a: 2 },
          { q: "What does CTRL + Z do in Excel?", opts: ["Redo action", "Undo action", "Select all", "Save file"], a: 1 }
        ]
      },
      'Business analytics': {
        color: '#d97706',
        lesson: \`Business Analytics bridges raw datasets and commercial strategy. It leverages descriptive analytics (what happened), diagnostic analytics (why it happened), predictive analytics (what will happen), and prescriptive analytics (how to make it happen). Key performance indicators (KPIs) such as customer acquisition cost (CAC), lifetime value (LTV), churn rate, and net promoter score (NPS) guide executive decision-making.\`,
        mcqs: [
          // Round 1
          { q: "What type of analytics explains 'What happened in the past'?", opts: ["Predictive", "Descriptive", "Prescriptive", "Diagnostic"], a: 1 },
          { q: "What does KPI stand for?", opts: ["Key Process Integration", "Key Performance Indicator", "Known Program Insight", "Key Profit Index"], a: 1 },
          { q: "What metric tracks customer turnover/loss rate?", opts: ["Churn Rate", "Bounce Rate", "Retention Index", "LTV"], a: 0 },
          { q: "What does LTV stand for in customer analytics?", opts: ["Long Term Value", "Lifetime Value", "Last Transaction Valuation", "Lead Total Value"], a: 1 },
          { q: "Which analytics type suggests actions to take?", opts: ["Descriptive", "Diagnostic", "Predictive", "Prescriptive"], a: 3 },
          // Round 2
          { q: "What is A/B Testing?", opts: ["Testing two versions to see which performs better", "Auditing financials twice", "Backing up databases A and B", "Comparing 2 employees"], a: 0 },
          { q: "What does CAC stand for?", opts: ["Customer Acquisition Cost", "Company Audit Capital", "Current Asset Calculation", "Cost Analytics Center"], a: 0 },
          { q: "What does a correlation value of +1 indicate?", opts: ["No relationship", "Perfect inverse relationship", "Perfect positive linear relationship", "Data error"], a: 2 },
          { q: "What is data cleaning?", opts: ["Deleting all database rows", "Fixing corrupt/inaccurate data records", "Formatting fonts", "Exporting to PDF"], a: 1 },
          { q: "Which metric measures customer willingness to recommend?", opts: ["ROI", "NPS (Net Promoter Score)", "CTR", "CPM"], a: 1 },
          { q: "What is an outlier in a dataset?", opts: ["The average value", "A data point significantly different from others", "The median value", "A missing value"], a: 1 },
          { q: "What does Data Mining involve?", opts: ["Physical hardware extraction", "Discovering patterns in large datasets", "Writing SQL queries only", "Deleting old logs"], a: 1 },
          { q: "What chart type best shows trends over time?", opts: ["Pie Chart", "Line Chart", "Scatter Plot", "Gauge Chart"], a: 1 },
          { q: "Define 'Cohort Analysis'.", opts: ["Analyzing groups with shared characteristics over time", "Comparing two companies", "Calculating daily tax", "Surveying staff"], a: 0 },
          { q: "What does ROI stand for?", opts: ["Return on Investment", "Rate of Inflation", "Risk of Insolvency", "Revenue on Operations"], a: 0 }
        ]
      }
    };

    function switchView(targetView) {
      if (['lobby', 'login', 'admin', 'pwchange'].includes(targetView)) {
        sound.stopAll();
      }
      state.currentView = targetView;
      render();
    }

    const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host);
    ws.onmessage = (e) => {
      const data = JSON.parse(e.data);
      if (data.type === 'AVIATOR_STATE') {
        state.aviator = data;
        if (data.status === 'WAITING') {
          if (state.nextRoundBet) {
            state.hasBetAviator = true;
            state.nextRoundBet = false;
          }
          state.cashedOut = false;
        }
        if (data.status === 'FLYING' && !state.cashedOut) sound.playFly();
        if (data.status === 'CRASHED' && state.hasBetAviator && !state.cashedOut) {
          sound.playLoss();
          state.hasBetAviator = false;
        }
        if (state.currentView === 'aviator') renderAviatorOverlay();
      }
    };

    function showPopup(title, btnText, onConfirm = null) {
      state.popup = { title, btnText, onConfirm };
      render();
    }
    function closePopup() { 
      if (state.popup && state.popup.onConfirm) state.popup.onConfirm();
      state.popup = null; 
      render(); 
    }

    async function handleLogin() {
      sound.init();
      const u = document.getElementById('u').value;
      const p = document.getElementById('p').value;
      try {
        const res = await fetch('/api/login', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: u, password: p })
        });
        if (res.ok) {
          state.user = await res.json();
          switchView(state.user.role === 'admin' ? 'admin' : 'lobby');
          if (state.user.role === 'admin') fetchAdminUsers();
        } else {
          showPopup('Invalid credentials', 'Try again');
        }
      } catch(e) {
        showPopup('Connection Error', 'Try again');
      }
      render();
    }

    async function fetchAdminUsers() {
      const res = await fetch('/api/admin/users');
      if (res.ok) state.adminUsers = await res.json();
      render();
    }

    function checkLoginInputsDirectly() {
      const u = document.getElementById('u')?.value || '';
      const p = document.getElementById('p')?.value || '';
      const btn = document.getElementById('lbtn');
      if (btn) {
        if (u.trim() !== '' && p.trim() !== '') btn.classList.remove('hidden');
        else btn.classList.add('hidden');
      }
    }

    async function changePassword() {
      const oldPassword = document.getElementById('opw').value;
      const newPassword = document.getElementById('npw').value;
      const res = await fetch('/api/change-password', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: state.user.username, oldPassword, newPassword })
      });
      const data = await res.json();
      if (res.ok) showPopup(data.message, 'OK');
      else showPopup(data.error || 'Error', 'OK');
    }

    function updateBetAmount(delta) {
      state.userBet = Math.max(10, state.userBet + delta);
      const inputs = document.querySelectorAll('.bet-amt-input');
      inputs.forEach(i => i.value = state.userBet);
      if(state.currentView === 'aviator') renderAviatorOverlay();
      else render();
    }

    function renderBetControllerUI() {
      return \`
        <div class="flex items-center justify-between bg-black/60 p-2 rounded-2xl border border-amber-500/40 w-full max-w-xs shadow-lg">
          <span class="text-xs text-amber-300 font-bold ml-2">BET AMOUNT:</span>
          <div class="flex items-center gap-2">
            <button onclick="updateBetAmount(-10)" class="w-9 h-9 rounded-xl bg-red-900/80 border border-red-500 text-amber-300 font-black text-lg flex items-center justify-center active:scale-95">-</button>
            <input type="number" readonly value="\${state.userBet}" class="bet-amt-input w-20 bg-black/80 border border-amber-500/50 rounded-xl text-center font-mono font-bold text-amber-300 py-1.5 text-sm outline-none">
            <button onclick="updateBetAmount(10)" class="w-9 h-9 rounded-xl bg-emerald-900/80 border border-emerald-500 text-amber-300 font-black text-lg flex items-center justify-center active:scale-95">+</button>
          </div>
        </div>
      \`;
    }

    // --- GAME 1: AVIATOR ---
    async function handleAviatorAction() {
      sound.init();
      if (state.aviator.status === 'WAITING' && !state.hasBetAviator) {
        if(state.user.balance < state.userBet) return showPopup("Insufficient Balance!", "OK");
        state.hasBetAviator = true;
        renderAviatorOverlay();
      } else if (state.aviator.status === 'FLYING') {
        if (state.hasBetAviator && !state.cashedOut) {
          state.cashedOut = true;
          const winAmt = +(state.userBet * state.aviator.currentX).toFixed(2);
          state.user.balance += (winAmt - state.userBet);
          sound.playWin();
          showPopup(\`CASHED OUT AT \${state.aviator.currentX.toFixed(2)}x! WON ₹\${winAmt}\`, 'Paisa hi Paisa');
          state.hasBetAviator = false;
          renderAviatorOverlay();
        } else if (!state.hasBetAviator && !state.nextRoundBet) {
          if(state.user.balance < state.userBet) return showPopup("Insufficient Balance!", "OK");
          state.nextRoundBet = true;
          renderAviatorOverlay();
        }
      }
    }

    function renderAviatorCanvas() {
      const cvs = document.getElementById('aviator-canvas');
      if(!cvs) return;
      const ctx = cvs.getContext('2d');
      const w = cvs.width = cvs.clientWidth;
      const h = cvs.height = cvs.clientHeight;

      ctx.clearRect(0, 0, w, h);
      
      ctx.strokeStyle = '#1e293b'; ctx.lineWidth = 1;
      for(let x=0; x<w; x+=30) { ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,h); ctx.stroke(); }
      for(let y=0; y<h; y+=30) { ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(w,y); ctx.stroke(); }

      if(state.aviator.status === 'FLYING' || state.aviator.status === 'CRASHED') {
        const progress = Math.min((state.aviator.currentX - 1) / 8, 1);
        const endX = 30 + (w - 70) * progress;
        const endY = (h - 30) - (h - 70) * Math.pow(progress, 0.8);

        ctx.beginPath();
        ctx.moveTo(30, h - 30);
        ctx.quadraticCurveTo(w * 0.35, h - 30, endX, endY);
        ctx.strokeStyle = state.aviator.status === 'CRASHED' ? '#ef4444' : '#eab308';
        ctx.lineWidth = 4;
        ctx.stroke();

        ctx.lineTo(endX, h - 30); ctx.lineTo(30, h - 30);
        ctx.fillStyle = state.aviator.status === 'CRASHED' ? 'rgba(239, 68, 68, 0.2)' : 'rgba(234, 179, 8, 0.2)';
        ctx.fill();

        ctx.save();
        ctx.translate(endX, endY);
        if(state.aviator.status === 'CRASHED') {
          ctx.font = '32px sans-serif';
          ctx.fillText('💥', -16, 12);
        } else {
          ctx.rotate(-Math.PI / 8);
          ctx.fillStyle = '#ef4444';
          ctx.beginPath();
          ctx.ellipse(0, 0, 16, 7, 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = '#ffffff';
          ctx.beginPath();
          ctx.moveTo(8, -2); ctx.lineTo(-4, -12); ctx.lineTo(-8, -2);
          ctx.fill();
          ctx.beginPath();
          ctx.moveTo(-10, 0); ctx.lineTo(-16, -6); ctx.lineTo(-16, 6);
          ctx.fill();
        }
        ctx.restore();
      }
    }

    function renderAviatorOverlay() {
      renderAviatorCanvas();
      const xElem = document.getElementById('aviator-x');
      const statusElem = document.getElementById('aviator-status');
      const actionBtn = document.getElementById('aviator-btn');

      if (xElem) {
        xElem.innerText = state.aviator.currentX.toFixed(2) + 'x';
        xElem.className = \`text-5xl font-black font-mono \${state.aviator.status === 'CRASHED' ? 'text-red-500' : 'text-amber-400'}\`;
      }
      if (statusElem) {
        statusElem.innerText = state.aviator.status === 'WAITING' ? 'WAITING FOR NEXT ROUND (5s)' : (state.aviator.status === 'FLYING' ? 'FLYING' : 'FLEW AWAY!');
        statusElem.className = \`text-xs font-bold px-3 py-1 rounded-full \${state.aviator.status === 'FLYING' ? 'bg-amber-900/80 text-amber-300 border border-amber-500' : 'bg-red-900/80 text-red-300 border border-red-500'}\`;
      }

      if (actionBtn) {
        if (state.aviator.status === 'WAITING') {
          actionBtn.disabled = state.hasBetAviator;
          actionBtn.innerHTML = state.hasBetAviator ? 'BET PLACED FOR NEXT ROUND' : \`BET ₹\${state.userBet}\`;
          actionBtn.className = \`w-full h-14 rounded-2xl font-black text-xl tracking-wider transition-all shadow-lg \${state.hasBetAviator ? 'bg-gray-700 text-gray-400' : 'bg-red-600 text-white border-2 border-red-400'}\`;
        } else if (state.aviator.status === 'FLYING') {
          if (state.hasBetAviator && !state.cashedOut) {
            actionBtn.disabled = false;
            actionBtn.innerHTML = \`CASH OUT (₹\${(state.userBet * state.aviator.currentX).toFixed(2)})\`;
            actionBtn.className = 'w-full h-14 rounded-2xl font-black text-xl tracking-wider shadow-lg bg-emerald-500 text-black border-2 border-green-300 animate-pulse';
          } else if (state.nextRoundBet) {
            actionBtn.disabled = true;
            actionBtn.innerHTML = 'BET QUEUED FOR NEXT ROUND';
            actionBtn.className = 'w-full h-14 rounded-2xl font-black text-lg tracking-wider shadow-lg bg-amber-700 text-amber-200 border border-amber-500';
          } else {
            actionBtn.disabled = false;
            actionBtn.innerHTML = \`BET FOR NEXT ROUND (₹\${state.userBet})\`;
            actionBtn.className = 'w-full h-14 rounded-2xl font-black text-lg tracking-wider shadow-lg bg-red-700 text-white border border-red-400';
          }
        } else {
          actionBtn.disabled = true;
          actionBtn.innerHTML = 'ROUND ENDED';
          actionBtn.className = 'w-full h-14 rounded-2xl font-black text-xl tracking-wider shadow-lg bg-gray-800 text-gray-500';
        }
      }
    }

    // --- GAME 2: GUESS CORRECT (DICE) ---
    async function playDiceGame(choice) {
      sound.init();
      if(state.user.balance < state.userBet) return showPopup("Insufficient Balance!", "OK");
      if(state.diceRolling) return;

      state.diceRolling = true;
      let animInterval = setInterval(() => {
        state.diceResults = [Math.floor(Math.random()*6)+1, Math.floor(Math.random()*6)+1];
        sound.playCoinFlip();
        render();
      }, 100);

      const res = await fetch('/api/play-instant', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: state.user.username, game: 'dice', betAmount: state.userBet, choice })
      });
      const data = await res.json();

      setTimeout(() => {
        clearInterval(animInterval);
        state.diceRolling = false;
        if (res.ok) {
          state.diceResults = [data.resultMeta.dice1, data.resultMeta.dice2];
          state.user.balance = data.newBalance;
          render();
          
          setTimeout(() => {
            if (data.won) {
              sound.playWin();
              showPopup(\`MATCHED! Sum is \${data.resultMeta.sum}. WON ₹\${(state.userBet * data.rewardMultiplier).toFixed(2)} (\${data.rewardMultiplier}x)!\`, 'Paisa hi Paisa');
            } else {
              sound.playLoss();
              showPopup(\`MISMATCH! Sum is \${data.resultMeta.sum}. YOU LOST!\`, 'Try Again');
            }
          }, 500);
        } else {
          showPopup(data.error || 'Error', 'OK');
        }
      }, 1500);
    }

    // --- GAME 3: PREDICTION GRAPH ---
    async function playPrediction(dir) {
      sound.init();
      if(state.user.balance < state.userBet) return showPopup("Insufficient Balance!", "OK");
      if(state.predictionTimer > 0) return;

      const startVal = state.marketHistory[state.marketHistory.length - 1];
      state.predictionMark1 = startVal;
      state.predictionMark2 = null;
      state.predictionTimer = 6;

      let timerInterval = setInterval(() => {
        state.predictionTimer--;
        sound.playMarketBeep();
        render();
        if(state.predictionTimer <= 0) {
          clearInterval(timerInterval);
          finishPrediction(dir, startVal);
        }
      }, 1000);
    }

    async function finishPrediction(dir, startVal) {
      const endVal = state.marketHistory[state.marketHistory.length - 1];
      state.predictionMark2 = endVal;
      render();

      const res = await fetch('/api/play-instant', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: state.user.username, game: 'prediction', betAmount: state.userBet, choice: { startVal, endVal, direction: dir } })
      });
      const data = await res.json();

      setTimeout(() => {
        if (res.ok) {
          state.user.balance = data.newBalance;
          if (data.won) {
            sound.playWin();
            showPopup(\`SUCCESS! Entry: ₹\${startVal} | Exit: ₹\${endVal}. WON ₹\${(state.userBet * 2).toFixed(2)}!\`, 'Paisa hi Paisa', () => {
              state.predictionMark1 = null; state.predictionMark2 = null;
            });
          } else {
            sound.playLoss();
            showPopup(\`FAILED! Entry: ₹\${startVal} | Exit: ₹\${endVal}. YOU LOST!\`, 'Try Again', () => {
              state.predictionMark1 = null; state.predictionMark2 = null;
            });
          }
        } else {
          showPopup(data.error || 'Error', 'OK');
          state.predictionMark1 = null; state.predictionMark2 = null;
        }
        render();
      }, 1000);
    }

    // --- GAME 4: CAREERBOOT ENGINE ---
    function renderCareerBootWheelCanvas() {
      const cvs = document.getElementById('cb-wheel-canvas');
      if (!cvs) return;
      const ctx = cvs.getContext('2d');
      const w = cvs.width = cvs.clientWidth;
      const h = cvs.height = cvs.clientHeight;
      const r = Math.min(w, h) / 2 - 10;
      const cx = w / 2;
      const cy = h / 2;

      ctx.clearRect(0, 0, w, h);

      const slices = Object.keys(CAREERBOOT_DATA);
      const arc = (Math.PI * 2) / slices.length;

      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(state.careerboot.wheelAngle);

      slices.forEach((sliceKey, i) => {
        const sliceAngle = i * arc;
        ctx.beginPath();
        ctx.fillStyle = CAREERBOOT_DATA[sliceKey].color;
        ctx.moveTo(0, 0);
        ctx.arc(0, 0, r, sliceAngle, sliceAngle + arc);
        ctx.lineTo(0, 0);
        ctx.fill();
        ctx.strokeStyle = '#d4af37';
        ctx.lineWidth = 3;
        ctx.stroke();

        ctx.save();
        ctx.rotate(sliceAngle + arc / 2);
        ctx.textAlign = 'right';
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 12px sans-serif';
        ctx.shadowColor = '#000000';
        ctx.shadowBlur = 4;
        ctx.fillText(sliceKey.toUpperCase(), r - 15, 4);
        ctx.restore();
      });

      ctx.restore();

      // Pin Needle Pointer at top
      ctx.fillStyle = '#fcf6ba';
      ctx.beginPath();
      ctx.moveTo(cx - 12, cy - r - 4);
      ctx.lineTo(cx + 12, cy - r - 4);
      ctx.lineTo(cx, cy - r + 18);
      ctx.fill();
      ctx.strokeStyle = '#800a0a';
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    async function spinCareerBootWheel() {
      sound.init();
      if (state.user.balance < state.userBet) return showPopup("Insufficient Balance!", "OK");
      if (state.careerboot.spinning) return;

      state.careerboot.spinning = true;
      const slices = Object.keys(CAREERBOOT_DATA);
      const chosenIndex = Math.floor(Math.random() * slices.length);
      const chosenSlice = slices[chosenIndex];

      const arc = (Math.PI * 2) / slices.length;
      const targetSliceCenter = chosenIndex * arc + (arc / 2);
      let targetAngle = (Math.PI * 1.5) - targetSliceCenter;
      if (targetAngle < 0) targetAngle += Math.PI * 2;

      const totalSpins = 5 * Math.PI * 2;
      const finalAngle = state.careerboot.wheelAngle + totalSpins + targetAngle - (state.careerboot.wheelAngle % (Math.PI * 2));

      let startTime = null;
      const duration = 3000;

      function animateSpin(timestamp) {
        if (!startTime) startTime = timestamp;
        let elapsed = timestamp - startTime;
        let progress = Math.min(elapsed / duration, 1);
        let easeOut = 1 - Math.pow(1 - progress, 3);

        state.careerboot.wheelAngle = easeOut * finalAngle;
        sound.playCoinFlip();
        renderCareerBootWheelCanvas();

        if (progress < 1) {
          requestAnimationFrame(animateSpin);
        } else {
          state.careerboot.spinning = false;
          state.careerboot.selectedSlice = chosenSlice;
          state.careerboot.stage = 'LESSON';
          render();
        }
      }

      requestAnimationFrame(animateSpin);
    }

    function startCareerBootMCQs() {
      const sliceObj = CAREERBOOT_DATA[state.careerboot.selectedSlice];
      state.careerboot.round = 1;
      state.careerboot.questionIndex = 0;
      state.careerboot.accumulatedMultiplier = 0;
      state.careerboot.activeQuestions = [...sliceObj.mcqs];
      state.careerboot.stage = 'MCQ';
      render();
    }

    async function handleCareerBootAnswer(selectedOptIndex) {
      const currentRound = state.careerboot.round;
      const qIdx = (currentRound - 1) * 5 + state.careerboot.questionIndex;
      const currentQ = state.careerboot.activeQuestions[qIdx];

      if (selectedOptIndex === currentQ.a) {
        sound.playWin();
        const roundMult = currentRound === 1 ? 1.40 : (currentRound === 2 ? 1.60 : 2.00);
        state.careerboot.accumulatedMultiplier += roundMult;

        if (state.careerboot.questionIndex < 4) {
          state.careerboot.questionIndex++;
        } else {
          if (currentRound < 3) {
            state.careerboot.round++;
            state.careerboot.questionIndex = 0;
            showPopup(\`ROUND \${currentRound} COMPLETED! Next Round Multiplier Unlocked!`, 'Continue');
          } else {
            // ALL 3 ROUNDS COMPLETED (VICTORY)
            const finalMult = state.careerboot.accumulatedMultiplier;
            const res = await fetch('/api/play-instant', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ username: state.user.username, game: 'careerboot', betAmount: state.userBet, choice: { won: true, multiplier: finalMult } })
            });
            const data = await res.json();
            if (res.ok) state.user.balance = data.newBalance;

            sound.playWin();
            showPopup(\`ALL ROUNDS PASSED! Total Multiplier \${finalMult.toFixed(2)}x! WON ₹\${(state.userBet * finalMult).toFixed(2)}!\`, 'Paisa hi Paisa', () => {
              state.careerboot.stage = 'WHEEL';
            });
          }
        }
      } else {
        // WRONG ANSWER -> LOSS
        sound.playLoss();
        const res = await fetch('/api/play-instant', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: state.user.username, game: 'careerboot', betAmount: state.userBet, choice: { won: false, multiplier: 0 } })
        });
        const data = await res.json();
        if (res.ok) state.user.balance = data.newBalance;

        showPopup(\`WRONG ANSWER! YOU LOST ₹\${state.userBet}. Select bet amount and try again!`, 'Bet Again', () => {
          state.careerboot.stage = 'WHEEL';
        });
      }
      render();
    }

    // Live Market Price Generator
    setInterval(() => {
      let lastVal = state.marketHistory[state.marketHistory.length - 1] || 120;
      let change = (Math.random() - 0.48) * 12;
      let nextVal = Math.max(20, Math.min(300, Math.round(lastVal + change)));
      state.marketHistory.push(nextVal);
      if (state.marketHistory.length > 25) state.marketHistory.shift();
      if (state.currentView === 'prediction') renderPredictionGraph();
    }, 1000);

    // Dynamic Futuristic Chart Animation Frame
    function renderPredictionGraph() {
      const cvs = document.getElementById('market-canvas');
      if(!cvs) return;
      const ctx = cvs.getContext('2d');
      const w = cvs.width = cvs.clientWidth;
      const h = cvs.height = cvs.clientHeight;

      ctx.clearRect(0, 0, w, h);
      
      const pts = state.marketHistory;
      let minVal = Math.min(...pts, state.predictionMark1 || Infinity, state.predictionMark2 || Infinity) - 15;
      let maxVal = Math.max(...pts, state.predictionMark1 || -Infinity, state.predictionMark2 || -Infinity) + 15;
      if (minVal === Infinity) minVal = 40;
      if (maxVal === -Infinity) maxVal = 220;
      let range = maxVal - minVal || 1;

      // Hi-Tech Neon Dark Background Grid
      ctx.strokeStyle = '#1e293b';
      ctx.lineWidth = 0.5;
      for (let y = 0; y < h; y += 25) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
      }
      for (let x = 0; x < w; x += 35) {
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
      }

      const step = w / (pts.length - 1);

      // Gradient Fill Under Graph
      let fillGrad = ctx.createLinearGradient(0, 0, 0, h);
      fillGrad.addColorStop(0, 'rgba(34, 197, 94, 0.35)');
      fillGrad.addColorStop(1, 'rgba(34, 197, 94, 0.00)');

      ctx.beginPath();
      for(let i = 0; i < pts.length; i++) {
        let y = h - ((pts[i] - minVal) / range) * (h - 30) - 15;
        let x = i * step;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      
      let lastVal = pts[pts.length - 1];
      let lastX = w;
      let lastY = h - ((lastVal - minVal) / range) * (h - 30) - 15;

      ctx.lineTo(lastX, h);
      ctx.lineTo(0, h);
      ctx.fillStyle = fillGrad;
      ctx.fill();

      // Glowing Main Neon Line
      ctx.beginPath();
      for(let i = 0; i < pts.length; i++) {
        let y = h - ((pts[i] - minVal) / range) * (h - 30) - 15;
        let x = i * step;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.shadowColor = '#22c55e';
      ctx.shadowBlur = 12;
      ctx.strokeStyle = '#22c55e';
      ctx.lineWidth = 3.5;
      ctx.stroke();
      ctx.shadowBlur = 0; // Reset Shadow

      // Animated Expanding Pulse Ring at Graph Point Head
      state.pulseRadius = (state.pulseRadius + 0.3) % 12;
      ctx.beginPath();
      ctx.arc(lastX - 4, lastY, 4 + state.pulseRadius, 0, Math.PI * 2);
      ctx.strokeStyle = \`rgba(34, 197, 94, \${1 - state.pulseRadius / 12})\`;
      ctx.lineWidth = 2;
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(lastX - 4, lastY, 5, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();

      // Floating Dynamic Price Glass Tag
      ctx.fillStyle = '#22c55e';
      ctx.beginPath();
      ctx.roundRect(lastX - 68, lastY - 26, 62, 20, 6);
      ctx.fill();
      ctx.fillStyle = '#000000';
      ctx.font = 'black 11px monospace';
      ctx.fillText('₹' + lastVal, lastX - 58, lastY - 12);

      // ENTRY Horizontal Line & Marker (Gold Theme)
      if (state.predictionMark1) {
        let y1 = h - ((state.predictionMark1 - minVal) / range) * (h - 30) - 15;
        ctx.beginPath();
        ctx.shadowColor = '#eab308';
        ctx.shadowBlur = 8;
        ctx.strokeStyle = '#eab308';
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 4]);
        ctx.moveTo(0, y1); ctx.lineTo(w, y1);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.shadowBlur = 0;

        ctx.fillStyle = '#eab308';
        ctx.beginPath();
        ctx.roundRect(8, y1 - 20, 100, 18, 4);
        ctx.fill();
        ctx.fillStyle = '#000000';
        ctx.font = 'bold 10px sans-serif';
        ctx.fillText('ENTRY: ₹' + state.predictionMark1, 14, y1 - 7);
      }

      // EXIT Horizontal Line & Marker (Cyan Neon Theme)
      if (state.predictionMark2) {
        let y2 = h - ((state.predictionMark2 - minVal) / range) * (h - 30) - 15;
        ctx.beginPath();
        ctx.shadowColor = '#06b6d4';
        ctx.shadowBlur = 8;
        ctx.strokeStyle = '#06b6d4';
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 4]);
        ctx.moveTo(0, y2); ctx.lineTo(w, y2);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.shadowBlur = 0;

        ctx.fillStyle = '#06b6d4';
        ctx.beginPath();
        ctx.roundRect(w - 108, y2 - 20, 100, 18, 4);
        ctx.fill();
        ctx.fillStyle = '#000000';
        ctx.font = 'bold 10px sans-serif';
        ctx.fillText('EXIT: ₹' + state.predictionMark2, w - 102, y2 - 7);
      }
    }

    // ==========================================
    // UI RENDER ENGINE
    // ==========================================
    function render() {
      const app = document.getElementById('app');
      let html = '';

      let popupHtml = '';
      if (state.popup) {
        popupHtml = \`
          <div class="absolute inset-0 bg-black/80 z-50 flex items-center justify-center p-4 backdrop-blur-sm">
            <div class="tomato-card p-6 rounded-3xl max-w-xs w-full text-center space-y-4 popup-anim">
              <h2 class="text-xl font-black text-amber-300 tracking-wide">\${state.popup.title}</h2>
              <button onclick="closePopup()" class="w-full gold-gradient text-black font-black py-3 rounded-2xl shadow-xl active:scale-95">
                \${state.popup.btnText}
              </button>
            </div>
          </div>
        \`;
      }

      if (state.currentView === 'login') {
        html = \`
          <div class="h-full w-full flex flex-col items-center justify-center p-6 bg-gradient-to-b from-[#2a0404] to-[#0d0202]">
            <div class="tomato-card p-8 rounded-3xl w-full text-center space-y-5">
              <div class="text-6xl">🤑</div>
              <div>
                <h1 class="text-3xl font-black gold-text tracking-wider">Kismat ka Khel</h1>
                <p class="text-xs font-semibold text-amber-200/70 mt-1">Shree Ganesh Karte Hai</p>
              </div>
              <div class="space-y-3">
                <input id="u" oninput="checkLoginInputsDirectly()" type="text" placeholder="Username" class="w-full p-4 rounded-2xl bg-black/60 border border-amber-500/40 text-white placeholder-amber-200/40 text-sm outline-none">
                <input id="p" oninput="checkLoginInputsDirectly()" type="password" placeholder="Password" class="w-full p-4 rounded-2xl bg-black/60 border border-amber-500/40 text-white placeholder-amber-200/40 text-sm outline-none">
              </div>
              <button id="lbtn" onclick="handleLogin()" class="hidden w-full gold-gradient text-black font-black py-4 rounded-2xl shadow-xl text-lg">
                Paisa hi Paisa Hoga 💰
              </button>
            </div>
          </div>
        \`;
      }

      else if (state.currentView === 'lobby') {
        html = \`
          <div class="h-full w-full flex flex-col bg-[#120303]">
            <div class="h-16 px-4 bg-gradient-to-r from-red-950 via-black to-red-950 border-b border-amber-500/40 flex items-center justify-between shadow-lg">
              <span class="font-black text-lg gold-text">Kismat ka Khel 🤑</span>
              <div class="flex items-center gap-2">
                <div class="bg-black/60 px-3 py-1.5 rounded-full border border-amber-500/40">
                  <span class="text-xs text-amber-300 font-bold">₹</span>
                  <span class="text-sm font-mono font-bold text-green-400">\${state.user.balance.toFixed(2)}</span>
                </div>
                <button onclick="switchView('pwchange')" class="px-2.5 py-1 bg-amber-600/30 border border-amber-500/50 rounded-lg text-[10px] font-bold text-amber-300">Password</button>
                <button onclick="switchView('login')" class="px-2.5 py-1 bg-red-900/50 border border-red-500/50 rounded-lg text-[10px] font-bold text-red-300">Logout</button>
              </div>
            </div>
            <div class="flex-1 p-4 grid grid-cols-2 gap-4 overflow-y-auto">
              \${[
                { id: 'careerboot', name: 'CareerBoot', icon: '🎓', desc: 'Wheel & MCQ Rounds' },
                { id: 'aviator', name: 'Aviator', icon: '🚀', desc: 'Realtime Multiplier' },
                { id: 'guesscorrect', name: 'Guess Correct', icon: '🎲', desc: 'Big vs Small Dice' },
                { id: 'prediction', name: 'Prediction', icon: '📈', desc: 'Live Market Line' }
              ].map(g => \`
                <button onclick="switchView('\${g.id}')" class="tomato-card p-4 rounded-3xl flex flex-col items-center justify-center text-center space-y-2 active:scale-95 transition-all">
                  <span class="text-4xl">\${g.icon}</span>
                  <div>
                    <div class="font-black text-amber-300 text-sm">\${g.name}</div>
                    <div class="text-[10px] text-amber-100/60">\${g.desc}</div>
                  </div>
                </button>
              \`).join('')}
            </div>
          </div>
        \`;
      }

      else if (state.currentView === 'careerboot') {
        const cb = state.careerboot;
        if (cb.stage === 'WHEEL') {
          html = \`
            <div class="h-full w-full flex flex-col bg-[#120303]">
              <div class="h-14 px-3 bg-red-950 border-b border-amber-500/40 flex items-center justify-between">
                <button onclick="switchView('lobby')" class="px-3 py-1 bg-red-900 border border-amber-500/40 rounded-xl text-xs font-bold text-white">Lobby</button>
                <span class="font-black gold-text">CAREERBOOT WHEEL</span>
                <span class="font-mono text-sm text-green-400 font-bold">₹\${state.user.balance.toFixed(2)}</span>
              </div>
              <div class="flex-1 flex flex-col items-center justify-center p-4 space-y-4">
                <div class="relative w-72 h-72 flex items-center justify-center">
                  <canvas id="cb-wheel-canvas" class="w-full h-full"></canvas>
                </div>
                \${renderBetControllerUI()}
                <button onclick="spinCareerBootWheel()" \${cb.spinning ? 'disabled' : ''} class="w-full max-w-xs h-14 rounded-2xl font-black text-xl tracking-wider gold-gradient text-black shadow-xl active:scale-95 transition-all">
                  \${cb.spinning ? 'SPINNING...' : 'SPIN THE WHEEL 🎡'}
                </button>
              </div>
            </div>
          \`;
        } else if (cb.stage === 'LESSON') {
          const sliceData = CAREERBOOT_DATA[cb.selectedSlice];
          html = \`
            <div class="h-full w-full flex flex-col bg-[#120303] animate-expand">
              <div class="h-14 px-3 bg-red-950 border-b border-amber-500/40 flex items-center justify-between shrink-0">
                <button onclick="state.careerboot.stage='WHEEL'; render();" class="px-3 py-1 bg-red-900 border border-amber-500/40 rounded-xl text-xs font-bold text-white">Wheel</button>
                <span class="font-black gold-text uppercase">\${cb.selectedSlice} MODULE</span>
                <span class="font-mono text-sm text-green-400 font-bold">₹\${state.user.balance.toFixed(2)}</span>
              </div>
              <div class="flex-1 p-5 overflow-y-auto space-y-4">
                <div class="tomato-card p-6 rounded-3xl space-y-3">
                  <div class="flex items-center gap-2">
                    <span class="text-2xl">📘</span>
                    <h2 class="text-xl font-black text-amber-300 uppercase">\${cb.selectedSlice} Comprehensive Lesson</h2>
                  </div>
                  <p class="text-sm text-amber-100/90 leading-relaxed text-justify font-sans">
                    \${sliceData.lesson}
                  </p>
                </div>
              </div>
              <div class="p-4 bg-red-950 border-t border-amber-500/40 shrink-0 flex justify-center">
                <button onclick="startCareerBootMCQs()" class="w-full max-w-xs h-14 rounded-2xl font-black text-lg gold-gradient text-black shadow-xl active:scale-95">
                  START MCQ QUIZ 🚀
                </button>
              </div>
            </div>
          \`;
        } else if (cb.stage === 'MCQ') {
          const qIdx = (cb.round - 1) * 5 + cb.questionIndex;
          const qObj = cb.activeQuestions[qIdx];
          const roundMultText = cb.round === 1 ? '+1.40x' : (cb.round === 2 ? '+1.60x' : '+2.00x');

          html = \`
            <div class="h-full w-full flex flex-col bg-[#120303]">
              <div class="h-14 px-3 bg-red-950 border-b border-amber-500/40 flex items-center justify-between shrink-0">
                <span class="text-xs font-bold text-amber-300">ROUND \${cb.round}/3</span>
                <span class="font-black gold-text uppercase">\${cb.selectedSlice}</span>
                <span class="text-xs font-mono font-bold text-green-400">MULT: \${roundMultText}</span>
              </div>
              <div class="p-3 bg-black/40 border-b border-amber-500/20 flex justify-between items-center shrink-0">
                <span class="text-xs text-amber-200/70 font-semibold">Question \${cb.questionIndex + 1} of 5</span>
                <span class="text-xs font-mono text-amber-300 font-bold">ACCUMULATED: \${cb.accumulatedMultiplier.toFixed(2)}x</span>
              </div>
              <div class="flex-1 p-5 flex flex-col justify-between overflow-y-auto">
                <div class="tomato-card p-6 rounded-3xl space-y-4">
                  <h3 class="text-base font-bold text-amber-300 leading-snug">\${qObj.q}</h3>
                </div>
                <div class="space-y-3 my-4">
                  \${qObj.opts.map((opt, idx) => \`
                    <button onclick="handleCareerBootAnswer(\${idx})" class="w-full p-4 rounded-2xl bg-black/70 border border-amber-500/40 text-left text-sm font-semibold text-white active:bg-amber-500 active:text-black transition-all shadow-md">
                      <span class="text-amber-400 font-black mr-2">\${['A','B','C','D'][idx]}.</span> \${opt}
                    </button>
                  \`).join('')}
                </div>
              </div>
            </div>
          \`;
        }
      }

      else if (state.currentView === 'pwchange') {
        html = \`
          <div class="h-full w-full flex flex-col bg-[#120303] p-6 justify-center">
            <div class="tomato-card p-6 rounded-3xl space-y-4">
              <h2 class="text-xl font-black text-amber-300 text-center">Change Password</h2>
              <input id="opw" type="password" placeholder="Old Password" class="w-full p-3 bg-black/60 border border-amber-500/40 rounded-xl text-sm outline-none text-white">
              <input id="npw" type="password" placeholder="New Password" class="w-full p-3 bg-black/60 border border-amber-500/40 rounded-xl text-sm outline-none text-white">
              <div class="flex gap-2">
                <button onclick="switchView('lobby')" class="w-1/2 bg-gray-800 text-gray-300 font-bold py-3 rounded-xl text-sm">Cancel</button>
                <button onclick="changePassword()" class="w-1/2 gold-gradient text-black font-black py-3 rounded-xl text-sm">Update</button>
              </div>
            </div>
          </div>
        \`;
      }

      else if (state.currentView === 'aviator') {
        html = \`
          <div class="h-full w-full flex flex-col bg-[#0b0e14]">
            <div class="h-14 px-3 bg-[#141822] border-b border-gray-800 flex items-center justify-between shrink-0">
              <button onclick="switchView('lobby')" class="px-3 py-1 bg-red-900/80 border border-red-500/50 rounded-xl text-xs font-bold text-white">Lobby</button>
              <span class="font-black text-amber-400 text-sm tracking-wider">AVIATOR 24x7</span>
              <span class="font-mono text-sm text-green-400 font-bold">₹\${state.user.balance.toFixed(2)}</span>
            </div>
            <div class="h-10 px-2 bg-black/60 border-b border-gray-800/80 flex items-center gap-1.5 overflow-x-auto shrink-0 no-scrollbar">
              \${state.aviator.history.slice(0, 20).map(h => \`<span class="px-2.5 py-0.5 text-[11px] font-mono font-bold rounded-full bg-gray-800 text-purple-300 border border-purple-500/30 shrink-0">\${h}x</span>\`).join('')}
            </div>
            <div class="flex-1 relative bg-gradient-to-b from-[#0b0e14] to-[#161c27] flex items-center justify-center overflow-hidden">
              <canvas id="aviator-canvas" class="absolute inset-0 w-full h-full"></canvas>
              <div class="relative z-10 flex flex-col items-center text-center space-y-2 pointer-events-none">
                <div id="aviator-x" class="text-5xl font-black font-mono gold-text">\${state.aviator.currentX.toFixed(2)}x</div>
                <div id="aviator-status" class="text-xs font-bold px-3 py-1 rounded-full bg-amber-900/80 text-amber-300 border border-amber-500">CONNECTING...</div>
              </div>
            </div>
            <div class="p-4 bg-[#141822] border-t border-gray-800 shrink-0 space-y-3 flex flex-col items-center">
              \${renderBetControllerUI()}
              <button id="aviator-btn" onclick="handleAviatorAction()" class="w-full max-w-xs h-14 rounded-2xl font-black text-xl tracking-wider bg-red-600 text-white shadow-lg">
                BET ₹\${state.userBet}
              </button>
            </div>
          </div>
        \`;
      }

      else if (state.currentView === 'guesscorrect') {
        const diceDots = {
          1: ['bg-red-500 flex items-center justify-center col-span-3 row-span-3 justify-self-center self-center'],
          2: ['col-start-1 row-start-1 bg-white', 'col-start-3 row-start-3 bg-white'],
          3: ['col-start-1 row-start-1 bg-white', 'col-start-2 row-start-2 bg-white', 'col-start-3 row-start-3 bg-white'],
          4: ['col-start-1 row-start-1 bg-white', 'col-start-3 row-start-1 bg-white', 'col-start-1 row-start-3 bg-white', 'col-start-3 row-start-3 bg-white'],
          5: ['col-start-1 row-start-1 bg-white', 'col-start-3 row-start-1 bg-white', 'col-start-2 row-start-2 bg-white', 'col-start-1 row-start-3 bg-white', 'col-start-3 row-start-3 bg-white'],
          6: ['col-start-1 row-start-1 bg-white', 'col-start-3 row-start-1 bg-white', 'col-start-1 row-start-2 bg-white', 'col-start-3 row-start-2 bg-white', 'col-start-1 row-start-3 bg-white', 'col-start-3 row-start-3 bg-white']
        };

        const renderDice = (val) => \`
          <div class="w-20 h-20 bg-gradient-to-br from-red-600 to-red-950 border-2 border-amber-400 rounded-2xl shadow-xl grid grid-cols-3 grid-rows-3 p-3 gap-1">
            \${(diceDots[val] || []).map(cls => \`<div class="w-3.5 h-3.5 rounded-full shadow-inner \${cls}"></div>\`).join('')}
          </div>
        \`;

        html = \`
          <div class="h-full w-full flex flex-col bg-[#120303]">
            <div class="h-14 px-3 bg-red-950 border-b border-amber-500/40 flex items-center justify-between">
              <button onclick="switchView('lobby')" class="px-3 py-1 bg-red-900 border border-amber-500/40 rounded-xl text-xs font-bold text-white">Lobby</button>
              <span class="font-black gold-text">GUESS CORRECT</span>
              <span class="font-mono text-sm text-green-400 font-bold">₹\${state.user.balance.toFixed(2)}</span>
            </div>
            <div class="flex-1 flex flex-col items-center justify-center p-6 space-y-6">
              <div class="tomato-card p-6 rounded-3xl w-full max-w-xs text-center space-y-3">
                <div class="flex justify-center gap-6">
                  \${renderDice(state.diceResults[0])}
                  \${renderDice(state.diceResults[1])}
                </div>
                <p class="text-xs text-amber-200/70 font-bold">Predict Dice Total Sum</p>
              </div>
              \${renderBetControllerUI()}
              <div class="grid grid-cols-2 gap-4 w-full max-w-xs">
                <button onclick="playDiceGame('small')" class="tomato-card h-16 rounded-2xl flex flex-col items-center justify-center space-y-0.5 active:scale-95">
                  <span class="font-black text-lg text-amber-300">SMALL</span>
                  <span class="text-[10px] text-amber-100/60">Sum 1 to 6</span>
                </button>
                <button onclick="playDiceGame('big')" class="tomato-card h-16 rounded-2xl flex flex-col items-center justify-center space-y-0.5 active:scale-95">
                  <span class="font-black text-lg text-amber-300">BIG</span>
                  <span class="text-[10px] text-amber-100/60">Sum 7 to 12</span>
                </button>
              </div>
            </div>
          </div>
        \`;
      }

      else if (state.currentView === 'prediction') {
        html = \`
          <div class="h-full w-full flex flex-col bg-[#0b0404]">
            <div class="h-14 px-3 bg-red-950 border-b border-amber-500/40 flex items-center justify-between">
              <button onclick="switchView('lobby')" class="px-3 py-1 bg-red-900/80 border border-amber-500/40 rounded-xl text-xs font-bold text-white">Lobby</button>
              <span class="font-black gold-text tracking-wider">PREDICTION PRO</span>
              <span class="font-mono text-sm text-green-400 font-bold">₹\${state.user.balance.toFixed(2)}</span>
            </div>
            <div class="flex-1 flex flex-col items-center justify-between p-3 space-y-3">
              <!-- High-Tech Pro Chart Screen -->
              <div class="w-full flex-1 bg-gradient-to-b from-[#090d16] to-[#04060a] border-2 border-emerald-500/30 rounded-3xl relative overflow-hidden flex flex-col p-2 min-h-[280px] shadow-[0_0_20px_rgba(16,185,129,0.15)]">
                <canvas id="market-canvas" class="absolute inset-0 w-full h-full"></canvas>
                <div class="relative z-10 flex justify-between items-center p-2 pointer-events-none">
                  <div class="flex items-center gap-2 bg-black/80 backdrop-blur-md px-3 py-1.5 rounded-2xl border border-emerald-500/40 shadow-lg">
                    <span class="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-ping"></span>
                    <span class="text-xs font-bold text-emerald-400 uppercase tracking-widest">LIVE</span>
                    <span class="text-sm font-mono font-black text-white ml-1">₹\${state.marketHistory[state.marketHistory.length - 1]}</span>
                  </div>
                  \${state.predictionTimer > 0 ? \`
                    <div class="text-xs font-mono font-black text-amber-300 bg-amber-950/90 backdrop-blur-md px-3 py-1.5 rounded-2xl border border-amber-500/60 animate-pulse shadow-lg">
                      LOCKING IN \${state.predictionTimer}s
                    </div>
                  \` : ''}
                </div>
              </div>
              \${renderBetControllerUI()}
              <div class="grid grid-cols-2 gap-4 w-full max-w-xs shrink-0">
                <button onclick="playPrediction('up')" class="bg-gradient-to-b from-emerald-500 to-emerald-700 border-2 border-emerald-400 h-14 rounded-2xl font-black text-lg active:scale-95 text-white shadow-[0_0_15px_rgba(16,185,129,0.4)] flex items-center justify-center gap-2">
                  <span>UP</span>
                  <span class="text-xl">📈</span>
                </button>
                <button onclick="playPrediction('down')" class="bg-gradient-to-b from-red-600 to-red-800 border-2 border-red-400 h-14 rounded-2xl font-black text-lg active:scale-95 text-white shadow-[0_0_15px_rgba(239,68,68,0.4)] flex items-center justify-center gap-2">
                  <span>DOWN</span>
                  <span class="text-xl">📉</span>
                </button>
              </div>
            </div>
          </div>
        \`;
      }

      else if (state.currentView === 'admin') {
        html = \`
          <div class="h-full w-full flex flex-col bg-[#0b0202] p-4 overflow-hidden">
            <div class="flex justify-between items-center border-b border-amber-500/40 pb-3 shrink-0">
              <h1 class="text-lg font-black gold-text">Admin Panel (Boss)</h1>
              <div class="flex gap-2">
                <button onclick="switchView('pwchange')" class="bg-amber-800 border border-amber-500 px-2 py-1 rounded-xl text-xs font-bold text-white">Password</button>
                <button onclick="switchView('login')" class="bg-red-900 border border-red-500 px-2 py-1 rounded-xl text-xs font-bold text-white">Logout</button>
              </div>
            </div>

            <div class="flex gap-2 my-3 shrink-0">
              <button onclick="state.adminSubTab='users'; render();" class="w-1/2 py-2 rounded-xl font-bold text-xs \${state.adminSubTab==='users' ? 'gold-gradient text-black' : 'bg-gray-800 text-gray-400'}">Users Management</button>
              <button onclick="state.adminSubTab='create'; render();" class="w-1/2 py-2 rounded-xl font-bold text-xs \${state.adminSubTab==='create' ? 'gold-gradient text-black' : 'bg-gray-800 text-gray-400'}">Create User</button>
            </div>

            <div class="flex-1 overflow-y-auto space-y-4">
              \${state.adminSubTab === 'create' ? \`
                <div class="tomato-card p-4 rounded-2xl space-y-3">
                  <h3 class="font-bold text-sm text-amber-300">Create Player Account</h3>
                  <input id="nu" placeholder="New Username" class="w-full p-3 bg-black/60 border border-amber-500/40 rounded-xl text-sm outline-none text-white">
                  <input id="np" placeholder="New Password" class="w-full p-3 bg-black/60 border border-amber-500/40 rounded-xl text-sm outline-none text-white">
                  <button onclick="createPlayer()" class="w-full gold-gradient text-black font-black py-3 rounded-xl text-sm">Create Account</button>
                </div>
              \` : \`
                <div class="tomato-card p-4 rounded-2xl space-y-3">
                  <h3 class="font-bold text-sm text-amber-300">Modify User Balance</h3>
                  <input id="bu" placeholder="Player Username" class="w-full p-3 bg-black/60 border border-amber-500/40 rounded-xl text-sm outline-none text-white">
                  <input id="ba" type="number" placeholder="Amount (+1000 or -500)" class="w-full p-3 bg-black/60 border border-amber-500/40 rounded-xl text-sm outline-none text-white">
                  <button onclick="modifyBalance()" class="w-full bg-emerald-600 text-white font-black py-3 rounded-xl text-sm">Update Balance</button>
                </div>

                <div class="space-y-2">
                  <h3 class="font-bold text-xs text-amber-300/80">ALL PLAYERS STATISTICS</h3>
                  \${state.adminUsers.map(u => \`
                    <div class="bg-black/60 p-3 rounded-xl border border-amber-500/30 text-xs space-y-1">
                      <div class="flex justify-between font-bold text-amber-300">
                        <span>👤 \${u.username}</span>
                        <span class="text-green-400 font-mono">₹\${u.balance.toFixed(2)}</span>
                      </div>
                      <div class="grid grid-cols-3 gap-1 text-[10px] text-gray-400 font-mono mt-1">
                        <div>Won: <span class="text-green-400">₹\${u.totalWon}</span></div>
                        <div>Lost: <span class="text-red-400">₹\${u.totalLost}</span></div>
                        <div>Placed: <span class="text-amber-200">₹\${u.totalBetPlaced}</span></div>
                      </div>
                    </div>
                  \`).join('')}
                </div>
              \`}
            </div>
          </div>
        \`;
      }

      app.innerHTML = html + popupHtml;

      if(state.currentView === 'aviator') renderAviatorOverlay();
      if(state.currentView === 'prediction') renderPredictionGraph();
      if(state.currentView === 'careerboot' && state.careerboot.stage === 'WHEEL') renderCareerBootWheelCanvas();
    }

    async function createPlayer() {
      const username = document.getElementById('nu').value;
      const password = document.getElementById('np').value;
      const res = await fetch('/api/admin/create-user', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      if (res.ok) { fetchAdminUsers(); showPopup('User Created Successfully', 'OK'); }
      else showPopup('Error Creating User', 'try again');
    }

    async function modifyBalance() {
      const username = document.getElementById('bu').value;
      const amount = parseFloat(document.getElementById('ba').value);
      const res = await fetch('/api/admin/update-balance', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, amount })
      });
      if (res.ok) { fetchAdminUsers(); showPopup('Balance Updated!', 'OK'); }
      else showPopup('User Not Found', 'try again');
    }

    render();
  </script>
</body>
</html>
  `);
});

// ==========================================
// SERVER INITIALIZATION ENGINE
// ==========================================
const PORT = process.env.PORT || 10000;
const MONGO_URI = process.env.MONGODB_URI;

async function startServer() {
  if (!MONGO_URI) {
    console.error("CRITICAL ERROR: MONGODB_URI environment variable missing!");
    process.exit(1);
  }
  try {
    await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 5000 });
    console.log("MongoDB Connected Successfully");
    
    // Auto Create Default Admin Account
    const boss = await User.findOne({ username: 'Boss' });
    if (!boss) {
      const hashedPassword = await bcrypt.hash('BigBoss', 10);
      await User.create({ username: 'Boss', password: hashedPassword, role: 'admin', balance: 999999 });
      console.log("Default Admin Account Created: Boss / BigBoss");
    }

    server.listen(PORT, () => console.log(`Casino Server active on port ${PORT}`));
    startAviatorLoop();
  } catch (err) {
    console.error("Database connection failure:", err.message);
  }
}

startServer();
