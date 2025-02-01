// voting-app.js
// ====================================================
// REQUIRED MODULES
// ====================================================
const express = require('express');
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid'); // Optional for generating unique IDs if needed
const ejs = require('ejs');

const app = express();
const PORT = process.env.PORT || 3000;

// ====================================================
// MONGODB CONNECTION SETUP
// ====================================================
const mongoURI = process.env.MONGODB_URI || 'mongodb+srv://sharedvaluevending:KTwSLX9PeeaXIXME@cluster0.1blpa.mongodb.net/votingApp?retryWrites=true&w=majority&appName=Cluster0';

mongoose.connect(mongoURI)
  .then(() => console.log('Connected to MongoDB Atlas'))
  .catch(err => console.error('MongoDB connection error:', err));

// ====================================================
// MONGOOSE SCHEMAS AND MODELS
// ====================================================

// Item Schema: Represents a voting item.
const itemSchema = new mongoose.Schema({
  category: { type: String, enum: ['snacks', 'drinks'], required: true },
  name: { type: String, required: true },
  price: { type: Number, required: true },
  votes: { type: Number, default: 0 }
});
const Item = mongoose.model('Item', itemSchema);

// VoteLog Schema: Records that an IP has voted in a category.
const voteLogSchema = new mongoose.Schema({
  ip: { type: String, required: true },
  category: { type: String, required: true },
  votedAt: { type: Date, default: Date.now }
});
const VoteLog = mongoose.model('VoteLog', voteLogSchema);

// ResetSetting Schema: Stores the timestamp of the last weekly reset.
const resetSettingSchema = new mongoose.Schema({
  lastReset: { type: Date, default: Date.now }
});
const ResetSetting = mongoose.model('ResetSetting', resetSettingSchema);

// Winner Schema: Stores last week's winners for a category.
const winnerSchema = new mongoose.Schema({
  category: { type: String, required: true },
  winners: [{
    name: String,
    price: Number,
    votes: Number
  }],
  weekStart: { type: Date, default: Date.now }
});
const Winner = mongoose.model('Winner', winnerSchema);

// ====================================================
// MIDDLEWARE & STATIC ASSETS
// ====================================================
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Remove X-Frame-Options header (for iframe embedding)
app.use((req, res, next) => {
  res.removeHeader("X-Frame-Options");
  next();
});

// ====================================================
// INLINE EJS TEMPLATES WITH FULL-SCREEN CSS
// ====================================================

