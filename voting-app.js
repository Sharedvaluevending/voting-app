// voting-app.js
// ========================================
// Required Modules
const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const ejs = require('ejs');

const DATA_FILE = 'data.json';

// ========================================
// Data Initialization & Persistence
// ----------------------------------------
let data = {
  items: { snacks: [], drinks: [] },
  votes: { snacks: {}, drinks: {} },
  ipLogs: {},
  lastWinners: { snacks: [], drinks: [] },
  lastReset: new Date(),
  totalVotes: 0
};

function loadData() {
  if (fs.existsSync(DATA_FILE)) {
    try {
      const fileData = fs.readFileSync(DATA_FILE, 'utf8');
      data = JSON.parse(fileData);
      // Convert the lastReset string back into a Date object.
      data.lastReset = new Date(data.lastReset);
    } catch (err) {
      console.error("Error reading data file:", err);
    }
  }
}

function saveData() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error("Error writing data file:", err);
  }
}

loadData();

// ========================================
// Weekly Reset Logic
// ----------------------------------------
function checkWeeklyReset() {
  const now = new Date();
  const diffDays = (now - data.lastReset) / (1000 * 60 * 60 * 24);
  if (diffDays >= 7) {
    // Save last week's winners.
    data.lastWinners = {
      snacks: getTopItems('snacks', 3),
      drinks: getTopItems('drinks', 3)
    };
    // Reset votes and IP logs.
    data.votes = { snacks: {}, drinks: {} };
    ['snacks', 'drinks'].forEach(category => {
      data.items[category].forEach(item => {
        data.votes[category][item.id] = 0;
      });
    });
    data.ipLogs = {};
    data.totalVotes = 0;
    data.lastReset = now;
    saveData();
  }
}

// ========================================
// Helper: Get Top Items for a Category
// ----------------------------------------
function getTopItems(category, count) {
  let itemsWithVotes = data.items[category].map(item => ({
    ...item,
    votes: data.votes[category][item.id] || 0
  }));
  itemsWithVotes.sort((a, b) => b.votes - a.votes);
  return itemsWithVotes.slice(0, count);
}

// ========================================
// Middleware & Static Assets
// ----------------------------------------
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public')); // Place any static assets (CSS, images) in the 'public' folder

// ========================================
// Inline EJS Templates
// ----------------------------------------

