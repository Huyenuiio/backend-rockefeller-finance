const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const { body, validationResult } = require('express-validator');
const redis = require('redis');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 5000;

// Redis Client
const redisClient = redis.createClient({
  url: process.env.REDIS_URL || 'redis://localhost:6379',
});
redisClient.on('error', (err) => console.error('Lỗi Redis:', err));
redisClient.connect();

// Middleware
app.use(cors());
app.use(helmet());
app.use(express.json());

// Kết nối MongoDB Atlas
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost/rockefeller-finance', {
  useNewUrlParser: true,
  useUnifiedTopology: true,
}).then(() => console.log('Đã kết nối MongoDB'))
  .catch((err) => console.error('Lỗi kết nối MongoDB:', err));

// Schema người dùng
const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  allocations: {
    essentials: { type: Number, default: 0 },
    savings: { type: Number, default: 0 },
    selfInvestment: { type: Number, default: 0 },
    charit: { type: Number, default: 0 },
    emergency: { type: Number, default: 0 },
  },
  investmentHistory: [{
    amount: Number,
    date: String,
    price: Number,
    type: String,
  }],
});
const User = mongoose.model('User', userSchema);

// Middleware xác thực JWT
const authMiddleware = (req, res, next) => {
  const token = req.header('Authorization')?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Không có quyền truy cập' });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your_jwt_secret');
    req.user = decoded;
    next();
  } catch (error) {
    res.status(401).json({ error: 'Token không hợp lệ' });
  }
};

// Retry logic cho API
const fetchWithRetry = async (url, retries = 3) => {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await axios.get(url);
      if (response.status !== 200) throw new Error('Lỗi API');
      return response.data;
    } catch (error) {
      if (i === retries - 1) throw error;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
};

// API Routes
app.post('/api/register', [
  body('username').isString().notEmpty(),
  body('password').isLength({ min: 6 }),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { username, password } = req.body;
  try {
    const existingUser = await User.findOne({ username });
    if (existingUser) return res.status(400).json({ error: 'Tên người dùng đã tồn tại' });

    const user = new User({ username, password }); // Thay bằng bcrypt trong sản xuất
    await user.save();
    res.status(201).json({ message: 'Đăng ký thành công' });
  } catch (error) {
    res.status(500).json({ error: 'Lỗi server' });
  }
});

app.post('/api/login', [
  body('username').isString().notEmpty(),
  body('password').notEmpty(),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { username, password } = req.body;
  try {
    const user = await User.findOne({ username });
    if (!user || user.password !== password) return res.status(401).json({ error: 'Thông tin đăng nhập không hợp lệ' });

    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET || 'your_jwt_secret', { expiresIn: '1h' });
    res.json({ token });
  } catch (error) {
    res.status(500).json({ error: 'Lỗi server' });
  }
});

app.get('/api/allocations', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    res.json(user.allocations);
  } catch (error) {
    res.status(500).json({ error: 'Lỗi server' });
  }
});

app.post('/api/allocations', authMiddleware, [
  body('essentials').isFloat({ min: 0 }),
  body('savings').isFloat({ min: 0 }),
  body('selfInvestment').isFloat({ min: 0 }),
  body('charity').isFloat({ min: 0 }),
  body('emergency').isFloat({ min: 0 }),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  try {
    const user = await User.findById(req.user.id);
    user.allocations = req.body;
    await user.save();
    res.json(user.allocations);
  } catch (error) {
    res.status(500).json({ error: 'Lỗi server' });
  }
});

app.get('/api/investments', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    res.json(user.investmentHistory);
  } catch (error) {
    res.status(500).json({ error: 'Lỗi server' });
  }
});

app.post('/api/investments', authMiddleware, [
  body('amount').isFloat({ min: 0 }),
  body('price').isFloat({ min: 0 }),
  body('type').isString().notEmpty(),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  try {
    const user = await User.findById(req.user.id);
    const investmentBudget = user.allocations.selfInvestment + user.allocations.emergency;
    const totalPortfolio = Object.values(user.allocations).reduce((sum, val) => sum + val, 0);
    const { amount, price, type } = req.body;

    if (amount > investmentBudget) {
      return res.status(400).json({ error: `Số tiền vượt quá ngân sách đầu tư (${investmentBudget} VND)` });
    }
    if (amount / totalPortfolio > 0.1) {
      return res.status(400).json({ warning: 'Cảnh báo: Đầu tư Bitcoin ETF nên chiếm dưới 10% tổng danh mục' });
    }

    const newInvestment = { amount, date: new Date().toLocaleString('vi-VN'), price, type };
    user.investmentHistory.push(newInvestment);
    await user.save();
    res.json(user.investmentHistory);
  } catch (error) {
    res.status(500).json({ error: 'Lỗi server' });
  }
});

app.delete('/api/investments/:index', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    const index = parseInt(req.params.index);
    if (index < 0 || index >= user.investmentHistory.length) {
      return res.status(400).json({ error: 'Chỉ số giao dịch không hợp lệ' });
    }
    user.investmentHistory.splice(index, 1);
    await user.save();
    res.json(user.investmentHistory);
  } catch (error) {
    res.status(500).json({ error: 'Lỗi server' });
  }
});

app.get('/api/bitcoin-price', async (req, res) => {
  try {
    const cachedPrice = await redisClient.get('bitcoin_price');
    if (cachedPrice) return res.json({ price: parseFloat(cachedPrice) });

    const data = await fetchWithRetry('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd');
    const price = data.bitcoin.usd;
    await redisClient.setEx('bitcoin_price', 300, price.toString()); // Cache 5 phút
    res.json({ price });
  } catch (error) {
    console.error('Lỗi khi lấy giá Bitcoin:', error);
    res.status(500).json({ error: 'Không thể lấy giá Bitcoin', fallbackPrice: 117783.89 });
  }
});

app.get('/api/bitcoin-history', async (req, res) => {
  try {
    const cachedHistory = await redisClient.get('bitcoin_history');
    if (cachedHistory) return res.json(JSON.parse(cachedHistory));

    const data = await fetchWithRetry('https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=7');
    const prices = data.prices.map(([timestamp, price]) => ({
      date: new Date(timestamp).toISOString().split('T')[0],
      price,
    }));
    await redisClient.setEx('bitcoin_history', 300, JSON.stringify(prices)); // Cache 5 phút
    res.json(prices);
  } catch (error) {
    console.error('Lỗi khi lấy lịch sử giá Bitcoin:', error);
    const today = new Date();
    const prices = [];
    for (let i = 6; i >= 0; i--) {
      const date = new Date(today);
      date.setDate(today.getDate() - i);
      prices.push({
        date: date.toISOString().split('T')[0],
        price: 117783.89 * (1 + (Math.random() - 0.5) * 0.1),
      });
    }
    res.json(prices);
  }
});


// Route để giám sát uptime
app.get('/api/ping', (req, res) => res.json({ status: 'ok' }));






// Khởi động server
app.listen(port, () => console.log(`Server chạy trên cổng ${port}`));