// Main Voting Page Template
// Now includes a section for "Last Week's Winners"
const indexTemplate = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Weekly Voting App</title>
  <style>
    html, body {
      height: 100%;
      margin: 0;
      padding: 0;
    }
    .container {
      width: 100%;
      max-width: 900px;
      margin: 0 auto;
      min-height: 100vh;
      box-sizing: border-box;
      padding: 20px;
    }
    body {
      overflow-x: hidden;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>Weekly Voting App</h1>
    <p><strong>Total Votes This Week:</strong> <%= totalVotes %></p>
    <h2>Vote Now!</h2>
    <% categories.forEach(function(category) { %>
      <div class="category">
        <h3><%= category.charAt(0).toUpperCase() + category.slice(1) %></h3>
        <% if (!items[category] || items[category].length === 0) { %>
          <p>No items available in this category.</p>
        <% } else { %>
          <% items[category].forEach(function(item) { %>
            <div class="item">
              <span><strong><%= item.name %></strong> - $<%= item.price %></span>
              <span> | Votes: <%= item.votes %></span>
              <form method="POST" action="/vote">
                <input type="hidden" name="category" value="<%= category %>">
                <input type="hidden" name="id" value="<%= item._id %>">
                <button type="submit">Vote</button>
              </form>
            </div>
          <% }); %>
        <% } %>
      </div>
    <% }); %>
    <h2>Last Week's Winners</h2>
    <% if (winners.length === 0) { %>
      <p>No winners recorded yet.</p>
    <% } else { %>
      <% winners.forEach(function(winner) { %>
        <h3><%= winner.category.charAt(0).toUpperCase() + winner.category.slice(1) %></h3>
        <% if (winner.winners.length === 0) { %>
          <p>No winners for this category.</p>
        <% } else { %>
          <ol>
            <% winner.winners.forEach(function(item) { %>
              <li><%= item.name %> - $<%= item.price %> (Votes: <%= item.votes %>)</li>
            <% }); %>
          </ol>
        <% } %>
      <% }); %>
    <% } %>
  </div>
</body>
</html>
`;

// Admin Panel Template
const adminTemplate = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Admin Panel - Voting App</title>
  <style>
    html, body {
      height: 100%;
      margin: 0;
      padding: 0;
    }
    .container {
      width: 100%;
      max-width: 800px;
      margin: 0 auto;
      min-height: 100vh;
      box-sizing: border-box;
      padding: 20px;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>Admin Panel</h1>
    <h2>Add New Item</h2>
    <form method="POST" action="/admin/add?password=<%= password %>">
      <label>Category:
        <select name="category">
          <option value="snacks">Snacks</option>
          <option value="drinks">Drinks</option>
        </select>
      </label><br><br>
      <label>Name: <input type="text" name="name" required></label><br><br>
      <label>Price: <input type="number" step="0.01" name="price" required></label><br><br>
      <button type="submit">Add Item</button>
    </form>
    <h2>Current Items</h2>
    <% categories.forEach(function(category) { %>
      <h3><%= category.charAt(0).toUpperCase() + category.slice(1) %></h3>
      <% if (!items[category] || items[category].length === 0) { %>
        <p>No items in this category.</p>
      <% } else { %>
        <ul>
          <% items[category].forEach(function(item) { %>
            <li class="item">
              <%= item.name %> - $<%= item.price %> (Votes: <%= item.votes %>)
              <form method="POST" action="/admin/remove?password=<%= password %>" style="display:inline;">
                <input type="hidden" name="id" value="<%= item._id %>">
                <button type="submit">Remove</button>
              </form>
            </li>
          <% }); %>
        </ul>
      <% } %>
    <% }); %>
    <p><a href="/">Back to Voting</a></p>
  </div>
</body>
</html>
`;

// ====================================================
// HELPER FUNCTIONS FOR DATA RETRIEVAL & WEEKLY RESET
// ====================================================

// Check if a week has passed since the last reset; if yes, compute winners and reset votes.
async function checkWeeklyReset() {
  const oneWeekInMs = 7 * 24 * 60 * 60 * 1000;
  let setting = await ResetSetting.findOne();
  const now = new Date();

  if (!setting) {
    // Create a new reset setting if none exists
    setting = new ResetSetting({ lastReset: now });
    await setting.save();
    return;
  }

  if (now - setting.lastReset >= oneWeekInMs) {
    console.log("Weekly reset triggered.");
    const categories = ['snacks', 'drinks'];

    // For each category, compute top 3 winners
    for (const category of categories) {
      // Find top 3 items sorted by votes descending
      const topItems = await Item.find({ category }).sort({ votes: -1 }).limit(3).lean();

      // Upsert (insert or update) the Winner document for this category
      await Winner.findOneAndUpdate(
        { category },
        { winners: topItems, weekStart: setting.lastReset },
        { upsert: true, new: true }
      );

      // Reset the vote counts for items in this category (set votes to 0)
      await Item.updateMany({ category }, { votes: 0 });
    }

    // Optionally, you might clear the VoteLog collection:
    // await VoteLog.deleteMany({});

    // Update the lastReset timestamp
    setting.lastReset = now;
    await setting.save();
  }
}

// ====================================================
// ROUTES
// ====================================================

// Test Route to verify deployment
app.get('/test', (req, res) => {
  res.send('Hello, this is a test route!');
});

// Main Voting Page Route
app.get('/', async (req, res) => {
  try {
    // Check if a weekly reset is needed
    await checkWeeklyReset();

    // Fetch items and winners
    const { categories, items } = await fetchItemsByCategory();
    const totalVotes = await computeTotalVotes();
    const winners = await Winner.find({}).lean();

    const html = ejs.render(indexTemplate, { categories, items, totalVotes, winners });
    res.send(html);
  } catch (err) {
    console.error(err);
    res.status(500).send("Error loading voting page.");
  }
});

// Vote Route with IP-based Limiting and Debug Logging
app.post('/vote', async (req, res) => {
  const category = req.body.category;
  const itemId = req.body.id;
  
  // Extract IP address and handle multiple IPs if present
  let ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
  if (ip && ip.indexOf(',') !== -1) {
    ip = ip.split(',')[0].trim();
  }
  
  console.log("Voter IP:", ip);
  
  // Define one week ago for vote limitation
  const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  
  // Check if this IP has already voted in this category in the last week
  const existingVote = await VoteLog.findOne({ 
    ip, 
    category, 
    votedAt: { $gte: oneWeekAgo }
  });
  
  console.log("Existing vote:", existingVote);
  
  if (existingVote) {
    return res.send("You have already voted in this category this week.");
  }
  
  // Increment the vote count for the item
  await Item.findByIdAndUpdate(itemId, { $inc: { votes: 1 } });
  
  // Record this vote in VoteLog
  const voteEntry = new VoteLog({ ip, category });
  await voteEntry.save();
  
  res.redirect('/');
});

// Admin Panel GET Route
app.get('/admin', async (req, res) => {
  const adminPassword = (process.env.ADMIN_PASSWORD || 'snack').trim();
  const providedPassword = (req.query.password || '').trim();
  if (providedPassword !== adminPassword) {
    return res.send("Unauthorized. Please access /admin?password=" + adminPassword);
  }
  try {
    const { categories, items } = await fetchItemsByCategory();
    const html = ejs.render(adminTemplate, { categories, items, password: adminPassword });
    res.send(html);
  } catch (err) {
    console.error(err);
    res.status(500).send("Error loading admin panel.");
  }
});

// Admin Add Item POST Route
app.post('/admin/add', async (req, res) => {
  const adminPassword = (process.env.ADMIN_PASSWORD || 'snack').trim();
  const providedPassword = (req.query.password || '').trim();
  if (providedPassword !== adminPassword) {
    return res.send("Unauthorized.");
  }
  const category = req.body.category;
  const name = req.body.name;
  const price = parseFloat(req.body.price);
  if (!['snacks', 'drinks'].includes(category)) {
    return res.send("Invalid category.");
  }
  const newItem = new Item({ category, name, price, votes: 0 });
  await newItem.save();
  res.redirect('/admin?password=' + adminPassword);
});

// Admin Remove Item POST Route
app.post('/admin/remove', async (req, res) => {
  const adminPassword = (process.env.ADMIN_PASSWORD || 'snack').trim();
  const providedPassword = (req.query.password || '').trim();
  if (providedPassword !== adminPassword) {
    return res.send("Unauthorized.");
  }
  const itemId = req.body.id;
  await Item.findByIdAndRemove(itemId);
  res.redirect('/admin?password=' + adminPassword);
});

// ====================================================
// START THE SERVER
// ====================================================
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
