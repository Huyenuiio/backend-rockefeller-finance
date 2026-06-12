const User = require('../models/User');
const { validationResult } = require('express-validator');

exports.getInitialBudget = async (req, res) => {
    try {
        const user = await User.findById(req.user.id);
        res.json({ initialBudget: user.initialBudget });
    } catch (error) {
        console.error('Lỗi lấy ngân sách ban đầu:', error);
        res.status(500).json({ error: 'Lỗi server' });
    }
};

exports.updateInitialBudget = async (req, res) => {
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
};

exports.getExpenses = async (req, res) => {
    try {
        const user = await User.findById(req.user.id);
        if (!user) return res.status(404).json({ error: 'Người dùng không tìm thấy' });

        let expenses = [...user.expenses].reverse();

        // Filtering & Pagination
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || expenses.length; // Default to all if not specified for backward compatibility
        const search = req.query.search || '';
        const category = req.query.category || '';

        if (search) {
            expenses = expenses.filter(e =>
                (e.purpose && e.purpose.toLowerCase().includes(search.toLowerCase())) ||
                (e.location && e.location.toLowerCase().includes(search.toLowerCase()))
            );
        }
        if (category) {
            expenses = expenses.filter(e => e.category === category);
        }

        const total = expenses.length;
        const totalPages = Math.ceil(total / limit) || 1;
        const startIndex = (page - 1) * limit;
        const paginatedExpenses = expenses.slice(startIndex, startIndex + limit);

        // Conditional response for backward compatibility
        if (!req.query.page && !req.query.limit) {
            return res.json(expenses); // Return full array if no pagination params
        }

        res.json({
            expenses: paginatedExpenses,
            total,
            totalPages,
            currentPage: page
        });
    } catch (error) {
        console.error('Lỗi lấy chi tiêu:', error);
        res.status(500).json({ error: 'Lỗi server' });
    }
};

exports.addExpense = async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    try {
        const user = await User.findById(req.user.id);
        const { amount, category, purpose, location, date } = req.body;
        // category expected as key: essentials, savings, selfInvestment, charity, emergency
        const validCategories = ['essentials', 'savings', 'selfInvestment', 'charity', 'emergency'];

        if (!validCategories.includes(category)) {
            return res.status(400).json({ error: 'Danh mục không hợp lệ' });
        }
        const categoryKey = category;
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
};

exports.deleteExpense = async (req, res) => {
    try {
        const user = await User.findById(req.user.id);
        const index = parseInt(req.params.index);
        if (index < 0 || index >= user.expenses.length) {
            return res.status(400).json({ error: 'Chỉ số chi tiêu không hợp lệ' });
        }
        const deletedExpense = user.expenses[index];
        const categoryKey = deletedExpense.category;
        user.initialBudget += deletedExpense.amount;
        user.allocations[categoryKey] += deletedExpense.amount;
        user.expenses.splice(index, 1);
        await user.save();
        res.json(user.expenses);
    } catch (error) {
        console.error('Lỗi xóa chi tiêu:', error);
        res.status(500).json({ error: 'Lỗi server' });
    }
};

exports.getAllocations = async (req, res) => {
    try {
        const user = await User.findById(req.user.id);
        res.json(user.allocations);
    } catch (error) {
        console.error('Lỗi lấy phân bổ:', error);
        res.status(500).json({ error: 'Lỗi server' });
    }
};

exports.updateAllocations = async (req, res) => {
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
};

exports.deleteAccount = async (req, res) => {
    try {
        await User.findByIdAndDelete(req.user.id);
        res.json({ message: 'Tài khoản đã được xóa' });
    } catch (error) {
        console.error('Lỗi xóa tài khoản:', error);
        res.status(500).json({ error: 'Lỗi server' });
    }
};

exports.resetBudget = async (req, res) => {
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
        await user.save();
        res.json({ message: 'Ngân sách đã được đặt lại' });
    } catch (error) {
        console.error('Lỗi đặt lại ngân sách:', error);
        res.status(500).json({ error: 'Lỗi server' });
    }
};

exports.getInvestments = async (req, res) => {
    try {
        const user = await User.findById(req.user.id);
        res.json(user.investmentHistory);
    } catch (error) {
        console.error('Lỗi lấy đầu tư:', error);
        res.status(500).json({ error: 'Lỗi server' });
    }
};

exports.addInvestment = async (req, res) => {
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
        if (totalPortfolio > 0 && amount / totalPortfolio > 0.1) {
            return res.status(400).json({ warning: 'Cảnh báo: Đầu tư Bitcoin ETF nên chiếm dưới 10% tổng danh mục' });
        }

        const newInvestment = {
            amount,
            date: new Date().toLocaleDateString('vi-VN'),
            price,
            type
        };
        user.investmentHistory.push(newInvestment);
        await user.save();
        res.json(user.investmentHistory);
    } catch (error) {
        console.error('Lỗi thêm đầu tư:', error);
        res.status(500).json({ error: 'Lỗi server' });
    }
};

exports.deleteInvestment = async (req, res) => {
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
};
