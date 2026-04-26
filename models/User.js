const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    email: { type: String, unique: true, sparse: true },
    password: { type: String, required: function () { return !this.googleId; } }, // Only required if no Google ID
    googleId: { type: String, unique: true, sparse: true },
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

module.exports = mongoose.model('User', userSchema);
