const redis = require('redis');

let redisClient;

const connectRedis = async () => {
    try {
        redisClient = redis.createClient({
            url: process.env.REDIS_URL || 'redis://localhost:6379',
        });
        redisClient.on('error', (err) => console.error('Lỗi Redis:', err));
        await redisClient.connect();
        console.log('Đã kết nối Redis');
        return redisClient;
    } catch (error) {
        console.error('Không thể kết nối Redis:', error);
        redisClient = null;
        return null;
    }
};

const getRedisClient = () => redisClient;

module.exports = { connectRedis, getRedisClient };
