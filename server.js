const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const axios = require('axios');
const { body, validationResult } = require('express-validator');
const rateLimit = require('express-rate-limit');
const redis = require('redis');
const winston = require('winston');
require('winston-mongodb');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 5000;

// Logger setup with Winston
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'combined.log' }),
    new winston.transports.MongoDB({
      db: process.env.MONGODB_URI || 'mongodb://localhost/rockefeller-finance',
      collection: 'logs',
      level: 'info'
    })
  ]
});
if (process.env.NODE_ENV !== 'production') {
  logger.add(new winston.transports.Console({
    format: winston.format.simple()
  }));
}

// Redis Client
let redisClient;
(async () => {
  try {
    redisClient = redis.createClient({
      url: process.env.REDIS_URL || 'redis://localhost:6379',
    });
    redisClient.on('error', (err) => logger.error('Redis error:', err));
    await redisClient.connect();
    logger.info('Connected to Redis');
  } catch (error) {
    logger.error('Failed to connect to Redis:', error);
    redisClient = null;
  }
})();

// Middleware
app.use(cors());
app.use(helmet());
app.use(express.json());
app.use(rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // 100 requests per IP
  message: { error: 'Quá nhiều yêu cầu, vui lòng thử lại sau 15 phút' }
}));

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost/rockefeller-finance', {
  useNewUrlParser: true,
  useUnifiedTopology: true,
}).then(() => logger.info('Connected to MongoDB'))
  .catch((err) => logger.error('MongoDB connection error:', err));

// MongoDB Schema
const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true, index: true },
  password: { type: String, required: true },
  initialBudget: { type: Number, default: 0 },
  expenses: [{
    amount: { type: Number, required: true },
    category: { type: String, required: true },
    date: { type: String, default: () => new Date().toLocaleDateString('vi-VN') },
    purpose: { type: String, required: true },
    location: { type: String, required: true },
  }],
  allocations: {
    essentials: { type: Number, default: 0 },
    savings: { type: Number, default: 0 },
    selfInvestment: { type: Number, default: 0 },
    charity: { type: Number, default: 0 },
    emergency: { type: Number, default: 0 },
  },
  investmentHistory: [{
    amount: Number,
    date: String,
    price: Number,
    type: String,
  }],
  refreshToken: String,
});
userSchema.index({ 'expenses.date': 1 });
userSchema.index({ 'investmentHistory.date': 1 });
const User = mongoose.model('User', userSchema);

// JWT Middleware
const authMiddleware = (req, res, next) => {
  const token = req.header('Authorization')?.replace('Bearer ', '');
  if (!token) {
    logger.warn('No token provided', { ip: req.ip });
    return res.status(401).json({ error: 'Không có quyền truy cập', code: 'NO_TOKEN' });
  }
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your_jwt_secret');
    req.user = decoded;
    next();
  } catch (error) {
    logger.warn('Invalid token', { ip: req.ip, token });
    return res.status(401).json({ error: 'Token không hợp lệ', code: 'INVALID_TOKEN' });
  }
};

// Retry Logic with Jitter
const fetchWithRetry = async (url, options = {}, retries = 3, backoff = 1000) => {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await axios.get(url, { timeout: 5000, ...options });
      return response.data;
    } catch (error) {
      if (i === retries - 1) throw error;
      if (error.response?.status === 429) {
        const jitter = Math.random() * 100;
        await new Promise(resolve => setTimeout(resolve, backoff * (i + 1) + jitter));
      }
    }
  }
};