// Main Voting Page Template
const indexTemplate = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Weekly Voting App</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 20px; }
    .container { max-width: 900px; margin: auto; }
    .category { margin-bottom: 40px; }
    .item { border: 1px solid #ccc; padding: 10px; margin: 5px 0; }
    form { display: inline; }
    button { cursor: pointer; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Weekly Voting App</h1>
    <p><strong>Total Votes This Week:</strong> <%= totalVotes %></p>
    
    <h2>Vote Now!</h2>
    <% ['snacks', 'drinks'].forEach(function(category) { %>
      <div class="category">
        <h3><%= category.charAt(0).toUpperCase() + category.slice(1) %></h3>
        <% if (items[category].length === 0) { %>
          <p>No items available in this category.</p>
        <% } else { %>
          <% items[category].forEach(function(item) { %>
            <div class="item">
              <span><strong><%= item.name %></strong> - $<%= item.price %></span>
              <span> | Votes: <%= votes[category][item.id] || 0 %></span>
              <form method="POST" action="/vote">
                <input type="hidden" name="category" value="<%= category %>">
                <input type="hidden" name="id" value="<%= item.id %>">
                <button type="submit">Vote</button>
              </form>
            </div>
          <% }); %>
        <% } %>
      </div>
    <% }); %>

    <h2>Current Top 3 Winners</h2>
    <% ['snacks', 'drinks'].forEach(function(category) { %>
      <div class="category">
        <h3><%= category.charAt(0).toUpperCase() + category.slice(1) %></h3>
        <% let topItems = getTopItems(category, 3); %>
        <% if(topItems.length === 0){ %>
          <p>No votes yet.</p>
        <% } else { %>
          <ol>
          <% topItems.forEach(function(item){ %>
            <li><%= item.name %> - $<%= item.price %> (<%= item.votes %> votes)</li>
          <% }); %>
          </ol>
        <% } %>
      </div>
    <% }); %>

    <h2>Last Week's Winners</h2>
    <% ['snacks', 'drinks'].forEach(function(category) { %>
      <div class="category">
        <h3><%= category.charAt(0).toUpperCase() + category.slice(1) %></h3>
        <% if(lastWinners[category].length === 0){ %>
          <p>No winner data available.</p>
        <% } else { %>
          <ol>
          <% lastWinners[category].forEach(function(item){ %>
            <li><%= item.name %> - $<%= item.price %> (<%= item.votes %> votes)</li>
          <% }); %>
          </ol>
        <% } %>
      </div>
    <% }); %>
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
    body { font-family: Arial, sans-serif; margin: 20px; }
    .container { max-width: 800px; margin: auto; }
    .item { border: 1px solid #ccc; padding: 10px; margin: 5px 0; }
    form { margin-bottom: 20px; }
    button { cursor: pointer; }
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
    <% ['snacks', 'drinks'].forEach(function(category){ %>
      <h3><%= category.charAt(0).toUpperCase() + category.slice(1) %></h3>
      <% if(items[category].length === 0){ %>
        <p>No items in this category.</p>
      <% } else { %>
        <ul>
        <% items[category].forEach(function(item){ %>
          <li class="item">
            <%= item.name %> - $<%= item.price %> 
            (Votes: <%= votes[category][item.id] || 0 %>)
            <form method="POST" action="/admin/remove?password=<%= password %>" style="display:inline;">
              <input type="hidden" name="category" value="<%= category %>">
              <input type="hidden" name="id" value="<%= item.id %>">
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

// ========================================
// Routes
// ----------------------------------------

// Main voting page
app.get('/', (req, res) => {
  checkWeeklyReset();
  const templateData = {
    items: data.items,
    votes: data.votes,
    totalVotes: data.totalVotes,
    lastWinners: data.lastWinners,
    getTopItems: getTopItems // Pass helper function to the template
  };
  const html = ejs.render(indexTemplate, templateData);
  res.send(html);
});

// Voting logic (with IP-based vote limiting)
app.post('/vote', (req, res) => {
  checkWeeklyReset();
  const category = req.body.category;
  const id = req.body.id;
  // Get the user's IP address
  const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
  
  // Initialize IP log if needed.
  if (!data.ipLogs[ip]) {
    data.ipLogs[ip] = {};
  }
  // Prevent multiple votes in the same category.
  if (data.ipLogs[ip][category]) {
    return res.send("You have already voted in this category this week.");
  }
  data.ipLogs[ip][category] = true;
  
  if (!data.votes[category][id]) {
    data.votes[category][id] = 0;
  }
  data.votes[category][id]++;
  data.totalVotes++;
  saveData();
  res.redirect('/');
});

// ----------------------
// Admin Panel Routes
// ----------------------

// GET admin panel with default password "snack" if not set.
app.get('/admin', (req, res) => {
  // Trim the environment variable value to remove any extra spaces.
  const adminPassword = (process.env.ADMIN_PASSWORD || 'snack').trim();
  const providedPassword = (req.query.password || '').trim();
  
  console.log("Admin password:", JSON.stringify(adminPassword));
  console.log("Provided password:", JSON.stringify(providedPassword));
  
  if (providedPassword !== adminPassword) {
    console.log("Password mismatch. Access denied.");
    return res.send("Unauthorized. Please access /admin?password=" + adminPassword);
  }
  
  console.log("Password match. Rendering admin panel.");
  const templateData = {
    items: data.items,
    votes: data.votes,
    password: adminPassword
  };
  const html = ejs.render(adminTemplate, templateData);
  res.send(html);
});

// POST: Add an item
app.post('/admin/add', (req, res) => {
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
  const newItem = { id: uuidv4(), name, price };
  data.items[category].push(newItem);
  data.votes[category][newItem.id] = 0;
  saveData();
  res.redirect('/admin?password=' + adminPassword);
});

// POST: Remove an item
app.post('/admin/remove', (req, res) => {
  const adminPassword = (process.env.ADMIN_PASSWORD || 'snack').trim();
  const providedPassword = (req.query.password || '').trim();
  if (providedPassword !== adminPassword) {
    return res.send("Unauthorized.");
  }
  const category = req.body.category;
  const id = req.body.id;
  if (!['snacks', 'drinks'].includes(category)) {
    return res.send("Invalid category.");
  }
  data.items[category] = data.items[category].filter(item => item.id !== id);
  delete data.votes[category][id];
  saveData();
  res.redirect('/admin?password=' + adminPassword);
});

// ========================================
// Start the Server
// ----------------------------------------
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
