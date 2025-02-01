// voting-app.js
// ====================================================
// REQUIRED MODULES
// ====================================================
const express = require('express');
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid'); // For generating unique IDs if needed
const ejs = require('ejs');

const app = express();
const PORT = process.env.PORT || 3000;

// ====================================================
// MONGODB CONNECTION SETUP
// ====================================================
// Set the MONGODB_URI environment variable on your deployment (e.g., on Render).
const mongoURI = process.env.MONGODB_URI || 'your_default_connection_string_here';
mongoose.connect(mongoURI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log('Connected to MongoDB Atlas'))
  .catch(err => console.error('MongoDB connection error:', err));

// ====================================================
// MONGOOSE SCHEMAS AND MODELS
// ====================================================

// Item Schema: Represents an item (e.g., a snack or drink) that can be voted on.
const itemSchema = new mongoose.Schema({
  category: { type: String, enum: ['snacks', 'drinks'], required: true },
  name: { type: String, required: true },
  price: { type: Number, required: true },
  votes: { type: Number, default: 0 }
});
const Item = mongoose.model('Item', itemSchema);

// VoteLog Schema: Records that an IP address has voted in a given category.
const voteLogSchema = new mongoose.Schema({
  ip: { type: String, required: true },
  category: { type: String, required: true },
  votedAt: { type: Date, default: Date.now }
});
const VoteLog = mongoose.model('VoteLog', voteLogSchema);

// ====================================================
// MIDDLEWARE & STATIC ASSETS
// ====================================================
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Middleware to remove X-Frame-Options (for iframe embedding)
app.use((req, res, next) => {
  res.removeHeader("X-Frame-Options");
  next();
});

// ====================================================
// INLINE EJS TEMPLATES WITH FULL-SCREEN CSS
// ====================================================

// MAIN VOTING PAGE TEMPLATE
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
  </div>
</body>
</html>
`;

// ADMIN PANEL TEMPLATE
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
// HELPER FUNCTIONS FOR FETCHING DATA
// ====================================================

// Fetch items grouped by category from MongoDB
async function fetchItemsByCategory() {
  const categories = ['snacks', 'drinks'];
  const itemsByCategory = {};
  for (const category of categories) {
    const items = await Item.find({ category }).lean();
    itemsByCategory[category] = items;
  }
  return { categories, items: itemsByCategory };
}

// Compute total votes across all categories
async function computeTotalVotes() {
  const { categories, items } = await fetchItemsByCategory();
  let totalVotes = 0;
  for (const category of categories) {
    items[category].forEach(item => totalVotes += item.votes);
  }
  return totalVotes;
}

// ====================================================
// ROUTES
// ====================================================

// Test Route to verify deployment
app.get('/test', (req, res) => {
  res.send('Hello, this is a test route!');
});

// MAIN VOTING PAGE ROUTE
app.get('/', async (req, res) => {
  try {
    const { categories, items } = await fetchItemsByCategory();
    const totalVotes = await computeTotalVotes();
    const html = ejs.render(indexTemplate, { categories, items, totalVotes });
    res.send(html);
  } catch (err) {
    console.error(err);
    res.status(500).send("Error loading voting page.");
  }
});

// VOTE ROUTE WITH IP-BASED LIMITING AND DEBUG LOGGING
app.post('/vote', async (req, res) => {
  const category = req.body.category;
  const itemId = req.body.id;
  
  // Extract the IP address; handle multiple IPs if present
  let ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
  if (ip && ip.indexOf(',') !== -1) {
    ip = ip.split(',')[0].trim();
  }
  
  // Debug: log the captured IP address
  console.log("Voter IP:", ip);
  
  // Determine the time threshold (one week ago)
  const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  
  // Check if a vote from this IP in this category exists within the last week
  const existingVote = await VoteLog.findOne({ 
    ip, 
    category, 
    votedAt: { $gte: oneWeekAgo }
  });
  
  // Debug: log the existing vote result (if any)
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

// ADMIN PANEL GET ROUTE
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

// ADMIN ADD ITEM POST ROUTE
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

// ADMIN REMOVE ITEM POST ROUTE
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
