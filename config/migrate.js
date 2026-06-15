const User = require('../models/User');
const Expense = require('../models/Expense');

const parseTransactionDate = (dateStr) => {
    if (!dateStr) return new Date();
    if (dateStr.includes('-') || dateStr.includes('T')) {
        const d = new Date(dateStr);
        if (!isNaN(d.getTime())) return d;
    }
    if (dateStr.includes('/')) {
        const parts = dateStr.trim().split(/[\s,]+/);
        const dateParts = parts[0].split('/');
        if (dateParts.length === 3) {
            const day = parseInt(dateParts[0], 10);
            const month = parseInt(dateParts[1], 10) - 1;
            const year = parseInt(dateParts[2], 10);
            let hour = 0, minute = 0, second = 0;
            if (parts[1]) {
                const timeParts = parts[1].split(':');
                hour = parseInt(timeParts[0], 10) || 0;
                minute = parseInt(timeParts[1], 10) || 0;
                second = parseInt(timeParts[2], 10) || 0;
            }
            const d = new Date(year, month, day, hour, minute, second);
            if (!isNaN(d.getTime())) return d;
        }
    }
    const d = new Date(dateStr);
    return isNaN(d.getTime()) ? new Date() : d;
};

const migrateEmbeddedExpenses = async () => {
    try {
        console.log('Bắt đầu kiểm tra và di chuyển dữ liệu chi tiêu...');
        
        // Find users that have at least one embedded expense
        const users = await User.find({ "expenses.0": { $exists: true } });
        
        if (users.length === 0) {
            console.log('Không có dữ liệu chi tiêu cũ cần di chuyển.');
            return;
        }

        console.log(`Tìm thấy ${users.length} người dùng cần di chuyển dữ liệu chi tiêu.`);
        
        for (const user of users) {
            if (user.expenses && user.expenses.length > 0) {
                console.log(`Đang di chuyển ${user.expenses.length} giao dịch cho người dùng: ${user.username}...`);
                
                const newExpenses = user.expenses.map(e => ({
                    userId: user._id,
                    amount: e.amount || 0,
                    category: e.category || 'essentials',
                    date: e.date || new Date().toLocaleDateString('vi-VN'),
                    timestamp: parseTransactionDate(e.date),
                    purpose: e.purpose || '-',
                    location: e.location || '-'
                }));
                
                // Batch insert into the new Expense collection
                await Expense.insertMany(newExpenses);
                
                // Clear the embedded expenses array in User
                user.expenses = [];
                await user.save();
                
                console.log(`Di chuyển thành công giao dịch của người dùng: ${user.username}.`);
            }
        }
        
        console.log('Hoàn tất di chuyển dữ liệu chi tiêu!');
    } catch (error) {
        console.error('Lỗi trong quá trình di chuyển dữ liệu:', error);
    }
};

module.exports = migrateEmbeddedExpenses;