// API Routes
app.post('/api/register', [
  body('username').isString().notEmpty().trim().isLength({ min: 3, max: 20 }),
  body('password').isLength({ min: 6 }),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    logger.warn('Register validation failed', { errors: errors.array() });
    return res.status(400).json({ errors: errors.array(), code: 'VALIDATION_ERROR' });
  }

  const { username, password } = req.body;
  try {
    const existingUser = await User.findOne({ username });
    if (existingUser) {
      logger.warn('Username already exists', { username });
      return res.status(400).json({ error: 'Tên người dùng đã tồn tại', code: 'USERNAME_EXISTS' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const user = new User({ username, password: hashedPassword });
    await user.save();
    logger.info('User registered', { username });
    res.status(201).json({ message: 'Đăng ký thành công' });
  } catch (error) {
    logger.error('Register error', { error: error.message });
    res.status(500).json({ error: 'Lỗi server', code: 'SERVER_ERROR' });
  }
});

app.post('/api/login', [
  body('username').isString().notEmpty().trim(),
  body('password').notEmpty(),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    logger.warn('Login validation failed', { errors: errors.array() });
    return res.status(400).json({ errors: errors.array(), code: 'VALIDATION_ERROR' });
  }

  const { username, password } = req.body;
  try {
    const user = await User.findOne({ username });
    if (!user || !(await bcrypt.compare(password, user.password))) {
      logger.warn('Invalid login credentials', { username });
      return res.status(401).json({ error: 'Thông tin đăng nhập không hợp lệ', code: 'INVALID_CREDENTIALS' });
    }

    const accessToken = jwt.sign({ id: user._id }, process.env.JWT_SECRET || 'your_jwt_secret', { expiresIn: '15m' });
    const refreshToken = jwt.sign({ id: user._id }, process.env.JWT_REFRESH_SECRET || 'your_refresh_secret', { expiresIn: '7d' });
    user.refreshToken = refreshToken;
    await user.save();
    logger.info('User logged in', { username });
    res.json({ accessToken, refreshToken, initialBudget: user.initialBudget });
  } catch (error) {
    logger.error('Login error', { error: error.message });
    res.status(500).json({ error: 'Lỗi server', code: 'SERVER_ERROR' });
  }
});

app.post('/api/refresh-token', async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) {
    logger.warn('No refresh token provided', { ip: req.ip });
    return res.status(401).json({ error: 'Không có refresh token', code: 'NO_REFRESH_TOKEN' });
  }

  try {
    const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET || 'your_refresh_secret');
    const user = await User.findById(decoded.id);
    if (!user || user.refreshToken !== refreshToken) {
      logger.warn('Invalid refresh token', { ip: req.ip });
      return res.status(401).json({ error: 'Refresh token không hợp lệ', code: 'INVALID_REFRESH_TOKEN' });
    }

    const accessToken = jwt.sign({ id: user._id }, process.env.JWT_SECRET || 'your_jwt_secret', { expiresIn: '15m' });
    logger.info('Token refreshed', { userId: user._id });
    res.json({ accessToken });
  } catch (error) {
    logger.error('Refresh token error', { error: error.message });
    res.status(401).json({ error: 'Refresh token không hợp lệ', code: 'INVALID_REFRESH_TOKEN' });
  }
});

app.post('/api/initial-budget', authMiddleware, [
  body('initialBudget').isFloat({ min: 0 }),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    logger.warn('Initial budget validation failed', { errors: errors.array() });
    return res.status(400).json({ errors: errors.array(), code: 'VALIDATION_ERROR' });
  }

  try {
    const user = await User.findById(req.user.id);
    const newBudget = parseFloat(req.body.initialBudget);
    user.initialBudget += newBudget;
    user.allocations = {
      essentials: user.allocations.essentials + newBudget * 0.5,
      savings: user.allocations.savings + newBudget * 0.2,
      selfInvestment: user.allocations.selfInvestment + newBudget * 0.15,
      charity: user.allocations.charity + newBudget * 0.05,
      emergency: user.allocations.emergency + newBudget * 0.1,
    };
    await user.save();
    logger.info('Initial budget updated', { userId: user._id, newBudget });
    res.json({ initialBudget: user.initialBudget, allocations: user.allocations });
  } catch (error) {
    logger.error('Initial budget error', { error: error.message });
    res.status(500).json({ error: 'Lỗi server', code: 'SERVER_ERROR' });
  }
});

app.get('/api/initial-budget', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    res.json({ initialBudget: user.initialBudget });
  } catch (error) {
    logger.error('Get initial budget error', { error: error.message });
    res.status(500).json({ error: 'Lỗi server', code: 'SERVER_ERROR' });
  }
});

app.get('/api/expenses', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    res.json(user.expenses);
  } catch (error) {
    logger.error('Get expenses error', { error: error.message });
    res.status(500).json({ error: 'Lỗi server', code: 'SERVER_ERROR' });
  }
});

