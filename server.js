const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const connectDB = require('./config/db');
const { connectRedis } = require('./config/redis');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 5000;

// Connect to Databases
connectDB();
connectRedis();

// Middleware
app.use(cors());
app.use(helmet());
app.use(express.json());

// Routes
app.use('/api', require('./routes/authRoutes'));
app.use('/api', require('./routes/userRoutes'));
app.use('/api', require('./routes/bitcoinRoutes'));

// Health check
app.get('/api/ping', (req, res) => res.json({ status: 'ok' }));

// Start server
app.listen(port, () => {
  console.log(`Server chạy trên cổng ${port} (MVC version)`);
});

// Trigger redeployment to Render