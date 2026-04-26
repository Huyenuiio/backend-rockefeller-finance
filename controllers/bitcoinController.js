const axios = require('axios');
const { getRedisClient } = require('../config/redis');

// Helper
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

exports.getBitcoinPrice = async (req, res) => {
    const redisClient = getRedisClient();
    try {
        if (redisClient) {
            const cachedPrice = await redisClient.get('bitcoin_price');
            if (cachedPrice) return res.json({ price: parseFloat(cachedPrice) });
        }

        const data = await fetchWithRetry('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd');
        const price = data.bitcoin.usd;
        if (redisClient) {
            await redisClient.setEx('bitcoin_price', 300, price.toString());
        }
        res.json({ price });
    } catch (error) {
        console.error('Lỗi khi lấy giá Bitcoin:', error);
        res.status(500).json({ error: 'Không thể lấy giá Bitcoin', fallbackPrice: 117783.89 });
    }
};

exports.getBitcoinHistory = async (req, res) => {
    const redisClient = getRedisClient();
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
};