app.post('/api/expenses', authMiddleware, [
  body('amount').isFloat({ min: 0 }),
  body('category').isString().notEmpty(),
  body('purpose').isString().notEmpty(),
  body('location').isString().notEmpty(),
  body('date').optional().isString(),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    logger.warn('Expense validation failed', { errors: errors.array() });
    return res.status(400).json({ errors: errors.array(), code: 'VALIDATION_ERROR' });
  }

  try {
    const user = await User.findById(req.user.id);
    const { amount, category, purpose, location, date } = req.body;
    const categoryKey = {
      'Tiêu dùng thiết yếu': 'essentials',
      'Tiết kiệm bắt buộc': 'savings',
      'Đầu tư bản thân': 'selfInvestment',
      'Từ thiện': 'charity',
      'Dự phòng linh hoạt': 'emergency',
    }[category];

    if (!categoryKey) {
      logger.warn('Invalid expense category', { category });
      return res.status(400).json({ error: 'Danh mục không hợp lệ', code: 'INVALID_CATEGORY' });
    }
    if (amount > user.allocations[categoryKey]) {
      logger.warn('Expense exceeds allocation', { category, amount, available: user.allocations[categoryKey] });
      return res.status(400).json({ 
        error: `Số tiền vượt quá ngân sách ${category} (${user.allocations[categoryKey]} VND)`, 
        code: 'INSUFFICIENT_ALLOCATION' 
      });
    }

    const newExpense = { 
      amount, 
      category, 
      purpose, 
      location, 
      date: date || new Date().toLocaleDateString('vi-VN') 
    };
    user.expenses.push(newExpense);
    user.initialBudget -= amount;
    user.allocations[categoryKey] -= amount;
    await user.save();
    logger.info('Expense added', { userId: user._id, expense: newExpense });
    res.json(user.expenses);
  } catch (error) {
    logger.error('Add expense error', { error: error.message });
    res.status(500).json({ error: 'Lỗi server', code: 'SERVER_ERROR' });
  }
});

app.delete('/api/expenses/:index', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    const index = parseInt(req.params.index);
    if (index < 0 || index >= user.expenses.length) {
      logger.warn('Invalid expense index', { index });
      return res.status(400).json({ error: 'Chỉ số chi tiêu không hợp lệ', code: 'INVALID_INDEX' });
    }
    const deletedExpense = user.expenses[index];
    const categoryKey = {
      'Tiêu dùng thiết yếu': 'essentials',
      'Tiết kiệm bắt buộc': 'savings',
      'Đầu tư bản thân': 'selfInvestment',
      'Từ thiện': 'charity',
      'Dự phòng linh hoạt': 'emergency',
    }[deletedExpense.category];
    user.initialBudget += deletedExpense.amount;
    user.allocations[categoryKey] += deletedExpense.amount;
    user.expenses.splice(index, 1);
    await user.save();
    logger.info('Expense deleted', { userId: user._id, index });
    res.json(user.expenses);
  } catch (error) {
    logger.error('Delete expense error', { error: error.message });
    res.status(500).json({ error: 'Lỗi server', code: 'SERVER_ERROR' });
  }
});

app.get('/api/allocations', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    res.json(user.allocations);
  } catch (error) {
    logger.error('Get allocations error', { error: error.message });
    res.status(500).json({ error: 'Lỗi server', code: 'SERVER_ERROR' });
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
  if (!errors.isEmpty()) {
    logger.warn('Allocation validation failed', { errors: errors.array() });
    return res.status(400).json({ errors: errors.array(), code: 'VALIDATION_ERROR' });
  }

  try {
    const user = await User.findById(req.user.id);
    user.allocations = req.body;
    await user.save();
    logger.info('Allocations updated', { userId: user._id, allocations: req.body });
    res.json(user.allocations);
  } catch (error) {
    logger.error('Update allocations error', { error: error.message });
    res.status(500).json({ error: 'Lỗi server', code: 'SERVER_ERROR' });
  }
});

app.delete('/api/account', authMiddleware, async (req, res) => {
  try {
    await User.findByIdAndDelete(req.user.id);
    logger.info('Account deleted', { userId: req.user.id });
    res.json({ message: 'Tài khoản đã được xóa' });
  } catch (error) {
    logger.error('Delete account error', { error: error.message });
    res.status(500).json({ error: 'Lỗi server', code: 'SERVER_ERROR' });
  }
});

app.delete('/api/budget', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    user.initialBudget = 0;
    user.allocations = {
      essentials: 0,
      savings: 0,
      selfInvestment: 0,
      charity: 0,
      emergency: 0,
    };
    user.expenses = [];
    user.investmentHistory = [];
    await user.save();
    logger.info('Budget reset', { userId: req.user.id });
    res.json({ message: 'Ngân sách đã được đặt lại' });
  } catch (error) {
    logger.error('Reset budget error', { error: error.message });
    res.status(500).json({ error: 'Lỗi server', code: 'SERVER_ERROR' });
  }
});

app.get('/api/investments', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    res.json(user.investmentHistory);
  } catch (error) {
    logger.error('Get investments error', { error: error.message });
    res.status(500).json({ error: 'Lỗi server', code: 'SERVER_ERROR' });
  }
});

