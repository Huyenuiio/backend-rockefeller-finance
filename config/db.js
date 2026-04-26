const mongoose = require('mongoose');

const connectDB = async () => {
    try {
        const options = {
            serverApi: {
                version: '1',
                strict: true,
                deprecationErrors: true,
            }
        };
        const conn = await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost/rockefeller-finance', options);
        console.log(`Kết nối MongoDB thành công: ${conn.connection.host}`);
    } catch (error) {
        console.error(`Lỗi kết nối MongoDB: ${error.message}`);
        if (error.message.includes('ETIMEOUT') || error.message.includes('ENOTFOUND')) {
            console.error('Gợi ý: Hãy kiểm tra lại whitelist IP (0.0.0.0/0) hoặc thử đổi sang mạng khác.');
        }
        // process.exit(1); // Để server vẫn sống để debug
    }
};

module.exports = connectDB;
