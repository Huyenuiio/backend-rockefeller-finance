const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const { body, validationResult } = require('express-validator');
const redis = require('redis');
require('dotenv').config();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));


const app = express();
const port = process.env.PORT || 5000;

// Redis Client
let redisClient;
(async () => {
  try {
    redisClient = redis.createClient({
      url: process.env.REDIS_URL || 'redis://localhost:6379',
    });
    redisClient.on('error', (err) => console.error('Lỗi Redis:', err));
    await redisClient.connect();
    console.log('Đã kết nối Redis');
  } catch (error) {
    console.error('Không thể kết nối Redis:', error);
    redisClient = null;
  }
})();

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

// fix bitcoin
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) {
    console.error('No token provided');
    return res.status(401).json({ error: 'Không có quyền truy cập: Thiếu token' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = { userId: decoded.id };
    next();
  } catch (error) {
    console.error('Token verification failed:', {
      message: error.message,
      token,
    });
    return res.status(401).json({ error: 'Không có quyền truy cập: Token không hợp lệ hoặc đã hết hạn' });
  }
};















// Schema người dùng
const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
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
const fetchWithRetry = async (url, retries = 3, backoff = 1000) => {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await axios.get(url, { timeout: 5000 });
      return response.data;
    } catch (error) {
      if (i === retries - 1) throw error;
      if (error.response?.status === 429) {
        await delay(backoff * (i + 1));
      }
    }
  }
};

// API Routes
app.post('/api/register', [
  body('username').isString().notEmpty().trim(),
  body('password').isLength({ min: 6 }),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { username, password } = req.body;
  try {
    const existingUser = await User.findOne({ username });
    if (existingUser) return res.status(400).json({ error: 'Tên người dùng đã tồn tại' });

    const user = new User({ username, password });
    await user.save();
    res.status(201).json({ message: 'Đăng ký thành công' });
  } catch (error) {
    console.error('Lỗi đăng ký:', error);
    res.status(500).json({ error: 'Lỗi server' });
  }
});

app.post('/api/login', [
  body('username').isString().notEmpty().trim(),
  body('password').notEmpty(),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { username, password } = req.body;
  try {
    const user = await User.findOne({ username });
    if (!user || user.password !== password) return res.status(401).json({ error: 'Thông tin đăng nhập không hợp lệ' });

    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET || 'your_jwt_secret', { expiresIn: '1h' });
    res.json({ token, initialBudget: user.initialBudget });
  } catch (error) {
    console.error('Lỗi đăng nhập:', error);
    res.status(500).json({ error: 'Lỗi server' });
  }
});

app.post('/api/initial-budget', authMiddleware, [
  body('initialBudget').isFloat({ min: 0 }),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

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
    res.json({ initialBudget: user.initialBudget, allocations: user.allocations });
  } catch (error) {
    console.error('Lỗi cập nhật ngân sách ban đầu:', error);
    res.status(500).json({ error: 'Lỗi server' });
  }
});

app.get('/api/initial-budget', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    res.json({ initialBudget: user.initialBudget });
  } catch (error) {
    console.error('Lỗi lấy ngân sách ban đầu:', error);
    res.status(500).json({ error: 'Lỗi server' });
  }
});

app.get('/api/expenses', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    res.json(user.expenses);
  } catch (error) {
    console.error('Lỗi lấy chi tiêu:', error);
    res.status(500).json({ error: 'Lỗi server' });
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
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

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

    if (!categoryKey) return res.status(400).json({ error: 'Danh mục không hợp lệ' });
    if (amount > user.allocations[categoryKey]) {
      return res.status(400).json({ error: `Số tiền vượt quá ngân sách ${category} (${user.allocations[categoryKey]} VND)` });
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
    res.json(user.expenses);
  } catch (error) {
    console.error('Lỗi thêm chi tiêu:', error);
    res.status(500).json({ error: 'Lỗi server' });
  }
});

app.delete('/api/expenses/:index', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    const index = parseInt(req.params.index);
    if (index < 0 || index >= user.expenses.length) {
      return res.status(400).json({ error: 'Chỉ số chi tiêu không hợp lệ' });
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
    res.json(user.expenses);
  } catch (error) {
    console.error('Lỗi xóa chi tiêu:', error);
    res.status(500).json({ error: 'Lỗi server' });
  }
});

app.get('/api/allocations', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    res.json(user.allocations);
  } catch (error) {
    console.error('Lỗi lấy phân bổ:', error);
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
    console.error('Lỗi cập nhật phân bổ:', error);
    res.status(500).json({ error: 'Lỗi server' });
  }
});