app.post('/api/investments', authMiddleware, [
  body('amount').isFloat({ min: 0 }),
  body('price').isFloat({ min: 0 }),
  body('type').isString().notEmpty(),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    logger.warn('Investment validation failed', { errors: errors.array() });
    return res.status(400).json({ errors: errors.array(), code: 'VALIDATION_ERROR' });
  }

  try {
    const user = await User.findById(req.user.id);
    const investmentBudget = user.allocations.selfInvestment + user.allocations.emergency;
    const totalPortfolio = Object.values(user.allocations).reduce((sum, val) => sum + val, 0) + 
      user.investmentHistory.reduce((sum, inv) => sum + inv.amount, 0);
    const { amount, price, type } = req.body;

    if (amount > investmentBudget) {
      logger.warn('Investment exceeds budget', { amount, investmentBudget });
      return res.status(400).json({ 
        error: `Số tiền vượt quá ngân sách đầu tư (${investmentBudget} VND)`, 
        code: 'INSUFFICIENT_BUDGET' 
      });
    }
    if (totalPortfolio > 0 && amount / totalPortfolio > 0.1) {
      logger.warn('Investment exceeds 10% portfolio', { amount, totalPortfolio });
      return res.status(400).json({ 
        warning: 'Cảnh báo: Đầu tư nên chiếm dưới 10% tổng danh mục (*32 Lá Thư*)', 
        code: 'PORTFOLIO_RISK' 
      });
    }

    const newInvestment = { 
      amount, 
      date: new Date().toLocaleDateString('vi-VN'), 
      price, 
      type 
    };
    user.investmentHistory.push(newInvestment);
    user.allocations.selfInvestment -= amount;
    await user.save();
    logger.info('Investment added', { userId: user._id, investment: newInvestment });
    res.json(user.investmentHistory);
  } catch (error) {
    logger.error('Add investment error', { error: error.message });
    res.status(500).json({ error: 'Lỗi server', code: 'SERVER_ERROR' });
  }
});

app.delete('/api/investments/:index', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    const index = parseInt(req.params.index);
    if (index < 0 || index >= user.investmentHistory.length) {
      logger.warn('Invalid investment index', { index });
      return res.status(400).json({ error: 'Chỉ số giao dịch không hợp lệ', code: 'INVALID_INDEX' });
    }
    const deletedInvestment = user.investmentHistory[index];
    user.allocations.selfInvestment += deletedInvestment.amount;
    user.investmentHistory.splice(index, 1);
    await user.save();
    logger.info('Investment deleted', { userId: user._id, index });
    res.json(user.investmentHistory);
  } catch (error) {
    logger.error('Delete investment error', { error: error.message });
    res.status(500).json({ error: 'Lỗi server', code: 'SERVER_ERROR' });
  }
});

app.get('/api/bitcoin-price', async (req, res) => {
  const fallbackPrice = 117783.89; // Dynamic fallback should be updated periodically
  try {
    let cachedPrice;
    if (redisClient) {
      try {
        cachedPrice = await redisClient.get('bitcoin_price');
        if (cachedPrice) {
          logger.info('Bitcoin price from cache', { price: cachedPrice });
          return res.json({ price: parseFloat(cachedPrice) });
        }
      } catch (redisError) {
        logger.error('Redis get error', { error: redisError.message });
      }
    }

    // Try CoinGecko
    try {
      const data = await fetchWithRetry('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd');
      const price = data.bitcoin.usd;
      if (redisClient) {
        try {
          await redisClient.setEx('bitcoin_price', 300, price.toString());
          logger.info('Bitcoin price cached', { price });
        } catch (redisError) {
          logger.error('Redis set error', { error: redisError.message });
        }
      }
      return res.json({ price });
    } catch (coingeckoError) {
      logger.error('CoinGecko error', { error: coingeckoError.message });

      // Try CoinMarketCap
      if (process.env.CMC_API_KEY) {
        try {
          const cmcData = await fetchWithRetry(
            'https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest?symbol=BTC',
            { headers: { 'X-CMC_PRO_API_KEY': process.env.CMC_API_KEY } }
          );
          const price = cmcData.data.BTC.quote.USD.price;
          if (redisClient) {
            try {
              await redisClient.setEx('bitcoin_price', 300, price.toString());
              logger.info('Bitcoin price cached from CMC', { price });
            } catch (redisError) {
              logger.error('Redis set error', { error: redisError.message });
            }
          }
          return res.json({ price });
        } catch (cmcError) {
          logger.error('CoinMarketCap error', { error: cmcError.message });
        }
      }

      // Try Binance
      try {
        const binanceData = await fetchWithRetry('https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT');
        const price = parseFloat(binanceData.price);
        if (redisClient) {
          try {
            await redisClient.setEx('bitcoin_price', 300, price.toString());
            logger.info('Bitcoin price cached from Binance', { price });
          } catch (redisError) {
            logger.error('Redis set error', { error: redisError.message });
          }
        }
        return res.json({ price });
      } catch (binanceError) {
        logger.error('Binance error', { error: binanceError.message });
      }

      // Use fallback price
      logger.warn('Using fallback Bitcoin price', { price: fallbackPrice });
      return res.json({ price: fallbackPrice, warning: 'Không thể lấy giá Bitcoin từ API' });
    }
  } catch (error) {
    logger.error('Bitcoin price fetch error', { error: error.message });
    return res.status(500).json({ price: fallbackPrice, warning: 'Không thể lấy giá Bitcoin từ API', code: 'API_ERROR' });
  }
});

