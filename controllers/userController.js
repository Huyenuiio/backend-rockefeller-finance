const User = require('../models/User');
const Expense = require('../models/Expense');
const mongoose = require('mongoose');
const { validationResult } = require('express-validator');

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
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 15;
        const search = req.query.search || '';
        const category = req.query.category || '';
        const startDate = req.query.startDate || '';
        const endDate = req.query.endDate || '';
        const minAmount = parseFloat(req.query.minAmount);
        const maxAmount = parseFloat(req.query.maxAmount);

        // Build search query
        let query = { userId: req.user.id };

        if (search) {
            query.$or = [
                { purpose: { $regex: search, $options: 'i' } },
                { location: { $regex: search, $options: 'i' } }
            ];
        }
        if (category) {
            query.category = category;
        }
        if (startDate || endDate) {
            query.timestamp = {};
            if (startDate) {
                query.timestamp.$gte = new Date(startDate);
            }
            if (endDate) {
                const endD = new Date(endDate);
                endD.setHours(23, 59, 59, 999);
                query.timestamp.$lte = endD;
            }
        }
        if (!isNaN(minAmount) || !isNaN(maxAmount)) {
            query.amount = {};
            if (!isNaN(minAmount)) {
                query.amount.$gte = minAmount;
            }
            if (!isNaN(maxAmount)) {
                query.amount.$lte = maxAmount;
            }
        }

        // Fetch total documents and matching records
        const total = await Expense.countDocuments(query);
        const expenses = await Expense.find(query)
            .sort({ timestamp: -1, _id: -1 })
            .skip((page - 1) * limit)
            .limit(limit)
            .lean();

        // Conditional response for backward compatibility (e.g. if page/limit are not passed, return all)
        if (!req.query.page && !req.query.limit) {
            const allExpenses = await Expense.find({ userId: req.user.id })
                .sort({ timestamp: -1, _id: -1 })
                .lean();
            return res.json(allExpenses);
        }

        const totalPages = Math.ceil(total / limit) || 1;

        res.json({
            expenses,
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
        const validCategories = ['essentials', 'savings', 'selfInvestment', 'charity', 'emergency'];

        if (!validCategories.includes(category)) {
            return res.status(400).json({ error: 'Danh mục không hợp lệ' });
        }
        const categoryKey = category;
        if (amount > user.allocations[categoryKey]) {
            return res.status(400).json({ error: `Số tiền vượt quá ngân sách ${category} (${user.allocations[categoryKey]} VND)` });
        }

        const newExpense = new Expense({
            userId: req.user.id,
            amount,
            category,
            purpose,
            location,
            date: date || new Date().toLocaleDateString('vi-VN')
        });
        await newExpense.save();

        user.initialBudget -= amount;
        user.allocations[categoryKey] -= amount;
        await user.save();

        const allExpenses = await Expense.find({ userId: req.user.id })
            .sort({ timestamp: -1, _id: -1 })
            .lean();
        res.json(allExpenses);
    } catch (error) {
        console.error('Lỗi thêm chi tiêu:', error);
        res.status(500).json({ error: 'Lỗi server' });
    }
};

exports.deleteExpense = async (req, res) => {
    try {
        const user = await User.findById(req.user.id);
        const paramId = req.params.index;
        
        let deletedExpense = null;
        
        // Try to find by ObjectID first
        if (mongoose.Types.ObjectId.isValid(paramId)) {
            deletedExpense = await Expense.findOne({ _id: paramId, userId: req.user.id });
        }
        
        // If not found by ObjectID, check if it is a numeric index
        if (!deletedExpense) {
            const parsedIndex = parseInt(paramId);
            if (!isNaN(parsedIndex) && parsedIndex >= 0) {
                // Fetch user's expenses sorted oldest to newest (ascending)
                const userExpenses = await Expense.find({ userId: req.user.id }).sort({ timestamp: 1, _id: 1 });
                if (parsedIndex < userExpenses.length) {
                    deletedExpense = userExpenses[parsedIndex];
                }
            }
        }
        
        if (!deletedExpense) {
            return res.status(400).json({ error: 'Giao dịch không tồn tại hoặc chỉ số không hợp lệ' });
        }
        
        const categoryKey = deletedExpense.category;
        
        // Refund budget and allocations
        user.initialBudget += deletedExpense.amount;
        if (categoryKey && user.allocations[categoryKey] !== undefined) {
            user.allocations[categoryKey] += deletedExpense.amount;
        }
        
        // Remove from DB
        await Expense.findByIdAndDelete(deletedExpense._id);
        await user.save();
        
        const allExpenses = await Expense.find({ userId: req.user.id })
            .sort({ timestamp: -1, _id: -1 })
            .lean();
        res.json(allExpenses);
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
        await Promise.all([
            User.findByIdAndDelete(req.user.id),
            Expense.deleteMany({ userId: req.user.id })
        ]);
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

exports.bulkAddExpenses = async (req, res) => {
    try {
        const user = await User.findById(req.user.id);
        const { expenses } = req.body;
        if (!Array.isArray(expenses)) {
            return res.status(400).json({ error: 'Dữ liệu không hợp lệ' });
        }
        const validCategories = ['essentials', 'savings', 'selfInvestment', 'charity', 'emergency'];
        const newExpenses = [];
        
        for (const exp of expenses) {
            const { amount, category, purpose, location, date } = exp;
            const parsedAmount = parseFloat(amount);
            if (isNaN(parsedAmount) || parsedAmount < 0) continue;
            if (!validCategories.includes(category)) continue;

            newExpenses.push({
                userId: req.user.id,
                amount: parsedAmount,
                category,
                purpose: purpose || '',
                location: location || '',
                date: date || new Date().toLocaleDateString('vi-VN')
            });
            user.initialBudget -= parsedAmount;
            user.allocations[category] -= parsedAmount;
        }
        
        if (newExpenses.length > 0) {
            await Expense.insertMany(newExpenses);
        }
        await user.save();
        
        const allExpenses = await Expense.find({ userId: req.user.id })
            .sort({ timestamp: -1, _id: -1 })
            .lean();
        res.json(allExpenses);
    } catch (error) {
        console.error('Lỗi nhập dữ liệu chi tiêu hàng loạt:', error);
        res.status(500).json({ error: 'Lỗi server' });
    }
};