app.delete('/api/account', authMiddleware, async (req, res) => {
  try {
    await User.findByIdAndDelete(req.user.id);
    res.json({ message: 'Tài khoản đã được xóa' });
  } catch (error) {
    console.error('Lỗi xóa tài khoản:', error);
    res.status(500).json({ error: 'Lỗi server' });
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
    await user.save();
    res.json({ message: 'Ngân sách đã được đặt lại' });
  } catch (error) {
    console.error('Lỗi đặt lại ngân sách:', error);
    res.status(500).json({ error: 'Lỗi server' });
  }
});

app.get('/api/investments', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    res.json(user.investmentHistory);
  } catch (error) {
    console.error('Lỗi lấy đầu tư:', error);
    res.status(500).json({ error: 'Lỗi server' });
  }
});

app.post('/api/investments', authenticateToken, async (req, res) => {
  try {
    const { amount, price, type } = req.body;
    if (!amount || !price || !type) {
      return res.status(400).json({ error: 'Thiếu thông tin: amount, price, type là bắt buộc' });
    }
    if (isNaN(amount) || amount <= 0) {
      return res.status(400).json({ error: 'Số tiền phải là số dương' });
    }
    if (isNaN(price) || price <= 0) {
      return res.status(400).json({ error: 'Giá phải là số dương' });
    }
    if (!['Bitcoin ETF', 'Vàng', 'Chứng khoán'].includes(type)) {
      return res.status(400).json({ error: 'Loại đầu tư không hợp lệ' });
    }

    const user = await User.findById(req.user.userId);
    if (!user) {
      console.error('User not found:', req.user.userId);
      return res.status(404).json({ error: 'Không tìm thấy người dùng' });
    }

    const newInvestment = {
      amount: parseFloat(amount),
      price: parseFloat(price),
      type,
      date: new Date().toISOString().split('T')[0]
    };
    user.investments.push(newInvestment);
    await user.save();

    res.json(user.investments);
  } catch (error) {
    console.error('Lỗi thêm đầu tư:', {
      message: error.message,
      stack: error.stack,
      requestBody: req.body,
      userId: req.user.userId
    });
    if (error instanceof mongoose.Error) {
      return res.status(500).json({ error: 'Lỗi cơ sở dữ liệu' });
    }
    res.status(500).json({ error: 'Lỗi server khi thêm đầu tư' });
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
    console.error('Lỗi xóa đầu tư:', error);
    res.status(500).json({ error: 'Lỗi server' });
  }
});

app.get('/api/bitcoin-price', async (req, res) => {
  const fallbackPrice = 117783.89; // Hardcoded fallback as per original code
  try {
    // Check Redis cache
    let cachedPrice;
    if (redisClient) {
      try {
        cachedPrice = await redisClient.get('bitcoin_price');
        if (cachedPrice) {
          return res.json({ price: parseFloat(cachedPrice) });
        }
      } catch (redisError) {
        console.error('Redis error:', redisError.message);
      }
    }

    // Try CoinGecko
    try {
      const data = await fetchWithRetry('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd');
      const price = data.bitcoin.usd;
      if (redisClient) {
        try {
          await redisClient.setEx('bitcoin_price', 300, price.toString());
        } catch (redisError) {
          console.error('Redis set error:', redisError.message);
        }
      }
      return res.json({ price });
    } catch (coingeckoError) {
      console.error('CoinGecko error:', coingeckoError.message);

      // Fallback to CoinMarketCap (requires API key)
      if (process.env.CMC_API_KEY) {
        try {
          const cmcData = await fetchWithRetry(
            'https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest?symbol=BTC',
            {
              headers: { 'X-CMC_PRO_API_KEY': process.env.CMC_API_KEY }
            }
          );
          const price = cmcData.data.BTC.quote.USD.price;
          if (redisClient) {
            try {
              await redisClient.setEx('bitcoin_price', 300, price.toString());
            } catch (redisError) {
              console.error('Redis set error:', redisError.message);
            }
          }
          return res.json({ price });
        } catch (cmcError) {
          console.error('CoinMarketCap error:', cmcError.message);
        }
      }

      // Use hardcoded fallback price
      return res.json({ price: fallbackPrice });
    }
  } catch (error) {
    console.error('Lỗi khi lấy giá Bitcoin:', error.message);
    res.status(500).json({ price: fallbackPrice, warning: 'Không thể lấy giá Bitcoin từ API' });
  }
});

app.get('/api/bitcoin-history', async (req, res) => {
  try {
    if (redisClient) {
      const cachedHistory = await redisClient.get('bitcoin_history');
      if (cachedHistory) return res.json(JSON.parse(cachedHistory));
    }

    const data = await fetchWithRetry('https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=7');
    const prices = data.prices.map(([timestamp, price]) => ({
      date: new Date(timestamp).toISOString().split('T')[0],
      price,
    }));
    if (redisClient) {
      await redisClient.setEx('bitcoin_history', 300, JSON.stringify(prices));
    }
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

app.get('/api/ping', (req, res) => res.json({ status: 'ok' }));

// Khởi động server
app.listen(port, () => console.log(`Server chạy trên cổng ${port}`));