app.get('/api/bitcoin-history', async (req, res) => {
  try {
    if (redisClient) {
      try {
        const cachedHistory = await redisClient.get('bitcoin_history');
        if (cachedHistory) {
          logger.info('Bitcoin history from cache');
          return res.json(JSON.parse(cachedHistory));
        }
      } catch (redisError) {
        logger.error('Redis get error', { error: redisError.message });
      }
    }

    const data = await fetchWithRetry('https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=7');
    const prices = data.prices.map(([timestamp, price]) => ({
      date: new Date(timestamp).toISOString().split('T')[0],
      price,
    }));
    if (redisClient) {
      try {
        await redisClient.setEx('bitcoin_history', 300, JSON.stringify(prices));
        logger.info('Bitcoin history cached', { count: prices.length });
      } catch (redisError) {
        logger.error('Redis set error', { error: redisError.message });
      }
    }
    res.json(prices);
  } catch (error) {
    logger.error('Bitcoin history fetch error', { error: error.message });
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
    logger.warn('Using fallback Bitcoin history', { count: prices.length });
    res.json(prices);
  }
});

app.get('/api/investment-analysis', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    let currentPrice;
    try {
      const priceData = await fetchWithRetry('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd');
      currentPrice = priceData.bitcoin.usd;
    } catch (error) {
      logger.error('Investment analysis price fetch error', { error: error.message });
      currentPrice = 117783.89;
    }

    const totalInvested = user.investmentHistory.reduce((sum, inv) => sum + inv.amount, 0);
    const currentValue = user.investmentHistory.reduce((sum, inv) => {
      if (inv.type.toLowerCase().includes('bitcoin')) {
        return sum + (inv.amount / inv.price) * currentPrice;
      }
      return sum + inv.amount;
    }, 0);
    const roi = totalInvested > 0 ? ((currentValue - totalInvested) / totalInvested) * 100 : 0;

    const portfolioRatio = totalInvested > 0 ? totalInvested / (totalInvested + Object.values(user.allocations).reduce((sum, val) => sum + val, 0)) : 0;
    const recommendations = [];
    if (portfolioRatio > 0.1) {
      recommendations.push('Đa dạng hóa danh mục: Đầu tư chiếm hơn 10% tổng tài sản (*32 Lá Thư*).');
    }
    if (user.allocations.savings < user.initialBudget * 0.2) {
      recommendations.push('Tăng phân bổ tiết kiệm lên ít nhất 20% ngân sách ban đầu (*32 Lá Thư*).');
    }

    res.json({
      totalInvested,
      currentValue,
      roi: parseFloat(roi.toFixed(2)),
      recommendations
    });
  } catch (error) {
    logger.error('Investment analysis error', { error: error.message });
    res.status(500).json({ error: 'Lỗi server', code: 'SERVER_ERROR' });
  }
});

app.get('/api/ping', (req, res) => {
  const health = {
    status: 'ok',
    uptime: process.uptime(),
    mongodb: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    redis: redisClient?.isOpen ? 'connected' : 'disconnected'
  };
  res.json(health);
});

// Error Handling Middleware
app.use((err, req, res, next) => {
  logger.error('Unhandled error', { error: err.message, stack: err.stack });
  res.status(500).json({ error: 'Lỗi server không xác định', code: 'UNHANDLED_ERROR' });
});

// Start Server
app.listen(port, () => logger.info(`Server running on port ${port}`));