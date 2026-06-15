const mongoose = require('mongoose');

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

const expenseSchema = new mongoose.Schema({
    userId: { 
        type: mongoose.Schema.Types.ObjectId, 
        ref: 'User', 
        required: true,
        index: true 
    },
    amount: { 
        type: Number, 
        required: true 
    },
    category: { 
        type: String, 
        required: true 
    },
    date: { 
        type: String, 
        default: () => new Date().toLocaleDateString('vi-VN')
    },
    timestamp: {
        type: Date,
        index: true
    },
    purpose: { 
        type: String, 
        default: '-' 
    },
    location: { 
        type: String, 
        default: '-' 
    },
});

// Pre-save middleware to keep timestamp in sync with date string
expenseSchema.pre('save', function(next) {
    if (this.isModified('date') || !this.timestamp) {
        this.timestamp = parseTransactionDate(this.date);
    }
    next();
});

// Compound index for optimized querying & sorting
expenseSchema.index({ userId: 1, timestamp: -1, _id: -1 });

module.exports = mongoose.model('Expense', expenseSchema);
